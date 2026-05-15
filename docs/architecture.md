# pi-digby Architecture

This document describes the current runtime model. It is intentionally narrower than
`docs/harness-v2.md`, which records the original harness redesign.

## Runtime Shape

pi-digby is a single Node process that connects to Slack over Socket Mode, accepts
optional Linear webhooks, and runs agent sessions backed by persistent files under
the configured working directory.

The major boundaries are:

- `src/slack/router.ts`: classifies Slack events, deduplicates Slack retries, and
  routes triggering messages, stop commands, and passive log-only messages.
- `src/main.ts`: owns runtime coordination, channel state, lanes, queues, event
  watcher wiring, and Linear wiring.
- `src/agent/setup.ts`: creates cached `ChannelRunner` instances, `AgentSession`
  objects, `SessionManager` JSONL persistence, tools, model config, and MCP runtime.
- `src/persistence/log.ts`: selects visible records from `log.jsonl` and syncs
  them into an agent session.
- `src/channel/state.ts`: owns append-only channel `log.jsonl` writes.

## Channels, Lanes, and Sessions

Each physical Slack channel has one `ChannelState` and one authoritative
`log.jsonl`. Linear agent sessions use the same state machinery, keyed by their
synthetic `linear:<sessionId>` channel id.

Runtime work is divided into lanes:

- top-level channel work: `slack:<channel>:channel`
- Slack thread work: `slack:<channel>:thread:<rootTs>`
- Linear agent sessions: `linear:<sessionId>`

Each lane has its own FIFO queue, follow-up queue, running flag, stop state, and
active runner reference. Different lanes can run concurrently. Work inside a
single lane remains serialized, and messages that arrive while that lane is
actively running are batched into a follow-up completion when possible.

Slack thread lanes use separate agent session directories so each thread can keep
its own `context.jsonl` and tool/session state. They do not own message history.

## Message History vs Agent Context

There are two persistence layers, and they have different jobs.

`log.jsonl` is durable message history:

- one file per Slack channel
- append-only
- contains user messages and final bot responses
- does not contain tool calls or tool results
- includes `threadTs` on Slack thread replies

`context.jsonl` is durable LLM session state:

- one file per agent session
- maintained by `SessionManager` and `AgentSession`
- contains synced log snippets, user prompts, assistant messages, and tool/result
  history
- exists separately for Slack thread sessions under `threads/<threadTs>/`

The normal Slack thread flow is:

1. append real Slack messages to the channel `log.jsonl`
2. choose the lane/session for the incoming event
3. open that lane's `context.jsonl`
4. read the channel `log.jsonl`
5. select only the records visible to this channel/thread scope
6. append missing selected records into `context.jsonl`
7. run the agent
8. append the final bot response back to the channel `log.jsonl`

The important invariant is that Slack thread context is filtered from the channel
log. `threads/` stores per-thread agent session state, not separate message
history.

Example channel log records:

```jsonl
{"ts":"100.000000","userName":"amy","text":"channel topic","isBot":false}
{"ts":"110.000000","threadTs":"100.000000","userName":"sam","text":"thread reply","isBot":false}
{"ts":"111.000000","threadTs":"100.000000","user":"bot","text":"thread answer","isBot":true}
{"ts":"120.000000","userName":"zoe","text":"new top-level message","isBot":false}
```

For a thread rooted at `100.000000`, the selector sees pre-root channel context,
the root, and replies whose `threadTs` is `100.000000`. It does not see unrelated
thread replies or later top-level channel messages.

## Stop and Busy Routing

Slack routing is lane-aware:

- busy checks are based on the incoming event's lane
- a stop command in a Slack thread targets that thread lane
- a top-level stop command targets the top-level channel lane
- other lanes in the same Slack channel continue running

If a stop arrives while a lane is starting but before its runner exists, the lane
keeps `stopRequested = true`; once the runner is created, it is aborted before
the prompt is run.

## Scheduled Events

Scheduled events are files in `<workingDir>/events/`. By default, Slack events
target the top-level channel lane. If an event includes `threadTs`, it targets the
corresponding Slack thread lane.

Immediate and one-shot event files are deleted after the watcher attempts to
trigger them. Periodic events remain until deleted.

# Cross-channel handoff via immediate events

## Problem

Each channel runs its own digby agent with its own `ChannelState` (log, context,
memory). Today there's no way for one channel's agent to involve another
channel's agent in its work. Concretely: a Linear session agent working on an
issue might realize it needs Tom's input, but it has no way to reach Tom's
Slack DM. Same in reverse: a Slack DM agent can't pull a Linear session into
the loop.

## Idea

Rather than build a notification tool or a cross-surface routing layer, reuse
the existing events mechanism as a cross-channel delegation primitive. "Drop a
line in another channel" — fire-and-forget, no correlation, no reply routing.

The mental model is an explicit handover: _"I am not the right agent for this,
you are."_ Not a conversation bridge, not a way to ask a question and wait for
an answer — just a one-way ping that wakes the target channel's agent with
enough context to take over.

## Why this works for free

The mechanism already exists end-to-end:

- `src/events/watcher.ts` dispatches event files to any `channelId` named in
  the JSON. There's no check that the writer and the target match.
- `{workingDir}/events/` is a single global directory. Every running agent
  can write there via `bash`, because the tool runs under `setsid` with the
  full process environment.
- `src/main.ts:264` enqueues the synthetic mention into the target channel's
  queue exactly the same way as a Slack mention. The receiver loads its
  own `ChannelState` from EFS, so it has full prior context for _its_
  channel, and no inherited context from the sender.

So the code is done. What's missing is the agent knowing this is possible
and the convention for using it well.

## Which event type

Use **`immediate`**, not `one-shot`.

- `immediate` fires as soon as the watcher sees the file. Its prompt doc
  already says _"Use in scripts/webhooks to signal external events"_, which
  is exactly what a cross-channel handoff is.
- `one-shot` with `at = now` gets silently **discarded as stale** by
  `src/events/watcher.ts:271` (`if (atMs <= now) { delete and skip }`). It's
  designed for future-scheduled reminders, not immediate delivery.
- The `immediate` stale-check only skips files whose mtime predates the bot's
  startup — a freshly-written event from a live agent always fires.

## The handoff convention

Three rules, enforced by prompt rather than code:

1. **The sender includes its own `channelId` in the event text.** That's the
   _only_ mechanism for callback — no correlation table, no reply tokens.
   The receiver decides whether to call back, and if so, writes another
   immediate event targeting the sender's channelId. Most of the time the
   right move is _not_ to call back; the sender's run has already ended and
   said its piece.

2. **The sender makes the handoff visible on its own side.** Its final
   response in the originating channel should say something like
   _"I've pinged Tom in Slack — they'll follow up there."_ This gives the
   human reading the originating channel a clear trail, and gives the
   receiving agent clear standing to act.

3. **The receiver does _not_ auto-reply.** Don't ping the sender just to
   acknowledge. Handoffs go forward, not in circles. If the task is now
   Tom's, the Slack DM agent handles it with Tom directly.

## Channel ID formats

The prompt currently only ever shows the agent's own `channelId`. It needs
to document the full set so agents can target others:

- Slack channel: `C0123ABCDEF` (from `getAllChannels()`)
- Slack DM: `D0123ABCDEF` (from `getAllUsers()` → open DM, or from the
  channel list if already opened)
- Linear session: `linear:<sessionId>` (the session UUID Linear sent in
  the webhook)

## Required code changes

Almost nothing.

1. **`src/main.ts:318`** — the Linear runner is called with empty channel
   and user lists:
   ```ts
   runner.run(ctx, event, state.channelState, [], [], undefined, stats);
   ```
   The Slack path passes real lists at `:142-144`. Without this fix, a
   Linear session has no way to look up Tom's Slack ID and can't construct
   a meaningful target `channelId`. One-line change to pass
   `client.getAllChannels()` and `client.getAllUsers()` mapped the same
   way.

2. **`src/agent/prompt.ts`** — extend the Events section with a new
   "Cross-channel handoff" subsection covering:
   - The handoff pattern and when to use it (vs. handling the task
     yourself)
   - Channel ID formats (above)
   - The three convention rules (above)
   - One worked example: Linear session → Slack DM
   - Explicit "do not delegate just to avoid work" rule

No new tools, no new event types, no new infrastructure.

## Loop safety

An agent pinging back and forth with another channel could runaway. Two
defenses:

- **Hard cap:** The per-channel queue drops events past size 5
  (`src/main.ts:274`). Won't prevent ping-pong, but bounds it.
- **Soft rule in prompt:** "Handoffs go forward, not in circles." If this
  proves insufficient in practice, the next intervention is tracking
  delegation depth in the event text (`[EVENT depth=2]`). Don't build
  until it's actually a problem.

## Scope safety

No permission system. A Linear comment comes from anyone on the team, so
in principle a poorly-phrased ticket could cause digby to ping Slack users
it shouldn't. For v1 this is a prompt-discipline issue: "only delegate to
channels/users when there's a clear reason and the human would expect it."
If abuse happens, the natural next step is a config allowlist of valid
delegation targets per-source-channel.

## Alternatives considered

- **Dedicated `notify` tool.** Simpler per-call but the wrong shape — it
  creates the illusion of "just sending a message" rather than "handing
  off a task," which is what we actually want. Also adds a tool to
  maintain and duplicates the dispatch path.
- **Bidirectional correlation** (sender pauses, waits for a reply,
  resumes). Much more complex: needs session state beyond what Linear's
  `awaitingInput` gives us, needs a reply-token convention, needs to
  handle timeouts. Defer until actual usage demands it.
- **Cross-surface fan-out** (one agent emits into multiple surfaces
  simultaneously). Overkill and muddles the "who owns this conversation"
  question.

## Status

Idea only. Not implemented. Mechanism verified to work.

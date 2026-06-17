# Slack Agents Interaction Surface

**Branch:** `feat/slack-agents-surface`  
**Status:** Design / RFC  
**Author:** Digby  
**Date:** 2026-06-17

---

## Summary

Implement Slack's first-class [Agents & AI Apps](https://docs.slack.dev/ai/agent-entry-and-interaction) features in pi-digby, starting with the interaction improvements that work today without any scope changes, and extending into the full agent container once the `assistant:write` scope is added.

The primary user-facing wins are:
1. **Native loading indicator** (`assistant.threads.setStatus`) — shows "_Digby is thinking..._" in the thread header instead of a placeholder chat message
2. **Proper completion notifications** — users get a real Slack notification when the answer arrives, not just when the thinking placeholder is posted
3. **Block Kit task cards** — structured, visually-scannable tool step tracking instead of flat `→ tool-name` text
4. **Suggested prompts** (requires `assistant:write` scope) — context-aware tap-to-use prompts when a thread opens
5. **Thread titles** (requires `assistant:write` scope) — thread is labelled by its first message in the History tab

---

## Background

Currently `SlackSurface` works entirely through chat message updates:

1. `emitThinking()` → posts `"🤔 _Thinking_"` as a new message
2. `emitProgress(text)` → overwrites that message with accumulated `→ tool-name` lines
3. `emitResponse(text)` → overwrites again with the final answer
4. `resolve()` → one final update to add cost footer

Problems:
- Slack only notifies on _new_ messages, not updates. So users are notified when the "Thinking" placeholder appears, but _not_ when the actual answer arrives.
- Tool steps are flat text — hard to scan, no visual hierarchy, no done/in-progress state.
- No use of Slack's native AI loading indicator (the animated "is thinking..." thread header), which is what users expect from AI apps.

---

## SDK & Scope Status

`@slack/web-api ^7.0.0` already exposes:
```
client.assistant.threads.setStatus(...)
client.assistant.threads.setSuggestedPrompts(...)
client.assistant.threads.setTitle(...)
```
No package upgrade needed.

| Feature | Scope needed | We have it? |
|---|---|---|
| `setStatus` | `chat:write` | Yes |
| `setSuggestedPrompts` | `assistant:write` | No — needs app reinstall |
| `setTitle` | `assistant:write` | No — needs app reinstall |
| Agent Container (split pane) | `assistant:write` + app setting | No |

The `setStatus` API (our biggest win) is available immediately.

---

## Phase 1: `setStatus` + Completion Notifications

### Goal
- Show native Slack AI loading indicator during runs on threads
- Deliver completion notification to user when the answer is ready

### `setStatus` behaviour
- Displays as "_Digby is thinking..._" in the thread header (not a chat message)
- Accepts `loading_messages: string[]` — up to 10 strings, Slack rotates through them
- Auto-clears when any message is posted in that thread
- Rate limit: special per-team limit, effectively not a concern at our scale
- Requires `channel_id` + `thread_ts` — no-op for top-level channel messages

### Completion notification problem

When a message is _updated_ via `chat.update`, Slack does not re-notify the user. Our current flow updates the thinking placeholder to become the final answer — so the notification fires on "Thinking", not on the answer.

**Fix for threaded responses:** decouple thinking state from the response message.

New flow for threaded runs (`replyThreadTs` is set):
1. `emitThinking()` → call `setStatus("is thinking...", loadingMessages)`, do _not_ post a placeholder message
2. `emitProgress(text)` → update the Block Kit task card (see Phase 2), or for Phase 1 just accumulate text silently (or post ephemeral tool lines to a detail sub-thread)
3. `emitResponse(text)` → post the final answer as a NEW message (triggers notification, status auto-clears)
4. `resolve()` → update the just-posted message to add cost footer; status is already cleared

For top-level channel messages (no `replyThreadTs`), keep existing behaviour — we can't call `setStatus` without a `thread_ts`.

### Changes

**`src/slack/client.ts`** — add method:
```ts
async setThreadStatus(
  channel: string,
  threadTs: string,
  status: string,
  loadingMessages?: string[]
): Promise<void>
```

**`src/surface/slack.ts`** — add field `useStatusApi: boolean` (true when `replyThreadTs` is set):
- `emitThinking()`: if `useStatusApi`, call `setThreadStatus` instead of posting placeholder
- `emitResponse()`: if `useStatusApi`, always post a _new_ message (not update existing)
- The `MessageTransport` interface needs a `setThreadStatus` method added

**`src/surface/types.ts`** — extend `MessageTransport` interface (or keep as optional)

**`src/main.ts`** — pass `setThreadStatus` capability through to surface constructor (already has `replyThreadTs`, so no structural change needed)

---

## Phase 2: Block Kit Task Cards

### Goal
Replace the flat `→ tool-name` progress text with a structured Block Kit card that shows tool steps with done/in-progress/pending state.

### Design

The thinking placeholder becomes a Block Kit message. Structure:

```
┌──────────────────────────────────────────────┐
│  🤔 Working on it...                          │
├──────────────────────────────────────────────┤
│  ✓  read /data/MEMORY.md               0.3s  │
│  ✓  bash: git log --oneline -10        0.8s  │
│  →  bash: checking Linear...          ....   │  ← current (bold/animated)
├──────────────────────────────────────────────┤
│  _2 steps · streaming_                        │
└──────────────────────────────────────────────┘
```

On completion, the card collapses to a single summary line and the response is posted below it (new message = notification).

### Block Kit structure

```json
{
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "🤔 *Working on it...*" }
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "✓ `read` /data/MEMORY.md  _0.3s_" },
        { "type": "mrkdwn", "text": "✓ `bash` git log --oneline  _0.8s_" },
        { "type": "mrkdwn", "text": "*→ `bash` checking Linear...*" }
      ]
    },
    { "type": "divider" },
    {
      "type": "context",
      "elements": [{ "type": "mrkdwn", "text": "_2 steps · streaming_" }]
    }
  ]
}
```

On completion, the task card collapses to a single context block:
```
✓  read, bash (×2), linear (×1)   3 steps · $0.04
```

### Changes

**`src/surface/slack.ts`** — new `TaskCard` class:
```ts
class TaskCard {
  private steps: TaskStep[] = [];
  private currentStep: TaskStep | null = null;
  
  stepStart(toolName: string, label: string): void
  stepEnd(toolCallId: string, durationMs: number, isError: boolean): void
  toBlocks(streaming: boolean, stats: RunStats): KnownBlock[]
  toSummaryBlocks(stats: RunStats): KnownBlock[]
}
```

`SlackSurface` holds a `TaskCard` instance. Instead of calling `enqueuePostOrUpdate(text)` on every tool step, it calls `enqueuePostOrUpdate({ blocks: taskCard.toBlocks(...) })`.

**`src/slack/client.ts`** — `postMessage` and `updateMessage` need to accept `blocks` payload:
```ts
async postMessage(channel: string, textOrBlocks: string | BlockPayload, threadTs?: string): Promise<string>
async updateMessage(channel: string, ts: string, textOrBlocks: string | BlockPayload): Promise<void>
```

**`src/surface/types.ts`** — update `MessageTransport` interface.

Note: `fallback_text` must always be set on Block Kit messages for notifications and accessibility.

---

## Phase 3: `assistant:write` Scope Features

_Requires Tom to: api.slack.com/apps → Digby → Features → enable "Agents & AI Apps" → add `assistant:write` to Bot Token Scopes → reinstall to workspace._

### Suggested prompts
On `assistant_thread_started` event (or when a DM conversation begins), call `setSuggestedPrompts` with context-derived prompts:

```ts
await client.assistant.threads.setSuggestedPrompts({
  channel_id: event.channel,
  thread_ts: event.thread_ts,
  title: "What can I help with?",
  prompts: [
    { title: "Linear cycle report", message: "Give me a summary of the current Linear cycle" },
    { title: "Check errors", message: "Any new errors in #errors in the last 24h?" },
    { title: "Draft a Linear ticket", message: "Create a Linear ticket for: " },
  ]
});
```

These can be dynamically chosen based on channel context (e.g. different prompts in #product vs #errors).

### Thread titles
After the first user message, summarise it in ≤50 chars and call:
```ts
await client.assistant.threads.setTitle({
  channel_id: event.channel,
  thread_ts: event.thread_ts,
  title: summarisedTitle,
});
```

This names the thread in the History tab for easy retrieval.

### Full Agent Container (split pane)
If appetite exists: implement `assistant_thread_started` / `assistant_thread_context_changed` / `message.im` event handlers using Bolt's `Assistant` class pattern. This unlocks the native AI panel in the Slack top bar. Likely a separate spike.

---

## Open questions

1. **Block Kit rate limits.** `chat.update` is Tier 3 (~50/min per channel). Our current flow calls update on every tool step. With Block Kit task cards, same rate applies. For rapid-fire tools (5+ per second), we may need to debounce updates. Add a minimum 500ms interval between Block Kit updates?

2. **Fallback for channels without `replyThreadTs`.** Phase 1 flow change (no placeholder, post fresh on completion) only applies when we have a `thread_ts` to call `setStatus` on. Top-level channel messages keep the current update-in-place flow. Is this acceptable, or do we want to _always_ post fresh (even in channels)?

3. **Backward compat: `MessageTransport` interface.** Several tests (if any) and the `LinearSurface` may depend on the interface shape. Adding optional `blocks` to `postMessage`/`updateMessage` is a non-breaking change if we use overloads or a union type.

4. **Scope change timing.** Phase 3 (suggested prompts, titles) requires `assistant:write` and a workspace reinstall. Do Phase 1+2 first and ship them, then do Phase 3 as a follow-up PR after the reinstall?

---

## Implementation order

```
Phase 1 (1–2 days):
  ├── src/slack/client.ts     — add setThreadStatus()
  ├── src/surface/slack.ts    — use setStatus in emitThinking(), post-new in emitResponse() for threads
  └── tests / manual QA in #digby-testing

Phase 2 (2–3 days):
  ├── src/surface/slack.ts    — TaskCard class, Block Kit payload generation
  ├── src/slack/client.ts     — blocks support in postMessage/updateMessage
  └── tests / visual QA

Phase 3 (after scope change, 1 day):
  ├── src/slack/router.ts (or new handler) — assistant_thread_started handler
  ├── src/slack/client.ts     — setSuggestedPrompts(), setTitle()
  └── docs update
```

---

## References

- [Slack: Interaction surfaces and entry points](https://docs.slack.dev/ai/agent-entry-and-interaction/)
- [API: assistant.threads.setStatus](https://api.slack.com/methods/assistant.threads.setStatus)
- [API: assistant.threads.setSuggestedPrompts](https://api.slack.com/methods/assistant.threads.setSuggestedPrompts)
- [API: assistant.threads.setTitle](https://api.slack.com/methods/assistant.threads.setTitle)
- [Block Kit reference](https://api.slack.com/block-kit)
- [Bolt JS: Assistant class](https://tools.slack.dev/bolt-js/reference/assistant/)
- Research thread: [#digby-testing 2026-06-17](https://brainwavesio.slack.com/archives/C0AB3CQSSSZ/p1781659818854589)

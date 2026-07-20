# Slack Agents Interaction Surface

**Branch:** `feat/slack-agents-surface`  
**Status:** Implementation in progress  
**Author:** Digby  
**Date:** 2026-06-17  
**Decisions locked:** 2026-06-17 (by Tom)

---

## Summary

Implement Slack's first-class [Agents & AI Apps](https://docs.slack.dev/ai/agent-entry-and-interaction) features in pi-digby. Full cut-over — all phases ship together on this branch, no backward compat shim needed.

The three changes land as one:
1. **`setStatus`** — native "_Digby is thinking..._" loading indicator in thread/DM header
2. **Block Kit task cards** — structured, visually-scannable tool step tracking
3. **`setSuggestedPrompts` + `setTitle`** — context-aware prompts and auto-titled threads (scope assumed present)

---

## Decisions (locked)

| # | Question | Decision |
|---|---|---|
| 1 | Block Kit update rate limits | Fine as-is, no debounce needed |
| 2 | Fresh post vs update-in-place | _Never_ post fresh. Always: setStatus → task card (update) → final answer (update). Everywhere, including top-level channel messages. |
| 3 | Backward compat on `MessageTransport` interface | Full cut-over. No compat shim. Delete old path. |
| 4 | Phased rollout | Ship all phases at once. Work carefully on branch, test, then cut over. |

---

## New interaction flow (everywhere — DMs, threads, channels)

```
1. Message arrives
2. setStatus("is thinking...", loadingMessages)   ← API call, no message posted yet
3. Post Block Kit task card (empty / "starting")  ← first message post
4. For each tool call:
     stepStart → update task card (new step highlighted as in-progress)
     stepEnd   → update task card (step marked done with duration)
5. emitResponse(text) → update task card: collapse steps to summary + show response text
6. resolve() → final update with cost footer
```

The Slack notification fires on step 3 (first post). `setStatus` shows the animated indicator immediately at step 2. `setStatus` auto-clears when the message is posted at step 3.

There is never a second "response" message. The task card message IS the response message — it evolves in place.

---

## API reference

### `assistant.threads.setStatus`
```
POST https://slack.com/api/assistant.threads.setStatus
Scope: chat:write (we have this)

{
  "channel_id": "C123...",
  "thread_ts": "1234567890.123456",   // required — use replyThreadTs or the message ts
  "status": "is thinking...",
  "loading_messages": [               // optional, up to 10, Slack rotates
    "is reading the context...",
    "is thinking...",
    "is working on it...",
    "is almost done..."
  ]
}
```
- Auto-clears when any message is posted in the thread
- Displays as "_AppName_ is thinking..." in the thread header
- For top-level channel messages: call with `thread_ts = the message ts we're about to post`... actually `setStatus` requires an existing thread. **See implementation note below.**

### `assistant.threads.setSuggestedPrompts`
```
POST https://slack.com/api/assistant.threads.setSuggestedPrompts
Scope: assistant:write (assumed present)

{
  "channel_id": "D123...",
  "thread_ts": "...",
  "title": "What can I help with?",
  "prompts": [
    { "title": "Linear cycle report", "message": "Give me a summary of the current Linear cycle" },
    { "title": "Check recent errors", "message": "Any new errors in the last 24h?" },
    { "title": "Draft a ticket", "message": "Create a Linear ticket for: " }
  ]
}
```

### `assistant.threads.setTitle`
```
POST https://slack.com/api/assistant.threads.setTitle
Scope: assistant:write (assumed present)

{
  "channel_id": "D123...",
  "thread_ts": "...",
  "title": "Linear cycle report - June 17"   // max ~50 chars
}
```

---

## Implementation note: `setStatus` requires `thread_ts`

`setStatus` needs a `thread_ts`. For threaded/DM responses this is `replyThreadTs`. For top-level channel posts we don't have a `thread_ts` until we post the message.

**Resolution:** For top-level channel messages, skip `setStatus` and post the Block Kit task card immediately. `setStatus` is called only when `replyThreadTs` is set. The Block Kit card still appears either way — it's just without the animated header indicator for top-level posts.

---

## Block Kit task card design

### While running

```json
{
  "text": "Digby is working on it...",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "🤔 *Working on it...*" }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "✓  `read` /data/MEMORY.md   _0.3s_" },
        { "type": "mrkdwn", "text": "✓  `bash` git log --oneline   _0.8s_" },
        { "type": "mrkdwn", "text": "*→  `bash` checking Linear...*" }
      ]
    },
    {
      "type": "context",
      "elements": [{ "type": "mrkdwn", "text": "_3 steps · streaming_" }]
    }
  ]
}
```

Rules:
- Completed steps: `✓  \`toolname\` label   _Xs_`
- Current step: `*→  \`toolname\` label*` (bold = in progress)
- Error step: `✗  \`toolname\` label   _error_`
- Max 10 steps visible; if more, show count: `... and 4 more`
- Context elements max 10 per block — split into multiple context blocks if needed

### After completion (response folded in)

```json
{
  "text": "<response text here>",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "<response text>" }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "✓  read, bash (×2), linear   _5 steps · $0.04_" }
      ]
    }
  ]
}
```

On resolve: collapse all step lines into a single summary context line. Response text goes in the top section block.

### Overflow (response > MAX_MESSAGE_LENGTH)

Same fallback as today: upload as file attachment, update message to `_Response too long — replying as a file attachment._`

---

## Code changes

### `src/slack/client.ts`

Add method:
```ts
async setThreadStatus(
  channel: string,
  threadTs: string,
  status: string,
  loadingMessages?: string[]
): Promise<void>
```

Update `postMessage` and `updateMessage` to accept blocks:
```ts
type MessagePayload = string | { text: string; blocks: KnownBlock[] };

async postMessage(channel: string, payload: MessagePayload, threadTs?: string): Promise<string>
async updateMessage(channel: string, ts: string, payload: MessagePayload): Promise<void>
```

Import `KnownBlock` from `@slack/web-api`.

### `src/surface/types.ts`

Update `MessageTransport` interface to match new `postMessage`/`updateMessage` signatures. Add `setThreadStatus`.

### `src/surface/slack.ts`

Replace the `emitProgress` text-accumulation model with a `TaskCard`:

```ts
class TaskCard {
  private steps: Array<{
    toolName: string;
    label: string;
    state: "running" | "done" | "error";
    durationMs?: number;
    toolCallId: string;
  }> = [];

  stepStart(toolCallId: string, toolName: string, label: string): void
  stepEnd(toolCallId: string, durationMs: number, isError: boolean): void
  toRunningBlocks(stats: RunStats): KnownBlock[]     // during run
  toResolvedBlocks(responseText: string, stats: RunStats): KnownBlock[]  // on resolve
}
```

`SlackSurface` changes:
- Constructor: `taskCard = new TaskCard()`
- `emitThinking()`:
  - If `replyThreadTs`: call `setThreadStatus(replyThreadTs, "is thinking...", loadingMessages)`
  - Post Block Kit task card (empty state: `"🤔 Working on it..."`, no steps yet)
- `emitProgress()`: *removed* (replaced by task card updates)
- `emitToolStart(toolCallId, toolName, label)`: new method — `taskCard.stepStart(...)`, update card
- `emitToolEnd(toolCallId, durationMs, isError)`: new method — `taskCard.stepEnd(...)`, update card
- `emitResponse(text)`: store response text, update card to resolved state (folds response + step summary)
- `resolve()`: final update (streaming=false, cost computed) — if response already shown, just adds cost to footer

The `AgentSurface` interface needs `emitToolStart`/`emitToolEnd` or the event handler (`agent/events.ts`) calls the new methods directly.

### `src/agent/events.ts`

In `tool_execution_start` handler: call `ctx.emitToolStart(toolCallId, toolName, label)` instead of `ctx.emitProgress(...)`.
In `tool_execution_end` handler: call `ctx.emitToolEnd(toolCallId, durationMs, isError)` instead of any progress update.
In `message_end` handler: call `ctx.emitResponse(text)` as today.

### `src/surface/types.ts` (AgentSurface interface)

```ts
export interface AgentSurface {
  emitThinking(): void;
  emitToolStart(toolCallId: string, toolName: string, label: string): void;  // new
  emitToolEnd(toolCallId: string, durationMs: number, isError: boolean): void;  // new
  emitResponse(text: string): void;
  emitDetail(text: string): void;
  emitReaction(emoji: string, triggerTs: string): void;
  emitFile(filePath: string, title?: string): void;
  resolve(): void;
  reject(error: string): void;
  suppress(): void;
  flush(): Promise<void>;
  dispose(): void;
  readonly finalMessageTs: string | null;
  readonly finalText: string;
  readonly wasDeleted: boolean;
}
```

Remove `emitProgress` from the interface (it was internal detail).

### `src/surface/linear.ts`

Update to implement new `AgentSurface` interface — `emitToolStart`/`emitToolEnd` can be no-ops or thin wrappers.

### `src/slack/router.ts` (Phase 3)

Add handler for `assistant_thread_started` event (fires when a DM or Agent Container thread opens):
```ts
client.onAssistantThreadStarted(async (event) => {
  await client.setSuggestedPrompts(event.channel, event.threadTs, suggestedPrompts(event));
});
```

After first user message response, call `setTitle` with a short summary of the user's message.

---

## Suggested prompts (Phase 3)

Default set (can be made context-aware later):
```ts
const DEFAULT_PROMPTS = [
  { title: "Linear cycle report", message: "Give me a summary of the current Linear cycle" },
  { title: "Recent errors", message: "Any new errors in #errors in the last 24h?" },
  { title: "Morning digest", message: "What's new since yesterday?" },
  { title: "Draft a ticket", message: "Create a Linear ticket for: " },
];
```

---

## Testing checklist

- [ ] DM conversation: setStatus shows, task card appears, steps accumulate, response folds in with cost
- [ ] Thread reply (bot mentioned): same flow
- [ ] Top-level channel message: no setStatus, task card appears immediately, steps work
- [ ] Long response: file fallback still works
- [ ] `[SILENT]` / suppress: card deleted cleanly
- [ ] Error mid-run: reject() shows error in card
- [ ] Stop command: card deleted, "Stopped" posted
- [ ] Linear surface: still works after interface change
- [ ] Suggested prompts: appear on DM open (Phase 3)
- [ ] Thread title: set after first response (Phase 3)

---

## References

- [Slack: Interaction surfaces and entry points](https://docs.slack.dev/ai/agent-entry-and-interaction/)
- [API: assistant.threads.setStatus](https://api.slack.com/methods/assistant.threads.setStatus)
- [API: assistant.threads.setSuggestedPrompts](https://api.slack.com/methods/assistant.threads.setSuggestedPrompts)
- [API: assistant.threads.setTitle](https://api.slack.com/methods/assistant.threads.setTitle)
- [Block Kit reference](https://api.slack.com/block-kit)
- Research thread: [#digby-testing 2026-06-17](https://brainwavesio.slack.com/archives/C0AB3CQSSSZ/p1781659818854589)

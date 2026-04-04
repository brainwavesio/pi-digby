# Multi-message responses (CHECKPOINT)

## Problem

Long-running tasks (e.g. booking Airbnb, multi-step research) accumulate progress updates in a single Slack message via `respond()`. When the assistant produces its final text, `replaceMessage()` overwrites everything — the user loses visibility of intermediate steps.

## Idea

Allow the agent to "finalize" the current message and start a new one mid-run. The agent signals this with a `[CHECKPOINT]` marker in its response text.

## How it would work

### Agent side

The agent writes a summary of work so far, ending with `[CHECKPOINT]`:

```
Here's what I found on Airbnb for those dates:
- Option A: $120/night, 4.8 stars, close to venue
- Option B: $95/night, 4.6 stars, 10 min walk

Booking Option A now.
[CHECKPOINT]
```

This becomes message #1 (finalized with footer). The agent continues working, and its next output becomes message #2.

### Harness side (RunContext)

Detect `[CHECKPOINT]` in `replaceMessage()` or `respond()`:

1. Split text at the marker
2. Finalize the current message (set streaming=false, append footer with cost so far)
3. Reset `messageTs` to null
4. Post the remainder (if any) as a new message in the same thread

Key: the `replyThreadTs` stays the same, so all messages stay in the thread.

### Events handler (events.ts)

In `message_end`, when `replaceMessage(text)` is called with text containing `[CHECKPOINT]`:
- Everything before the marker finalizes the current message
- Everything after starts a new message
- Multiple checkpoints in one response = multiple messages

## Alternatives considered

- **Dedicated tool**: Agent calls a `checkpoint` tool. More explicit but adds a tool call round-trip.
- **Thread-only**: Post progress in thread replies, final answer in main message. Already partially works with `debugThreading`, but thread replies are noisy and not the primary reading experience.
- **Time-based auto-split**: If a message hasn't been finalized in N seconds, auto-checkpoint. Too implicit — agent should control when to split.

## Status

Idea only. Not implemented.

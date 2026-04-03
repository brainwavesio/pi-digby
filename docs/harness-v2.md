# pi-digby v2: Harness Redesign

Purpose-built Slack bot harness replacing the forked pi-mom. Designed for reliability on AWS ECS Fargate with concurrent multi-channel operation.

## Why rewrite

pi-mom was built as a generic self-managing Slack bot framework. pi-digby uses ~2,000 LOC of upstream functionality but drags in ~64,000 LOC of dependencies (pi-agent-core, pi-coding-agent, pi-ai). The forked harness has structural reliability issues:

- **Single socket, all channels, no isolation** — one dropped connection silently kills all in-flight responses
- **No message delivery guarantees** — fire-and-forget Slack API calls, no retry, unhandled rejections
- **Manual `running` boolean** — no timeout, no heartbeat, no stuck-run detection
- **Silent failures** — errors swallowed in catch blocks, user sees "..." forever
- **Upstream API drift** — removed methods (`replaceMessages`, `setSystemPrompt`), renamed events (`auto_compaction_*` → `compaction_*`), unawaited event handlers causing races

The rewrite keeps what works (agent-core loop, Bedrock provider, JSONL persistence) and replaces the harness with one designed for our deployment.

## What we keep from upstream

| Package | What we use | Size used |
|---------|------------|-----------|
| `pi-agent-core` | `Agent` class — tool execution loop, event emission, abort | ~1,500 LOC (all of it) |
| `pi-ai` | `getModel()` + Bedrock streaming provider | ~200 LOC of ~24,000 |
| `pi-coding-agent` | `SessionManager` (JSONL context), `AgentSession` (prompt/compaction), `convertToLlm` | ~500 LOC of ~38,000 |

We upgrade to latest upstream to get critical fixes (awaited event handlers, Bedrock throttling detection, compaction event unification).

## What we drop / replace

| Component | Action | Why |
|-----------|--------|-----|
| `AuthStorage` | Drop — env vars only | We use Bedrock via IAM, no OAuth/API keys to manage |
| `ModelRegistry` | Drop — hardcode Bedrock | One provider, one model |
| `DefaultResourceLoader` | Replace — minimal loader | We only need extension loading for MCP adapter |
| Skill loading (`loadSkillsFromDir`) | Keep but simplify | Basic YAML frontmatter parsing, no complex resolution |
| `SettingsManager` | Replace — simple JSON I/O | Just `digby.json` hot-reload, no workspace scoping |
| `pi-mcp-adapter` | Keep as optional | Load directly, no resource loader indirection |
| Mom's `slack.ts` | **Rewrite** | New Slack client with delivery guarantees |
| Mom's `main.ts` | **Rewrite** | New harness with per-channel isolation |
| Mom's `agent.ts` | **Rewrite** | Cleaner runner with proper lifecycle |

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              pi-digby process               │
                    │                                             │
                    │  ┌─────────────────────────────────────┐   │
                    │  │         SlackClient                  │   │
                    │  │  Socket Mode + Web API               │   │
                    │  │  Reconnect handling                  │   │
                    │  │  Message routing                     │   │
                    │  └──────────────┬──────────────────────┘   │
                    │                 │                           │
                    │        ┌────────┴────────┐                 │
                    │        │  ChannelRouter   │                 │
                    │        │  Route → queue   │                 │
                    │        └────────┬────────┘                 │
                    │     ┌───────────┼───────────┐              │
                    │     ▼           ▼           ▼              │
                    │  ┌──────┐  ┌──────┐  ┌──────┐             │
                    │  │ Chan │  │ Chan │  │ Chan │  ...         │
                    │  │  A   │  │  B   │  │  C   │             │
                    │  └──┬───┘  └──┬───┘  └──┬───┘             │
                    │     │        │        │                    │
                    │     ▼        ▼        ▼                    │
                    │  ┌──────────────────────────┐              │
                    │  │     Shared resources      │              │
                    │  │  Agent-core, Bedrock,     │              │
                    │  │  MCP adapter              │              │
                    │  └──────────────────────────┘              │
                    │                                             │
                    │  /data (EFS)                                │
                    │    ├── MEMORY.md                            │
                    │    ├── digby.json                           │
                    │    ├── skills/                              │
                    │    └── <channel>/                           │
                    │        ├── MEMORY.md                        │
                    │        ├── log.jsonl                        │
                    │        ├── context.jsonl                    │
                    │        └── scratch/                         │
                    └─────────────────────────────────────────────┘
```

## Core design principles

### 1. Every run resolves visibly

Every triggered run MUST end with a visible Slack update — success, error, or timeout. No silent failures. The user never sees "..." stuck forever.

```
run outcome        → user sees
─────────────────────────────────────
success            → final response + footer
error (LLM)       → "Something went wrong: <reason>"
error (tool)       → error surfaced in response
timeout            → "Timed out after Xs, try again"
abort (user stop)  → "Stopped"
socket disconnect  → result held, re-posted on reconnect
```

Implementation: wrap the entire run in a `RunContext` that guarantees a final message update in its `finally` block.

### 2. Per-channel isolation

Each channel gets its own:
- `ChannelQueue` (serializes runs within a channel — keep from pi-mom, this works)
- `RunContext` (per-run Slack message state — created fresh, disposed on completion)
- Agent runner (session, context file, memory)

Channels do NOT share:
- Mutable state (no module-level globals)
- Run lifecycle (one channel's timeout doesn't affect others)

Channels DO share (immutable/thread-safe):
- SlackClient (single socket, but with retry layer)
- Model instance (stateless)
- MCP adapter (if used)

### 3. Slack calls are reliable

All Slack API calls go through a `SlackClient` wrapper that:
- **Retries** on transient errors (rate limits, network blips) with exponential backoff
- **Detects disconnects** and queues operations for replay after reconnect
- **Never fires and forgets** — every `postMessage`/`updateMessage` is awaited or explicitly caught
- **Logs failures** with enough context to debug

### 4. Timeouts at every level

| Level | Default | Configurable | What happens |
|-------|---------|-------------|--------------|
| Run (overall) | 10 min | `digby.json` → `runTimeout` | Abort session, post timeout message |
| Tool execution | 5 min | Per-tool | Kill tool, return error to agent |
| Slack API call | 30s | No | Retry up to 3x, then log + skip |
| Socket reconnect | Auto | No | SocketModeClient handles this |

## File structure

```
src/
├── main.ts              # Entry point, startup, shutdown
├── config.ts            # digby.json hot-reload
├── slack/
│   ├── client.ts        # SlackClient — Socket Mode + Web API with retry
│   ├── router.ts        # Event routing, message classification, dedup
│   └── types.ts         # Slack event/message types
├── channel/
│   ├── queue.ts         # Per-channel serial work queue
│   ├── runner.ts        # Agent runner lifecycle (setup, run, teardown)
│   ├── run-context.ts   # Per-run state: Slack message, working indicator, guaranteed resolve
│   └── state.ts         # Per-channel persistent state (log, context, memory)
├── agent/
│   ├── setup.ts         # Agent + AgentSession creation, system prompt
│   ├── events.ts        # Event subscriber (tool labels, responses → Slack)
│   ├── skills.ts        # Skill loading (SKILL.md parsing)
│   └── prompt.ts        # System prompt builder
├── tools/
│   ├── index.ts         # Tool factory
│   ├── bash.ts          # Bash execution (host mode, with timeout)
│   ├── read.ts          # File read
│   ├── write.ts         # File write
│   ├── edit.ts          # File edit
│   ├── attach.ts        # File upload to Slack
│   └── react.ts         # Emoji reaction
├── persistence/
│   ├── log.ts           # log.jsonl read/write
│   ├── context.ts       # context.jsonl sync (wraps SessionManager)
│   └── memory.ts        # MEMORY.md loading
├── events/
│   └── watcher.ts       # Scheduled/periodic event system
└── health.ts            # HTTP health check server (ECS)
```

~18 files, estimated ~3,000 LOC total.

## Key component designs

### RunContext (the core reliability primitive)

Every agent run gets a `RunContext` that owns the Slack message lifecycle.

```typescript
class RunContext {
  private messageTs: string | null = null;
  private resolved = false;
  private accumulatedText = "";

  // Post or update the run's Slack message
  async respond(text: string, log?: boolean): Promise<void>
  async replaceMessage(text: string): Promise<void>
  async respondInThread(text: string): Promise<void>

  // Mark run as complete — removes "..." indicator
  async resolve(): Promise<void>

  // Mark run as failed — posts error, removes "..."
  async reject(error: string): Promise<void>

  // Guaranteed cleanup — called in finally block
  // If neither resolve() nor reject() was called, posts a generic error
  async dispose(): Promise<void> {
    if (!this.resolved) {
      await this.reject("Run ended unexpectedly");
    }
  }
}
```

Usage in the runner:

```typescript
const run = new RunContext(slackClient, channel, threadTs);
try {
  await run.respond(":thinking_face: _Thinking_");
  await session.prompt(userMessage);
  await run.replaceMessage(finalText + footer);
  await run.resolve();
} catch (err) {
  await run.reject(err.message);
} finally {
  await run.dispose(); // Safety net
}
```

### SlackClient (reliable Slack operations)

```typescript
class SlackClient {
  private socket: SocketModeClient;
  private web: WebClient;
  private connected = true;

  // All operations retry on transient failure
  async postMessage(channel, text, threadTs?): Promise<string>
  async updateMessage(channel, ts, text): Promise<void>
  async deleteMessage(channel, ts): Promise<void>
  async addReaction(channel, ts, emoji): Promise<void>

  // Event subscription
  onMention(handler): void
  onMessage(handler): void

  // Connection state
  isConnected(): boolean
  onReconnect(handler): void
}
```

The retry logic:

```typescript
async function withRetry<T>(
  op: () => Promise<T>,
  { maxRetries = 3, baseDelay = 1000 } = {}
): Promise<T> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await op();
    } catch (err) {
      if (i === maxRetries || !isRetryable(err)) throw err;
      await sleep(baseDelay * 2 ** i);
    }
  }
}
```

### ChannelRunner (per-channel agent lifecycle)

```typescript
class ChannelRunner {
  private agent: Agent;
  private session: AgentSession;
  private sessionManager: SessionManager;
  // Per-runner tool contexts (no globals)
  private toolContexts: ToolContexts;

  constructor(channelId, channelDir, config) {
    // Create agent, session, tools — all scoped to this channel
  }

  async run(ctx: RunContext, event: SlackEvent): Promise<void> {
    // Sync log → context
    // Rebuild system prompt
    // Set tool contexts for this run's RunContext
    // session.prompt() with timeout
    // Final message update via ctx
  }

  abort(): void {
    this.session.abort();
  }
}
```

### Event subscriber (agent events → Slack)

The event subscriber translates agent events to Slack updates via RunContext.
It's created per-run (not per-runner) to avoid stale closures:

```typescript
function createEventSubscriber(ctx: RunContext, logCtx: LogContext) {
  return async (event: AgentEvent, signal: AbortSignal) => {
    // Note: handlers are now properly awaited by agent-core (9022a5b5)
    if (signal.aborted) return;

    switch (event.type) {
      case "tool_execution_start":
        await ctx.respond(`_→ ${event.args.label}_`, false);
        break;
      case "tool_execution_end":
        if (event.isError) {
          await ctx.respond(`_Error: ${truncate(result, 200)}_`, false);
        }
        break;
      case "message_end":
        // Extract text, post to Slack
        break;
      case "compaction_start":
        await ctx.respond("_Compacting context..._", false);
        break;
    }
  };
}
```

## Migration from pi-mom

### What maps where

| pi-mom file | v2 equivalent | Notes |
|-------------|--------------|-------|
| `main.ts` (408 LOC) | `main.ts` + `channel/runner.ts` | Split: startup vs. run lifecycle |
| `agent.ts` (1085 LOC) | `agent/setup.ts` + `agent/events.ts` + `agent/prompt.ts` | Split: setup, events, prompt building |
| `slack.ts` (711 LOC) | `slack/client.ts` + `slack/router.ts` | Split: API wrapper vs. event routing |
| `context.ts` (217 LOC) | `persistence/context.ts` | Simplified, wraps SessionManager |
| `store.ts` (234 LOC) | `persistence/log.ts` + `channel/state.ts` | Split: log I/O vs. channel state |
| `config.ts` (71 LOC) | `config.ts` | Same, add `runTimeout` |
| `events.ts` (383 LOC) | `events/watcher.ts` | Same functionality |
| `sandbox.ts` (221 LOC) | `tools/bash.ts` | Host-only (no Docker on ECS) |
| `tools/*.ts` (6 files) | `tools/*.ts` | Same tools, per-runner contexts |
| `log.ts` (271 LOC) | Inline in relevant modules | Structured logging |

### Data format compatibility

v2 reads the same `/data` layout. No data migration needed beyond the R2 → EFS copy in the AWS migration plan:

- `log.jsonl` — same format, same sync logic
- `context.jsonl` — same format (SessionManager compatibility)
- `MEMORY.md` — same format
- `SKILL.md` — same format
- `events/*.json` — same format

### System prompt

The system prompt from pi-mom's `agent.ts` is carried over with minor adjustments:
- Remove Docker/sandbox references (host-only on ECS)
- Keep: workspace layout, skill system, event system, memory, log queries, tool descriptions
- Keep: Slack formatting rules, channel/user mappings

## Dependencies

### Required (npm)

```json
{
  "@mariozechner/pi-agent-core": "latest",
  "@mariozechner/pi-ai": "latest",
  "@mariozechner/pi-coding-agent": "latest",
  "@slack/socket-mode": "^2",
  "@slack/web-api": "^7",
  "sharp": "^0.33",
  "pi-mcp-adapter": "latest"
}
```

### Dropped

- `@mariozechner/jiti` (only needed for MCP adapter .ts loading — keep if MCP used)
- All Cloudflare dependencies (wrangler, etc.)
- Docker/sandbox abstractions

## Implementation order

### Phase 1: Scaffold + Slack client (day 1 morning)

1. New `src/` directory structure
2. `slack/client.ts` — SocketModeClient + WebClient with retry
3. `slack/router.ts` — event classification, dedup, routing
4. `slack/types.ts` — event types
5. `health.ts` — HTTP health check server
6. `config.ts` — digby.json hot-reload

### Phase 2: Channel + runner (day 1 afternoon)

1. `channel/queue.ts` — per-channel serial queue
2. `channel/run-context.ts` — guaranteed-resolve Slack message lifecycle
3. `channel/state.ts` — per-channel directory management
4. `channel/runner.ts` — agent runner lifecycle

### Phase 3: Agent integration (day 2 morning)

1. `agent/setup.ts` — Agent + AgentSession creation
2. `agent/events.ts` — event subscriber (agent events → Slack)
3. `agent/prompt.ts` — system prompt builder
4. `agent/skills.ts` — SKILL.md loading
5. `persistence/log.ts` — log.jsonl I/O
6. `persistence/context.ts` — context.jsonl sync
7. `persistence/memory.ts` — MEMORY.md loading

### Phase 4: Tools (day 2 afternoon)

1. `tools/bash.ts` — host execution with timeout
2. `tools/read.ts`, `write.ts`, `edit.ts` — file operations
3. `tools/attach.ts`, `react.ts` — Slack operations (per-runner context)
4. `tools/index.ts` — tool factory

### Phase 5: Events + main (day 3 morning)

1. `events/watcher.ts` — scheduled/periodic event system
2. `main.ts` — entry point, startup, shutdown, signal handling
3. Integration testing with Slack

### Phase 6: AWS deploy (day 3 afternoon)

Per the existing `docs/aws-migration.md`:
1. CloudFormation stack
2. Dockerfile + entrypoint.sh updates
3. GitHub Actions workflow
4. Data migration (R2 → EFS)

## Risk mitigation

| Risk | Mitigation |
|------|-----------|
| Upstream API breaks during development | Pin exact versions at start, upgrade after v2 is stable |
| Data format incompatibility | v2 reads same format — test with production /data copy |
| MCP adapter integration complexity | Make MCP optional, test without it first |
| Socket Mode reliability on ECS | ECS has proper networking (not CF containers). Add reconnect detection + operation replay |
| Regression in agent behavior | Same system prompt, same tools, same context format. Behavior is LLM-determined |

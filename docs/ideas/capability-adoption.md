# Agent Capability Adoption from pi-coding-agent

Analysis of capabilities available in pi-coding-agent (v0.65.0) and pi-mom, compared to
what pi-digby currently implements. Focus: what's worth adopting, how each capability works
end-to-end, and what the integration surface looks like.

## Status Legend

- **HAVE** — pi-digby implements this already
- **GAP** — pi-coding-agent/pi-mom has this, pi-digby doesn't
- **AHEAD** — pi-digby has something pi-mom doesn't

---

## 1. Skills System

### How it works in pi-coding-agent

**Discovery** (`loadSkillsFromDir()`):
- Recursively scans directories for `SKILL.md` files
- Respects `.gitignore` / `.ignore` patterns, skips `node_modules`
- Follows symlinks, deduplicates by resolved path

**SKILL.md format**:
```yaml
---
name: skill-name              # must match parent dir, [a-z0-9-], <= 64 chars
description: "..."            # required, <= 1024 chars
disable-model-invocation: true # optional — hide from LLM, /skill:name only
---
Markdown body with instructions...
```

**Exposure to agent** (`formatSkillsForPrompt()`):
- Injected into system prompt as XML block
- Lists name, description, file location
- Agent told: "Use the read tool to load a skill's file when the task matches"
- Agent reads SKILL.md on demand (not pre-loaded into context)

**Runtime invocation** (in AgentSession):
- User types `/skill:name args`
- AgentSession reads the file, strips frontmatter
- Wraps in `<skill name="..." location="...">` XML block
- Appends user args after closing tag
- Sent to LLM as expanded user message

**Directory hierarchy** (DefaultResourceLoader):
1. `~/.pi/agent/skills/` — user-global
2. `.claude/skills/` — project-level
3. `additionalSkillPaths` from settings/CLI
4. Extension-provided paths

### pi-digby status: HAVE (partial)

- Loads from `{workspace}/skills/` and `{channel}/skills/`
- Uses `loadSkillsFromDir()` + `formatSkillsForPrompt()` correctly
- Missing: no user-global skills dir (`~/.pi/agent/skills/`)
- Missing: no `/skill:name` runtime invocation (agent reads files manually)
- Missing: no `disable-model-invocation` awareness in prompt

### Adoption recommendation

**Add user-global skills directory** — trivial, just add a third `loadSkillsFromDir()` call.
The `/skill:name` expansion happens inside `AgentSession.prompt()` automatically — we get
this for free since we already use AgentSession. Verify it works over Slack.

---

## 2. Built-in Tools (grep, find, ls)

### How it works in pi-coding-agent

Exports 7 tool factories, each with pluggable `Operations` interface:

| Tool | pi-coding-agent | pi-digby | Gap |
|------|-----------------|----------|-----|
| bash | Streaming via `onUpdate`, pluggable `BashOperations`, command prefix | spawn+collect, 500 line / 100KB truncation | Streaming, operations |
| read | Image auto-detection+resize, pluggable `ReadOperations` | Line-only, no images | Image support |
| write | Pluggable `WriteOperations` | Direct writeFileSync | Minor |
| edit | Multi-edit array, unified diff output, BOM/line-ending normalization | Single replacement, no diff | Diff output, multi-edit |
| grep | ripgrep wrapper, regex+literal, context lines, glob filter | N/A (agent uses bash) | **Entire tool** |
| find | glob-based file discovery, sorted by mtime | N/A | **Entire tool** |
| ls | Directory listing with file type/size | N/A | **Entire tool** |

### pi-digby status: GAP (grep, find, ls) + partial gaps on existing tools

### Adoption recommendation

**grep/find/ls**: The agent currently does `grep`, `find`, `ls` via the bash tool. Dedicated
tools give the LLM better schema hints and let us add truncation/safety. However, this is
low priority — bash works fine for a Slack bot where the agent has full host access.

**read — image support**: HIGH value. The agent can't currently "see" images it's asked to
read. pi-coding-agent's read tool detects image MIME types and returns `ImageContent` with
auto-resize. Our read tool already has the image resize logic in setup.ts for Slack
attachments — factor it out and reuse in the read tool.

**edit — diff output**: MEDIUM value. Returning a unified diff helps the agent verify its
edit was correct. pi-mom generates diffs in ~80 lines. Could port.

**edit — multi-edit**: LOW priority. Single replacement per call is fine.

---

## 3. Truncation Module

### How it works in pi-mom

Shared `truncate.ts` (237 lines) with two modes:
- `truncateHead()` — keep first N lines/bytes (for file reads)
- `truncateTail()` — keep last N lines/bytes (for bash output)

Returns rich metadata: `truncatedBy`, `outputLines`, `outputBytes`, `totalLines`, etc.
UTF-8 safe. Dual constraint (whichever limit hits first wins).

### pi-digby status: GAP

Each tool has inline truncation logic. bash: last 500 lines / 100KB. read: first 2000 lines.
No byte limit on read. No shared module.

### Adoption recommendation

**MEDIUM priority**. Factor out a shared truncation module. The current inline logic works
but is inconsistent (bash has byte limits, read doesn't). A shared module also makes it easy
to add byte limits to read and improve the metadata ("showing lines 1-100 of 5000").

---

## 4. Compaction (Context Compression)

### How it works in pi-coding-agent

- Triggered when context tokens exceed `contextWindow - reserveTokens` (default reserve: 16384)
- Finds valid cut points (user/assistant boundaries, never mid-tool-sequence)
- LLM generates summary of discarded messages
- Summary + kept messages = new context
- Extension hooks: `session_before_compact` (modify/cancel), `session_compact` (observe)
- Configurable: `enabled`, `reserveTokens`, `keepRecentTokens` (default 20000)

### pi-digby status: HAVE (built-in)

AgentSession handles compaction automatically. We subscribe to `compaction_start` and
`compaction_end` events and notify the user in Slack. No custom configuration needed — the
defaults work well.

Could consider: tuning `reserveTokens` / `keepRecentTokens` via settings for channels with
very long conversations.

---

## 5. Auto-Retry

### How it works in pi-coding-agent

- After `agent_end`, checks if last message has `stopReason === "error"`
- Retryable: overloaded, rate limit, 429/500x, service unavailable, network, timeout
- NOT retried: context overflow (handled by compaction)
- Exponential backoff: `baseDelayMs * 2^(attempt-1)`
- Configurable: `enabled`, `baseDelayMs`, `maxRetries`
- Abortable via `abortRetry()`

### pi-digby status: HAVE (built-in)

AgentSession handles auto-retry. We subscribe to `auto_retry_start` and `auto_retry_end`
events. The v0.65.0 upgrade specifically fixes Bedrock throttling errors being misidentified
as context overflow — this was causing unnecessary compaction instead of proper retry.

---

## 6. Extension System

### How it works in pi-coding-agent

Extensions are JS/TS modules loaded via `jiti`. They can:
- Register custom tools (`registerTool`)
- Register commands (`registerCommand`)
- Subscribe to events (input, tool_call, tool_result, before_agent_start, etc.)
- Intercept/transform input before the agent sees it
- Modify system prompt per-turn
- Block tool calls (permission checks)

### pi-digby status: HAVE (via MCP adapter)

pi-digby loads the MCP adapter as an extension factory via `DefaultResourceLoader`. This
gives us MCP tool support. We don't use the extension system for anything else.

### Adoption recommendation

**LOW priority for now.** The extension system is powerful but pi-digby's needs are simpler.
MCP adapter covers the main use case (external tools). If we need input interception or
tool-call permissions, the extension system is the right path.

---

## 7. Prompt Templates

### How it works in pi-coding-agent

Markdown files in `~/.config/claude/prompts/` or `.claude/prompts/`. User invokes via
`/template-name arg1 arg2`. Supports argument substitution: `$1`, `$@`, `${@:N:L}`.

### pi-digby status: GAP (but low impact)

The agent in Slack doesn't have a `/template` command UX. Skills serve a similar purpose
(reusable instructions). Prompt templates are more TUI-focused.

### Adoption recommendation

**SKIP** — skills cover this need for a Slack bot.

---

## 8. Session Tree / Branching

### How it works in pi-coding-agent

Conversation history is a tree (not linear). Users can navigate to previous points, fork
conversations, and get LLM-generated summaries of abandoned branches.

### pi-digby status: N/A

Slack conversations are linear per-channel. Tree navigation doesn't apply.

### Adoption recommendation

**SKIP** — not applicable to Slack bot UX.

---

## 9. Model Cycling / Registry

### How it works in pi-coding-agent

`ModelRegistry` resolves model names (fuzzy, glob, aliases). Users can cycle through
configured models. Supports scoped model lists, per-model thinking levels.

### pi-digby status: HAVE (minimal)

We create `ModelRegistry` but hardcode to `claude-sonnet-4-6` on Bedrock. No cycling.

### Adoption recommendation

**LOW priority**. Could expose model switching via a Slack command, but single-model is
simpler and Bedrock limits which models are available anyway.

---

## 10. defineTool()

### How it works in pi-coding-agent

`defineTool()` wraps a `ToolDefinition` object to preserve TypeScript parameter inference.
It's for extension-registered tools, not base tool overrides.

### pi-digby status: N/A

pi-digby uses `AgentTool` (from pi-agent-core) for `baseToolsOverride`. `defineTool()`
produces `ToolDefinition` which has an extra `ctx: ExtensionContext` parameter in `execute`.
These are different types serving different registration paths.

### Adoption recommendation

**SKIP** — not compatible with `baseToolsOverride` pattern. Would only matter if we
registered tools via extensions instead of base overrides.

---

## Priority Summary

| Capability | Priority | Effort | Value |
|-----------|----------|--------|-------|
| User-global skills dir | HIGH | Trivial | Unlocks shared skills across all channels |
| Read tool: image support | HIGH | Low | Agent can "see" images it reads from disk |
| Shared truncation module | MEDIUM | Medium | Consistent limits, better metadata |
| Edit tool: diff output | MEDIUM | Low | Agent can verify edits visually |
| grep/find/ls tools | LOW | Medium | Agent already uses bash for these |
| Compaction tuning | LOW | Trivial | Per-channel settings for long conversations |
| Extension-based features | LOW | High | Input interception, tool permissions |
| Prompt templates | SKIP | — | Skills cover this for Slack |
| Tree/branching | SKIP | — | Not applicable to Slack |
| defineTool() | SKIP | — | Incompatible with baseToolsOverride |

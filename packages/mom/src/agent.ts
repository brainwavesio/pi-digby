import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join } from "path";
import sharp from "sharp";
import { isDebugThreadingEnabled } from "./config.js";
import { createMomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction, setReactionFunction } from "./tools/index.js";

// Hardcoded model for now - TODO: make configurable (issue #63)
const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-6");

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	shutdown(): Promise<void>;
}

async function getBedrockApiKey(): Promise<string> {
	// Bedrock uses AWS SDK credential chain (env vars, profile, etc.) - no API key needed.
	// Return sentinel value to satisfy the Agent interface.
	if (
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_BEARER_TOKEN_BEDROCK
	) {
		return "<authenticated>";
	}
	throw new Error(
		"No AWS credentials found for Bedrock.\n\n" +
			"Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_PROFILE environment variables.",
	);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

const MAX_IMAGE_DIMENSION = 2000;

async function resizeImageIfNeeded(buffer: Buffer, mimeType: string): Promise<{ data: string; mimeType: string }> {
	const metadata = await sharp(buffer).metadata();
	const { width = 0, height = 0 } = metadata;

	if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
		return { data: buffer.toString("base64"), mimeType };
	}

	const resized = await sharp(buffer)
		.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: "inside", withoutEnlargement: true })
		.jpeg({ quality: 80 })
		.toBuffer();

	return { data: resized.toString("base64"), mimeType: "image/jpeg" };
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";
	const timezone = process.env.TZ || "Australia/Melbourne";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()} (changes will be lost on container restart)
- Be careful with system modifications`;

	return `You are digby, a Slack bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+10:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${timezone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+10:00\`). Periodic events use IANA timezone names. The harness runs in ${timezone}. When users mention times without timezone, assume ${timezone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+10:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+10:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory & Search

### Writing Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

Also write markdown notes periodically, or when you learn something important to the user or the work:
- Global notes: ${workspacePath}/memory/YYYY-MM-DD.md (cross-channel knowledge)
- Channel notes: ${channelPath}/memory/YYYY-MM-DD.md (channel-specific context)
These are indexed by QMD for semantic search. Write useful summaries of decisions, outcomes, and context. After writing memory files, re-index: \`QMD_CACHE_DIR=/data/.cache/qmd qmd --config /data/qmd.yml embed\`

### Searching
Semantic search across all memory and history:
\`\`\`bash
QMD_CACHE_DIR=/data/.cache/qmd qmd --config /data/qmd.yml query "what was the deployment strategy we discussed"
\`\`\`

Search a specific collection:
\`\`\`bash
QMD_CACHE_DIR=/data/.cache/qmd qmd --config /data/qmd.yml query "deployment" --collection channels
\`\`\`

For simple recent keyword lookups in current channel, use grep on log.jsonl (see Log Queries below).

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","threadTs":"...","user":"...","userName":"...","text":"...","isBot":false}\`
- \`threadTs\` is set for messages inside a thread (value = parent message ts)
- Messages without \`threadTs\` are in the main channel
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'

# Main channel only (exclude thread messages)
grep -v '"threadTs"' log.jsonl | tail -30 | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Specific thread
grep '"threadTs":"<ts>"' log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'
\`\`\`

## Browser (browser-use CLI)
Use \`uvx browser-use\` for web browsing tasks. It runs against the cloud service (no local browser needed).
\`\`\`bash
uvx browser-use open https://example.com   # Navigate to URL
uvx browser-use state                       # See clickable elements
uvx browser-use click 5                     # Click element by index
uvx browser-use type "search query"         # Type text
uvx browser-use screenshot page.png         # Take screenshot
uvx browser-use close                       # Close browser
\`\`\`
Sessions persist between commands for multi-step browsing.

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack
- react: Add an emoji reaction to the triggering message. Use instead of a text reply when a reaction is enough — 👀 for noted, ✅ for done, 🎉 for good news. If you react, respond with \`[SILENT]\` so no message is posted.

Each tool requires a "label" parameter (shown to user).
`;
}

function getMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export async function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
): Promise<AgentRunner> {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = await createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 */
async function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): Promise<AgentRunner> {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));

	// Create tools
	const tools = createMomTools(executor);

	// System prompt — mutable so the systemPromptOverride closure always returns the
	// latest version. AgentSession.prompt() resets the agent's prompt to _baseSystemPrompt
	// on every call; if this were const, the agent would always see the stale initial prompt.
	const memory = getMemory(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	let systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = createMomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getBedrockApiKey(),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	// Use jiti to load pi-mcp-adapter (.ts source, no compiled .js)
	const require = createRequire(import.meta.url);
	const adapterDir = dirname(require.resolve("pi-mcp-adapter/package.json"));
	const { createJiti } = await import("@mariozechner/jiti");
	const jiti = createJiti(import.meta.url);
	const mcpAdapter = (await jiti.import(join(adapterDir, "index.ts"), { default: true })) as (
		...args: unknown[]
	) => void;
	// Use the workspace (data) dir as cwd so the resource loader discovers
	// AGENTS.md/CLAUDE.md from the persistent volume, not the ephemeral /app.
	const hostWorkspacePath = channelDir.replace(`/${channelId}`, "");
	const resourceLoader = new DefaultResourceLoader({
		cwd: hostWorkspacePath,
		agentDir: getAgentDir(),
		settingsManager,
		extensionFactories: [mcpAdapter],
		// Skills are loaded manually by mom (loadMomSkills) because:
		// 1. Per-run scanning — catches skills the agent creates at runtime
		// 2. Channel-specific skills override workspace skills on name collision
		// 3. Path translation for Docker sandbox mode
		// The resource loader only scans at reload() time and doesn't know about channels.
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: () => systemPrompt,
	});
	await resourceLoader.reload();

	// Track MCP config mtime to detect changes between runs.
	// When the agent edits mcp.json (e.g. adding OAuth tokens), we need to reload
	// extensions so the MCP adapter reconnects with the new config.
	const mcpConfigPath = join(hostWorkspacePath, ".pi", "mcp.json");
	let mcpConfigMtime = getMtime(mcpConfigPath);

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: hostWorkspacePath,
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Trigger session_start so extensions (e.g. pi-mcp-adapter) initialize
	await session.bindExtensions({});

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as SlackContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stepCount: 0,
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		lastStreamedText: "" as string,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;
			runState.stepCount++;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to debug thread (only when debug threading is on)
			if (isDebugThreadingEnabled()) {
				const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
				const argsFormatted = pending
					? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>)
					: "(args not found)";
				const duration = (durationMs / 1000).toFixed(1);
				let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
				if (label) threadMessage += `: ${label}`;
				threadMessage += ` (${duration}s)\n`;
				if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
				threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
					if (isDebugThreadingEnabled()) {
						queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
					}
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					runState.lastStreamedText = text;
					queue.enqueueMessage(text, "main", "response main");
					if (isDebugThreadingEnabled()) {
						queue.enqueueMessage(text, "thread", "response thread", false);
					}
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.errorMessage) {
				log.logWarning("Auto-compaction failed", compEvent.errorMessage);
				queue.enqueue(
					() => ctx.respond(`_Compaction error: ${truncate(compEvent.errorMessage, 200)}_`, false),
					"compaction error",
				);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		} else if (event.type === "auto_retry_end") {
			const retryEvent = event as any;
			if (!retryEvent.success) {
				log.logWarning(`Retries exhausted (${retryEvent.attempt} attempts)`, retryEvent.finalError || "");
				queue.enqueue(
					() => ctx.respond(`_Retries exhausted after ${retryEvent.attempt} attempts_`, false),
					"retry end",
				);
			}
		}
	});

	// Slack message limit
	const SLACK_MAX_LENGTH = 40000;
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
			remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: SlackContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts, ctx.message.threadTs);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh memory, channel/user info, and skills.
			// Updates the outer `let systemPrompt` so the resource loader's systemPromptOverride
			// closure returns the fresh value.
			const memory = getMemory(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
			);

			// If MCP config changed (e.g. agent added OAuth tokens), reload extensions
			// so the adapter reconnects with the new config. reload() also re-evaluates
			// systemPromptOverride and rebuilds _baseSystemPrompt.
			// Otherwise just flush the resource loader cache and trigger a prompt rebuild.
			const currentMcpMtime = getMtime(mcpConfigPath);
			if (currentMcpMtime !== mcpConfigMtime) {
				mcpConfigMtime = currentMcpMtime;
				log.logInfo(`[${channelId}] MCP config changed, reloading extensions`);
				await session.reload();
				await session.bindExtensions({});
			} else {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- no public API to update cached prompt
				(resourceLoader as any).systemPrompt = systemPrompt;
				session.setActiveToolsByName(session.getActiveToolNames());
			}

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Set up reaction function
			setReactionFunction(async (emoji: string) => {
				await ctx.addReaction(emoji);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stepCount = 0;
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.lastStreamedText = "";

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
							try {
								if (isDebugThreadingEnabled()) {
									await ctx.respondInThread(`_Error: ${errMsg}_`);
								} else {
									await ctx.respond(`_Error: ${errMsg}_`, false);
								}
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						const raw = readFileSync(fullPath);
						const resized = await resizeImageIfNeeded(raw, mimeType);
						imageAttachments.push({
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// Handle error case - show error in main message (or thread if debug threading is on)
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					if (isDebugThreadingEnabled()) {
						await ctx.replaceMessage("_Sorry, something went wrong_");
						await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
					} else {
						await ctx.replaceMessage(`_Sorry, something went wrong: ${truncate(runState.errorMessage, 500)}_`);
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else if (runState.stopReason === "max_tokens") {
				// Ran out of output token budget mid-response — post a visible notice rather than going silent
				try {
					const footer = runState.stepCount > 0 || runState.totalUsage.cost.total > 0
						? `    _«${runState.stepCount} steps · $${runState.totalUsage.cost.total.toFixed(2)}»_`
						: "";
					await ctx.replaceMessage(`_Ran out of space mid-response. Try asking me to continue, or break it into smaller steps._${footer}`);
				} catch (err) {
					log.logWarning("Failed to post max_tokens message", err instanceof Error ? err.message : String(err));
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const sessionFinalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";
				// After compaction, session.messages may not contain the real final response
				// (the last assistant entry becomes the compaction summary). Fall back to the
				// last text we actually streamed to Slack.
				const finalText = sessionFinalText.trim() ? sessionFinalText : runState.lastStreamedText;

				// Check for [SILENT] marker - delete message and thread instead of posting
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						// Append compact usage footer
						const footer =
							runState.stepCount > 0 || runState.totalUsage.cost.total > 0
								? `    _«${runState.stepCount} steps · $${runState.totalUsage.cost.total.toFixed(2)}»_`
								: "";
						const fullText = finalText + footer;
						const mainText =
							fullText.length > SLACK_MAX_LENGTH
								? `${fullText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: fullText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary (console only — footer is now inline on the main message)
			if (runState.totalUsage.cost.total > 0) {
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = model.contextWindow || 200000;

				log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},

		async shutdown(): Promise<void> {
			// Emit session_shutdown so extensions (MCP adapter) can close server connections
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- no public API for extension shutdown
			const runner = (session as any)._extensionRunner;
			if (runner) {
				await runner.emit({ type: "session_shutdown" });
			}
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}

/**
 * Shut down all cached channel runners.
 * Emits session_shutdown to extensions so MCP servers can close connections.
 */
export async function shutdownAllRunners(): Promise<void> {
	const runners = Array.from(channelRunners.values());
	await Promise.allSettled(runners.map((r) => r.shutdown()));
}

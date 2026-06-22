/**
 * Agent + AgentSession creation and run orchestration.
 *
 * Creates the Agent, AgentSession, wires up tools and MCP extensions,
 * and manages the per-message run lifecycle.
 */

import { type AfterToolCallContext, type AfterToolCallResult, Agent } from "@earendil-works/pi-agent-core";
import { getModel, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join } from "path";
import type { RunStats } from "../channel/run-stats.js";
import type { ChannelState } from "../channel/state.js";
import { getRunTimeout } from "../config.js";
import * as log from "../log.js";
import {
	createDigbySettingsManager,
	formatLogMessageForContext,
	type LogContextScope,
	syncLogToContext,
} from "../persistence/context.js";
import { loadMemory } from "../persistence/memory.js";
import type { SlackChannel, SlackUser } from "../slack/types.js";
import type { AgentSurface } from "../surface/types.js";
import { createTools } from "../tools/index.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateBytesHead } from "../tools/truncate.js";
import type { BotEvent } from "../types.js";
import { resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";
import { createEventHandler } from "./events.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadSkills } from "./skills.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-6");

// Sanity check: pi-coding-agent's threshold compaction needs a positive
// contextWindow to decide when to compact. If this ever returns 0 (model
// metadata missing or renamed upstream) we lose proactive compaction and
// risk recurring the D0AADDL2LCW incident. Fail loud at boot.
if (!model.contextWindow || model.contextWindow <= 0) {
	log.warn(
		`Model ${model.provider}/${model.id} has no contextWindow (${model.contextWindow}). ` +
			"Threshold compaction will not trigger reliably — verify pi-ai model registry.",
	);
} else {
	log.info(`Model ${model.provider}/${model.id} contextWindow=${model.contextWindow}`);
}

// ---------------------------------------------------------------------------
// Bedrock auth
// ---------------------------------------------------------------------------

async function getBedrockApiKey(): Promise<string> {
	if (
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI // ECS task role
	) {
		return "<authenticated>";
	}
	throw new Error(
		"No AWS credentials found for Bedrock.\n\n" +
			"Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or run on ECS with a task role.",
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Blanket tool-result byte cap.
 *
 * Local bash/read already self-truncate at `DEFAULT_MAX_BYTES` (50KB), but MCP
 * tools (PostHog, Linear, Exa, etc.) flow through `pi-mcp-adapter` which has
 * no truncation. A single large MCP response gets persisted verbatim to
 * `context.jsonl` and replayed on every subsequent turn, so one fat result can
 * inflate the prompt past Bedrock's tolerable payload size (~5MB observed) and
 * brick the channel with opaque "Service unavailable" errors.
 *
 * This hook is a safety net: cap each tool result's combined text content at
 * 50KB with a clear notice. Idempotent against existing self-truncation
 * (no-op when content already fits). Preserves image content untouched.
 */
async function capToolResultBytes({
	result,
	toolCall,
}: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
	let textBytes = 0;
	for (const c of result.content) {
		if (c.type === "text") textBytes += Buffer.byteLength(c.text, "utf-8");
	}
	if (textBytes <= DEFAULT_MAX_BYTES) return undefined;

	const textParts: string[] = [];
	const passthrough: ImageContent[] = [];
	for (const c of result.content) {
		if (c.type === "text") textParts.push(c.text);
		else passthrough.push(c);
	}

	const joined = textParts.join("\n");
	const clipped = truncateBytesHead(joined, DEFAULT_MAX_BYTES);
	const toolName = (toolCall as { name?: string }).name ?? "tool";
	const notice = `\n\n[output truncated — kept first ${formatSize(Buffer.byteLength(clipped.text, "utf-8"))} of ${formatSize(clipped.totalBytes)} from \`${toolName}\`. Narrow your query/args to see more.]`;

	const newContent: (TextContent | ImageContent)[] = [{ type: "text", text: clipped.text + notice }, ...passthrough];
	return { content: newContent };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChannelRunner {
	run(
		ctx: AgentSurface,
		event: BotEvent,
		channelState: ChannelState,
		channels: SlackChannel[],
		users: SlackUser[],
		userName?: string,
		stats?: RunStats,
		logContextScope?: LogContextScope,
	): Promise<RunResult>;
	abort(): void;
	shutdown(): Promise<void>;
}

export interface RunResult {
	stopReason: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createChannelRunner(opts: {
	channelId: string;
	channelDir: string;
	sessionDir: string;
	workingDir: string;
}): Promise<ChannelRunner> {
	const { channelId, channelDir, sessionDir, workingDir } = opts;

	// Ensure channel directory exists
	await mkdir(channelDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------
	const { tools, contexts: toolContexts } = createTools();

	// -----------------------------------------------------------------------
	// System prompt (mutable — rebuilt each run)
	// -----------------------------------------------------------------------
	const memory = loadMemory(channelDir);
	const skills = loadSkills(channelDir, workingDir);
	let systemPrompt = buildSystemPrompt({
		workspacePath: workingDir,
		channelId,
		memory,
		channels: [],
		users: [],
		skills,
	});

	// -----------------------------------------------------------------------
	// Agent
	// -----------------------------------------------------------------------
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getBedrockApiKey(),
		afterToolCall: capToolResultBytes,
	});

	// -----------------------------------------------------------------------
	// Session persistence
	// -----------------------------------------------------------------------
	const contextFile = join(sessionDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, sessionDir);
	const settingsManager = createDigbySettingsManager(workingDir);

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
		log.info(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	// -----------------------------------------------------------------------
	// Auth + Model registry
	// -----------------------------------------------------------------------
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage);

	// -----------------------------------------------------------------------
	// MCP adapter via jiti (loads .ts source without compiling)
	// -----------------------------------------------------------------------
	let resourceLoader: ResourceLoader;
	let isDefaultResourceLoader = false;

	try {
		const require = createRequire(import.meta.url);
		const adapterDir = dirname(require.resolve("pi-mcp-adapter/package.json"));
		const { createJiti } = await import("jiti");
		const jiti = createJiti(import.meta.url);
		const mcpAdapter = (await jiti.import(join(adapterDir, "index.ts"), {
			default: true,
		})) as (...args: unknown[]) => void;

		const defaultLoader = new DefaultResourceLoader({
			cwd: workingDir,
			agentDir: getAgentDir(),
			settingsManager,
			extensionFactories: [mcpAdapter],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: () => systemPrompt,
		});
		await defaultLoader.reload();
		resourceLoader = defaultLoader;
		isDefaultResourceLoader = true;
	} catch (err) {
		log.warn(
			`[${channelId}] Failed to load MCP adapter, continuing without extensions: ${err instanceof Error ? err.message : String(err)}`,
		);
		// Fallback: minimal resource loader without MCP
		resourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => systemPrompt,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		} as any;
	}

	// Track MCP config mtime to detect changes between runs
	const mcpConfigPath = join(workingDir, ".pi", "mcp.json");
	let mcpConfigMtime = getMtime(mcpConfigPath);

	// -----------------------------------------------------------------------
	// AgentSession
	// -----------------------------------------------------------------------
	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: workingDir,
		modelRegistry,
		resourceLoader: resourceLoader as ResourceLoader,
		baseToolsOverride,
	});

	// Trigger session_start so extensions (e.g. MCP adapter) initialize
	await session.bindExtensions({});

	// -----------------------------------------------------------------------
	// Abort state
	// -----------------------------------------------------------------------
	let abortRequested = false;

	// -----------------------------------------------------------------------
	// Runner
	// -----------------------------------------------------------------------
	return {
		async run(
			ctx: AgentSurface,
			event: BotEvent,
			_channelState: ChannelState,
			channels: SlackChannel[],
			users: SlackUser[],
			userName?: string,
			stats?: RunStats,
			logContextScope?: LogContextScope,
		): Promise<RunResult> {
			abortRequested = false;
			// Use caller's stats (shared with AgentSurface for footer) or create local
			const runStats: RunStats = stats || {
				stepCount: 0,
				totalCost: 0,
				stopReason: "stop",
				errorMessage: undefined,
				lastStreamedText: "",
			};

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });
			await mkdir(sessionDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while offline or busy
			const scope = logContextScope ?? defaultLogContextScope(event);
			const syncedCount = syncLogToContext(sessionManager, channelDir, event.ts, scope);
			if (syncedCount > 0) {
				log.info(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl (picks up synced messages)
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.state.messages = reloadedSession.messages;
				log.info(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Rebuild system prompt with fresh memory, channels, users, skills
			const memory = loadMemory(channelDir);
			const skills = loadSkills(channelDir, workingDir);
			systemPrompt = buildSystemPrompt({
				workspacePath: workingDir,
				channelId,
				memory,
				channels,
				users,
				skills,
				source: event.source,
			});

			// If MCP config changed, reload extensions
			const currentMcpMtime = getMtime(mcpConfigPath);
			if (currentMcpMtime !== mcpConfigMtime) {
				mcpConfigMtime = currentMcpMtime;
				log.info(`[${channelId}] MCP config changed, reloading extensions`);
				try {
					await session.reload();
					await session.bindExtensions({});
				} catch (err) {
					log.warn(
						`[${channelId}] MCP reload failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			} else {
				// Flush the resource loader cache and trigger a prompt rebuild.
				// systemPromptOverride closure captures `systemPrompt` by reference,
				// so we only need to trigger a tool rebuild to re-evaluate it.
				if (isDefaultResourceLoader) {
					// Force the resource loader to re-evaluate systemPromptOverride
					(resourceLoader as any).systemPrompt = systemPrompt;
				}
				session.setActiveToolsByName(session.getActiveToolNames());
			}

			// Wire tool contexts for this run
			toolContexts.attach.uploadFn = async (filePath: string, title?: string) => {
				ctx.emitFile(filePath, title);
			};
			toolContexts.react.reactionFn = async (emoji: string) => {
				ctx.emitReaction(emoji, event.ts);
			};

			// Create per-run event handler (shares stats reference with AgentSurface for footer)
			const handler = createEventHandler(ctx, channelId, runStats);
			const unsubscribe = session.subscribe(handler);

			try {
				// Log context info
				log.info(
					`[${channelId}] Context: system=${systemPrompt.length} chars, memory=${memory.length} chars, channels=${channels.length}, users=${users.length}`,
				);

				// Build user message with timestamp and username prefix
				const eventThreadTs = event.threadTs && event.threadTs !== event.ts ? event.threadTs : undefined;
				let userMessage = formatLogMessageForContext(event.source, {
					ts: event.ts,
					...(eventThreadTs && { threadTs: eventThreadTs }),
					user: event.user,
					userName,
					text: event.text,
					isBot: false,
				});

				// Process image attachments
				const imageAttachments: ImageContent[] = [];
				const nonImagePaths: string[] = [];

				for (const a of event.attachments || []) {
					const fullPath = join(workingDir, a.local);
					if (!existsSync(fullPath)) {
						nonImagePaths.push(fullPath);
						continue;
					}

					// Detect image via binary header sniffing
					let mimeType: string | null = null;
					try {
						mimeType = await detectSupportedImageMimeTypeFromFile(fullPath);
					} catch {
						// Not an image or can't read
					}

					if (mimeType) {
						try {
							const raw = readFileSync(fullPath);
							const base64 = raw.toString("base64");
							const resized = await resizeImage({ type: "image", data: base64, mimeType });
							if (resized) {
								imageAttachments.push({
									type: "image",
									mimeType: resized.mimeType,
									data: resized.data,
								});
							} else {
								nonImagePaths.push(fullPath);
							}
						} catch {
							nonImagePaths.push(fullPath);
						}
					} else {
						nonImagePaths.push(fullPath);
					}
				}

				if (nonImagePaths.length > 0) {
					userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
				}

				// Debug: write context to last_prompt.jsonl
				const debugContext = {
					systemPrompt,
					messages: session.messages,
					newUserMessage: userMessage,
					imageAttachmentCount: imageAttachments.length,
				};
				await writeFile(join(sessionDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

				// Run with timeout
				const timeoutMs = getRunTimeout() * 1000;
				const timeoutPromise = new Promise<void>((_, reject) => {
					setTimeout(() => reject(new Error(`Run timed out after ${getRunTimeout()}s`)), timeoutMs);
				});

				const promptPromise = session.prompt(
					userMessage,
					imageAttachments.length > 0 ? { images: imageAttachments } : undefined,
				);

				await Promise.race([promptPromise, timeoutPromise]).catch(async (err) => {
					if (!abortRequested) {
						log.warn(`[${channelId}] Run error/timeout: ${err.message}`);
						await session.abort();
					}
					runStats.stopReason = "error";
					runStats.errorMessage = err.message;
				});

				// Wait for Slack update queue to flush
				await ctx.flush();

				// Handle final result — footer is auto-appended by AgentSurface
				if (runStats.stopReason === "error" && runStats.errorMessage) {
					ctx.emitResponse(`*Sorry, something went wrong: ${truncate(runStats.errorMessage, 500)}*`);
				} else if (runStats.stopReason === "max_tokens") {
					ctx.emitResponse(
						"*Ran out of space mid-response. Try asking me to continue, or break it into smaller steps.*",
					);
				} else {
					// Extract final text from session messages
					const messages = session.messages;
					const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
					const sessionFinalText =
						lastAssistant?.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n") || "";
					const finalText = sessionFinalText.trim() ? sessionFinalText : runStats.lastStreamedText;

					// Check for [SILENT] marker
					if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
						ctx.suppress();
						log.info(`[${channelId}] Silent response - deleted message`);
					} else if (finalText.trim()) {
						ctx.emitResponse(finalText);
					}
				}

				// NOTE: resolve() is NOT called here — main.ts calls it in finally
				return {
					stopReason: runStats.stopReason,
					errorMessage: runStats.errorMessage,
				};
			} finally {
				unsubscribe();
			}
		},

		abort(): void {
			abortRequested = true;
			agent.abort();
		},

		async shutdown(): Promise<void> {
			// Emit session_shutdown so extensions (MCP adapter) can close connections.
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				try {
					await extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} catch (err) {
					log.warn(`[${channelId}] Extension shutdown error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			// Dispose the AgentSession: invalidates extension contexts, disconnects
			// agent listeners, and runs session-resource cleanup. Without this,
			// per-run evictions leak Agent event subscriptions and extension state
			// over time. See `AgentSession.dispose()` in pi-coding-agent.
			try {
				session.dispose();
			} catch (err) {
				log.warn(`[${channelId}] Session dispose error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Runner cache
// ---------------------------------------------------------------------------

const channelRunners = new Map<string, ChannelRunner>();

/**
 * Get or create a ChannelRunner for a conversation.
 * Runners are cached by runnerId, so Slack threads can have isolated session context
 * while still sharing the physical channel log cache.
 */
export async function getOrCreateRunner(opts: {
	runnerId: string;
	channelId: string;
	channelDir: string;
	sessionDir: string;
	workingDir: string;
}): Promise<ChannelRunner> {
	const existing = channelRunners.get(opts.runnerId);
	if (existing) return existing;

	const runner = await createChannelRunner(opts);
	channelRunners.set(opts.runnerId, runner);
	return runner;
}

/**
 * Evict a cached runner after a run completes.
 *
 * This aligns us with pi-coding-agent's session-boundary model: each "run" is
 * effectively one session lifetime, and the next event rebuilds from disk.
 * Eviction bounds in-memory `SessionManager.fileEntries` growth and ensures
 * external trims to `context.jsonl` actually take effect on the next trigger.
 *
 * Safe to call after `runner.run()` resolves — entries are persisted
 * synchronously via `appendFileSync`, so disk has everything at this point.
 *
 * Concurrent runners across different runnerIds are unaffected: each channel
 * / Slack thread / Linear issue has its own runnerId and serializes via its
 * own lane.
 */
export async function evictRunner(runnerId: string): Promise<void> {
	const runner = channelRunners.get(runnerId);
	if (!runner) return;
	channelRunners.delete(runnerId);
	try {
		await runner.shutdown();
	} catch (err) {
		log.warn(
			`[${runnerId}] Runner shutdown error during eviction: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function defaultLogContextScope(event: BotEvent): LogContextScope {
	if (event.source === "linear") {
		return { source: "linear", kind: "chronological" };
	}
	if (event.threadTs) {
		return { source: "slack", kind: "thread", rootTs: event.threadTs };
	}
	return { source: "slack", kind: "channel" };
}

/**
 * Shut down all cached channel runners.
 * Emits session_shutdown to extensions so MCP servers can close connections.
 */
export async function shutdownAllRunners(): Promise<void> {
	const runners = Array.from(channelRunners.values());
	await Promise.allSettled(runners.map((r) => r.shutdown()));
}

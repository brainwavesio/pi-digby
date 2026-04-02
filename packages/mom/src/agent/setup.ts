/**
 * Agent + AgentSession creation and run orchestration.
 *
 * Creates the Agent, AgentSession, wires up tools and MCP extensions,
 * and manages the per-message run lifecycle.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join } from "path";
import sharp from "sharp";
import type { RunContext } from "../channel/run-context.js";
import type { ChannelState } from "../channel/state.js";
import { getRunTimeout } from "../config.js";
import * as log from "../log.js";
import { createMomSettingsManager, syncLogToContext } from "../persistence/context.js";
import { loadMemory } from "../persistence/memory.js";
import type { SlackChannel, SlackEvent, SlackUser } from "../slack/types.js";
import { createTools } from "../tools/index.js";
import { createEventHandler, type RunStats } from "./events.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadSkills } from "./skills.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-6");

// ---------------------------------------------------------------------------
// Bedrock auth
// ---------------------------------------------------------------------------

async function getBedrockApiKey(): Promise<string> {
	if (process.env.AWS_PROFILE || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)) {
		return "<authenticated>";
	}
	throw new Error(
		"No AWS credentials found for Bedrock.\n\n" +
			"Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_PROFILE environment variables.",
	);
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

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
		.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
			fit: "inside",
			withoutEnlargement: true,
		})
		.jpeg({ quality: 80 })
		.toBuffer();

	return { data: resized.toString("base64"), mimeType: "image/jpeg" };
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

function formatTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	const offset = -now.getTimezoneOffset();
	const offsetSign = offset >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMins = pad(Math.abs(offset) % 60);
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
}

const SLACK_MAX_LENGTH = 40000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChannelRunner {
	run(
		ctx: RunContext,
		event: SlackEvent,
		channelState: ChannelState,
		channels: SlackChannel[],
		users: SlackUser[],
		userName?: string,
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
	workingDir: string;
}): Promise<ChannelRunner> {
	const { channelId, channelDir, workingDir } = opts;

	// Ensure channel directory exists
	await mkdir(channelDir, { recursive: true });

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
	});

	// -----------------------------------------------------------------------
	// Session persistence
	// -----------------------------------------------------------------------
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = createMomSettingsManager(workingDir);

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
		const { createJiti } = await import("@mariozechner/jiti");
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
			getExtensions: () => ({ extensions: [], errors: [], runtime: undefined as any }),
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
	// Event handler (subscribed once, stats are reset per run)
	// -----------------------------------------------------------------------
	let eventStats: RunStats | null = null;

	session.subscribe((event) => {
		if (!eventStats) return;
		// Delegate to the per-run event handler
		if ((event as any)._handler) {
			(event as any)._handler(event);
		}
	});

	// -----------------------------------------------------------------------
	// Abort controller for timeout
	// -----------------------------------------------------------------------
	let abortRequested = false;

	// -----------------------------------------------------------------------
	// Runner
	// -----------------------------------------------------------------------
	return {
		async run(
			ctx: RunContext,
			event: SlackEvent,
			_channelState: ChannelState,
			channels: SlackChannel[],
			users: SlackUser[],
			userName?: string,
		): Promise<RunResult> {
			abortRequested = false;

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while offline or busy
			const syncedCount = syncLogToContext(sessionManager, channelDir, event.ts, event.threadTs);
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
				ctx.uploadFile(filePath, title);
			};
			toolContexts.react.reactionFn = async (emoji: string) => {
				ctx.addReaction(emoji, event.ts);
			};

			// Create per-run event handler
			const { handler, stats } = createEventHandler(ctx, channelId);
			eventStats = stats;

			// Replace session-level subscriber with per-run handler
			const unsubscribe = session.subscribe(handler);

			try {
				// Log context info
				log.info(
					`[${channelId}] Context: system=${systemPrompt.length} chars, memory=${memory.length} chars, channels=${channels.length}, users=${users.length}`,
				);

				// Build user message with timestamp and username prefix
				const timestamp = formatTimestamp();
				let userMessage = `[${timestamp}] [${userName || event.user || "unknown"}]: ${event.text}`;

				// Process image attachments
				const imageAttachments: ImageContent[] = [];
				const nonImagePaths: string[] = [];

				for (const a of event.attachments || []) {
					const fullPath = join(workingDir, a.local);
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
					stats.stopReason = "error";
					stats.errorMessage = err.message;
				});

				// Wait for Slack update queue to flush
				await ctx.flush();

				// Handle final result
				if (stats.stopReason === "error" && stats.errorMessage) {
					ctx.replaceMessage(`_Sorry, something went wrong: ${truncate(stats.errorMessage, 500)}_`);
				} else if (stats.stopReason === "max_tokens") {
					const footer =
						stats.stepCount > 0 || stats.totalCost > 0
							? `    _\u00AB${stats.stepCount} steps \u00B7 $${stats.totalCost.toFixed(2)}\u00BB_`
							: "";
					ctx.replaceMessage(
						`_Ran out of space mid-response. Try asking me to continue, or break it into smaller steps._${footer}`,
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
					const finalText = sessionFinalText.trim() ? sessionFinalText : stats.lastStreamedText;

					// Check for [SILENT] marker
					if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
						ctx.deleteMessage();
						log.info(`[${channelId}] Silent response - deleted message`);
					} else if (finalText.trim()) {
						const footer =
							stats.stepCount > 0 || stats.totalCost > 0
								? `    _\u00AB${stats.stepCount} steps \u00B7 $${stats.totalCost.toFixed(2)}\u00BB_`
								: "";
						const fullText = finalText + footer;
						const mainText =
							fullText.length > SLACK_MAX_LENGTH
								? `${fullText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: fullText;
						ctx.replaceMessage(mainText);
					}
				}

				return {
					stopReason: stats.stopReason,
					errorMessage: stats.errorMessage,
				};
			} finally {
				unsubscribe();
				eventStats = null;
			}
		},

		abort(): void {
			abortRequested = true;
			agent.abort();
		},

		async shutdown(): Promise<void> {
			// Emit session_shutdown so extensions (MCP adapter) can close connections
			const runner = (session as any)._extensionRunner;
			if (runner) {
				try {
					await runner.emit({ type: "session_shutdown" });
				} catch (err) {
					log.warn(`[${channelId}] Extension shutdown error: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Runner cache
// ---------------------------------------------------------------------------

const channelRunners = new Map<string, ChannelRunner>();

/**
 * Get or create a ChannelRunner for a channel.
 * Runners are cached — one per channel, persistent across messages.
 */
export async function getOrCreateRunner(
	channelId: string,
	channelDir: string,
	workingDir: string,
): Promise<ChannelRunner> {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = await createChannelRunner({ channelId, channelDir, workingDir });
	channelRunners.set(channelId, runner);
	return runner;
}

/**
 * Shut down all cached channel runners.
 * Emits session_shutdown to extensions so MCP servers can close connections.
 */
export async function shutdownAllRunners(): Promise<void> {
	const runners = Array.from(channelRunners.values());
	await Promise.allSettled(runners.map((r) => r.shutdown()));
}

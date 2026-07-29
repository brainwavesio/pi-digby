import { readFileSync, statSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

export interface DigbyConfig {
	slack?: {
		/**
		 * Per-channel reply behaviour.
		 * - "mention"  (default) — only respond to @mentions and bot-owned threads
		 * - "channel"  — process all messages, reply at channel level
		 * - "thread"   — process all messages, always reply in a thread
		 */
		replyBehaviour?: Record<string, "mention" | "channel" | "thread">;
	};
	/** Post tool calls/thinking to thread under bot's message (default: false) */
	debugThreading?: boolean;
	/** Maximum time (seconds) a single run can take before being aborted (default: 600) */
	runTimeout?: number;
	/** Seconds before hard timeout at which a steering warning is injected (default: 60) */
	runTimeoutWarnBeforeS?: number;
	/**
	 * Model to use, as "provider/modelId".
	 * e.g. "amazon-bedrock/us.anthropic.claude-opus-5"
	 * Defaults to "amazon-bedrock/us.anthropic.claude-sonnet-4-6".
	 */
	model?: string;
	/**
	 * Thinking/reasoning level for the model.
	 * One of: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
	 * Defaults to "off".
	 */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

// Hot-reload: re-read digby.json at most every 2 minutes, or when mtime changes.
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_S = 360;

let cached: DigbyConfig | null = null;
let configDir: string | null = null;
let lastCheckedAt = 0;
let lastMtime = 0;

export function initConfig(workingDir: string): void {
	configDir = workingDir;
	cached = null;
	lastCheckedAt = 0;
	lastMtime = 0;
}

export function loadConfig(): DigbyConfig {
	if (!configDir) return {};

	const now = Date.now();
	if (cached && now - lastCheckedAt < CACHE_TTL_MS) {
		return cached;
	}

	const configPath = join(configDir, "digby.json");
	try {
		const mtime = statSync(configPath).mtimeMs;
		lastCheckedAt = now;
		if (cached && mtime === lastMtime) return cached;

		cached = JSON.parse(readFileSync(configPath, "utf-8")) as DigbyConfig;
		lastMtime = mtime;
	} catch {
		lastCheckedAt = now;
		cached = cached ?? {};
	}

	return cached!;
}

export function getReplyBehaviour(channelId: string): "mention" | "channel" | "thread" {
	return loadConfig().slack?.replyBehaviour?.[channelId] ?? "mention";
}

export function shouldProcessAllMessages(channelId: string): boolean {
	const b = getReplyBehaviour(channelId);
	return b === "channel" || b === "thread";
}

export function shouldReplyInThread(channelId: string): boolean {
	return getReplyBehaviour(channelId) === "thread";
}

export function isDebugThreadingEnabled(): boolean {
	return loadConfig().debugThreading ?? false;
}

export function getRunTimeout(): number {
	return loadConfig().runTimeout ?? DEFAULT_RUN_TIMEOUT_S;
}

export function getRunTimeoutWarnBeforeS(): number {
	return loadConfig().runTimeoutWarnBeforeS ?? 60;
}

export const DEFAULT_MODEL = "amazon-bedrock/us.anthropic.claude-sonnet-4-6";
const DEFAULT_THINKING_LEVEL = "off" as const;
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function getModelConfig(): { provider: string; modelId: string } {
	const raw = loadConfig().model ?? DEFAULT_MODEL;
	const idx = raw.indexOf("/");
	if (idx < 0) {
		log.warn(`Invalid model config "${raw}" — expected "provider/modelId". Falling back to default.`);
		const fallbackIdx = DEFAULT_MODEL.indexOf("/");
		return { provider: DEFAULT_MODEL.slice(0, fallbackIdx), modelId: DEFAULT_MODEL.slice(fallbackIdx + 1) };
	}
	return { provider: raw.slice(0, idx), modelId: raw.slice(idx + 1) };
}

export function getThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
	const level = loadConfig().thinkingLevel;
	if (level !== undefined && !VALID_THINKING_LEVELS.has(level)) {
		log.warn(`Invalid thinkingLevel "${level}" in digby.json. Falling back to "${DEFAULT_THINKING_LEVEL}".`);
		return DEFAULT_THINKING_LEVEL;
	}
	return level ?? DEFAULT_THINKING_LEVEL;
}

import { readFileSync, statSync } from "fs";
import { join } from "path";

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
}

// Hot-reload: re-read digby.json at most every 2 minutes, or when mtime changes.
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_S = 300;

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

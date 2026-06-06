import { readFileSync, statSync } from "fs";
import { join } from "path";

export type ReplyBehaviour = "mention" | "channel" | "thread";

export interface DigbyConfig {
	/**
	 * Per-channel reply behaviour.
	 *
	 * Key: Slack channel/DM ID (e.g. "C0AB3CQSSSZ") or "dm" for all DMs.
	 * Value:
	 *   "mention" (default) — only respond to @mentions and bot-owned threads
	 *   "channel"           — respond to all messages; replies at channel level
	 *   "thread"            — respond to all messages; replies always in a thread
	 *
	 * Legacy array shorthands (deprecated, still supported):
	 *   processAllMessageChannels → equivalent to "channel" behaviour
	 */
	replyBehaviour?: Record<string, ReplyBehaviour>;
	/** @deprecated Use replyBehaviour instead */
	slack?: {
		processAllMessageChannels?: string[];
	};
	/** Post tool calls/thinking to thread under bot's message (default: false) */
	debugThreading?: boolean;
	/** Maximum time (seconds) a single run can take before being aborted (default: 600) */
	runTimeout?: number;
}

// Hot-reload: re-read digby.json at most every 2 minutes, or when mtime changes.
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_S = 1200;

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

export function getReplyBehaviour(channelId: string): ReplyBehaviour {
	const config = loadConfig();

	// New-style: replyBehaviour map
	const behaviour = config.replyBehaviour?.[channelId];
	if (behaviour) return behaviour;

	// Legacy: processAllMessageChannels → "channel"
	if (config.slack?.processAllMessageChannels?.includes(channelId)) return "channel";

	return "mention";
}

/** True if the bot should respond to all messages in this channel (not just @mentions) */
export function shouldProcessAllMessages(channelId: string): boolean {
	const b = getReplyBehaviour(channelId);
	return b === "channel" || b === "thread";
}

/** True if the bot should always reply in a thread (never at channel level) */
export function shouldReplyInThread(channelId: string): boolean {
	return getReplyBehaviour(channelId) === "thread";
}

export function isDebugThreadingEnabled(): boolean {
	return loadConfig().debugThreading ?? false;
}

export function getRunTimeout(): number {
	return loadConfig().runTimeout ?? DEFAULT_RUN_TIMEOUT_S;
}

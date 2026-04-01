import { readFileSync, statSync } from "fs";
import { join } from "path";

export interface PiConfig {
	slack?: {
		/**
		 * Channel IDs where all messages are processed (not just @mentions).
		 * Useful for feed/dump channels where the bot monitors everything.
		 */
		processAllMessageChannels?: string[];
	};
	/** Post tool calls/thinking to thread under bot's message (default: false) */
	debugThreading?: boolean;
	/** Maximum time (in seconds) a single run can take before being aborted (default: 600 = 10 minutes) */
	runTimeout?: number;
}

// Hot-reload: re-read digby.json at most every 2 minutes, or when mtime changes.
const CACHE_TTL_MS = 2 * 60 * 1000;

let cached: PiConfig | null = null;
let configDir: string | null = null;
let lastCheckedAt = 0;
let lastMtime = 0;

export function initConfig(workingDir: string): void {
	configDir = workingDir;
	cached = null;
	lastCheckedAt = 0;
	lastMtime = 0;
}

export function loadPiConfig(): PiConfig {
	if (!configDir) return {};

	const now = Date.now();

	// Only stat the file if cache TTL has expired
	if (cached && now - lastCheckedAt < CACHE_TTL_MS) {
		return cached;
	}

	const configPath = join(configDir, "digby.json");

	try {
		const mtime = statSync(configPath).mtimeMs;
		lastCheckedAt = now;

		// File hasn't changed — keep cached value
		if (cached && mtime === lastMtime) {
			return cached;
		}

		// File changed (or first load) — re-read
		cached = JSON.parse(readFileSync(configPath, "utf-8")) as PiConfig;
		lastMtime = mtime;
	} catch (e) {
		console.warn(`[config] Failed to load digby.json from ${configDir}: ${e}`);
		lastCheckedAt = now;
		cached = cached ?? {}; // keep stale cache on read error rather than resetting
	}

	return cached!;
}

export function shouldProcessAllMessages(channelId: string): boolean {
	const config = loadPiConfig();
	return config.slack?.processAllMessageChannels?.includes(channelId) ?? false;
}

export function isDebugThreadingEnabled(): boolean {
	return loadPiConfig().debugThreading ?? false;
}

const DEFAULT_RUN_TIMEOUT_S = 600; // 10 minutes

export function getRunTimeout(): number {
	return loadPiConfig().runTimeout ?? DEFAULT_RUN_TIMEOUT_S;
}

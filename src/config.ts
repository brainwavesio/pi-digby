import { readFileSync, statSync } from "fs";
import { join } from "path";

export interface DigbyConfig {
	slack?: {
		/** Channel IDs where all messages are processed (not just @mentions). */
		processAllMessageChannels?: string[];
	};
	/** Post tool calls/thinking to thread under bot's message (default: false) */
	debugThreading?: boolean;
	/** Maximum time (seconds) a single run can take before being aborted (default: 3600) */
	runTimeout?: number;
	/** Maximum time (seconds) between steps (tool calls / model turns) before aborting (default: 900) */
	stepTimeout?: number;
}

// Hot-reload: re-read digby.json at most every 2 minutes, or when mtime changes.
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_S = 3600;  // safety net — per-step timeout is the real guard
const DEFAULT_STEP_TIMEOUT_S = 900;  // abort if no progress for 15 minutes

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

export function shouldProcessAllMessages(channelId: string): boolean {
	return loadConfig().slack?.processAllMessageChannels?.includes(channelId) ?? false;
}

export function isDebugThreadingEnabled(): boolean {
	return loadConfig().debugThreading ?? false;
}

export function getRunTimeout(): number {
	return loadConfig().runTimeout ?? DEFAULT_RUN_TIMEOUT_S;
}

export function getStepTimeout(): number {
	return loadConfig().stepTimeout ?? DEFAULT_STEP_TIMEOUT_S;
}

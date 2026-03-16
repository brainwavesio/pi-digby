import { readFileSync } from "fs";
import { join } from "path";

export interface PiConfig {
	slack?: {
		/**
		 * Channel IDs where all messages are processed (not just @mentions).
		 * Useful for feed/dump channels where the bot monitors everything.
		 */
		processAllMessageChannels?: string[];
	};
}

let cached: PiConfig | null = null;
let configDir: string | null = null;

export function initConfig(workingDir: string): void {
	configDir = workingDir;
	cached = null;
}

export function loadPiConfig(): PiConfig {
	if (cached) return cached;

	if (!configDir) {
		cached = {};
		return cached;
	}

	try {
		const data = readFileSync(join(configDir, "digby.json"), "utf-8");
		cached = JSON.parse(data) as PiConfig;
	} catch {
		cached = {};
	}

	return cached;
}

export function shouldProcessAllMessages(channelId: string): boolean {
	const config = loadPiConfig();
	return config.slack?.processAllMessageChannels?.includes(channelId) ?? false;
}

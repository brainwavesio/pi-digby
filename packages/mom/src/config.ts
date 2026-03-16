import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
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

export function loadPiConfig(): PiConfig {
	if (cached) return cached;

	const configPath = join(homedir(), ".pi", "config.json");
	if (!existsSync(configPath)) {
		cached = {};
		return cached;
	}

	try {
		const data = readFileSync(configPath, "utf-8");
		cached = JSON.parse(data) as PiConfig;
	} catch (e) {
		console.error(`[config] Failed to parse ~/.pi/config.json: ${e}`);
		cached = {};
	}

	return cached;
}

export function shouldProcessAllMessages(channelId: string): boolean {
	const config = loadPiConfig();
	return config.slack?.processAllMessageChannels?.includes(channelId) ?? false;
}

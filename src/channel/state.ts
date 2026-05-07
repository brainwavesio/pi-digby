import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { BotEvent } from "../types.js";

export class ChannelState {
	readonly channelId: string;
	readonly channelDir: string;
	readonly workingDir: string;

	constructor(channelId: string, workingDir: string) {
		this.channelId = channelId;
		this.workingDir = workingDir;
		this.channelDir = join(workingDir, channelId);
		if (!existsSync(this.channelDir)) {
			mkdirSync(this.channelDir, { recursive: true });
		}
	}

	/** Append a JSON line to log.jsonl */
	appendLog(entry: object): void {
		appendFileSync(join(this.channelDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/** Log a user message */
	logUserMessage(event: BotEvent, userName?: string, displayName?: string): void {
		const threadTs = event.threadTs && event.threadTs !== event.ts ? event.threadTs : undefined;
		this.appendLog({
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			...(threadTs && { threadTs }),
			user: event.user,
			userName,
			displayName,
			text: event.text,
			attachments: event.attachments || [],
			isBot: false,
		});
	}

	/** Log a bot response */
	logBotResponse(text: string, ts: string, threadTs?: string): void {
		this.appendLog({
			date: new Date().toISOString(),
			ts,
			...(threadTs && { threadTs }),
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/** Check if log.jsonl exists (channel has prior history) */
	hasLog(): boolean {
		return existsSync(join(this.channelDir, "log.jsonl"));
	}

	/** Get all timestamps from log.jsonl for dedup */
	getLogTimestamps(): Set<string> {
		const logPath = join(this.channelDir, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;
		const content = readFileSync(logPath, "utf-8");
		for (const line of content.trim().split("\n").filter(Boolean)) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {
				// skip malformed lines
			}
		}
		return timestamps;
	}

	/** Get timestamps already logged for a specific Slack thread. */
	getLogTimestampsForThread(threadTs: string): Set<string> {
		const logPath = join(this.channelDir, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;
		const content = readFileSync(logPath, "utf-8");
		for (const line of content.trim().split("\n").filter(Boolean)) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts === threadTs || entry.threadTs === threadTs) timestamps.add(entry.ts);
			} catch {
				// skip malformed lines
			}
		}
		return timestamps;
	}
}

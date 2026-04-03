/**
 * Sync user messages from log.jsonl into SessionManager context.
 *
 * This ensures messages logged while the bot was offline or busy
 * (channel chatter, backfilled messages) are added to the LLM context.
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface LogMessage {
	date?: string;
	ts?: string;
	threadTs?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * Reads log.jsonl, finds non-bot messages not already in the session context,
 * and appends them as user messages. Skips the current triggering message
 * (which will be added via prompt()).
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param currentTs - Slack timestamp of the current message (skip, added via prompt())
 * @param currentThreadTs - Thread timestamp if the current message is in a thread
 * @returns Number of messages synced
 */
export function syncLogToContext(
	sessionManager: SessionManager,
	channelDir: string,
	currentTs: string,
	_currentThreadTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");
	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session for dedup
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					existingMessages.add(normalizeMessageText(content));
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							existingMessages.add(normalizeMessageText((part as { type: "text"; text: string }).text));
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// Skip the current message being processed (will be added via prompt())
			if (slackTs === currentTs) continue;

			// Skip bot messages — those are added through the agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

/**
 * Strip timestamp prefix and attachment section for comparison.
 * Live messages have format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
 * Synced messages have format: [username]: text
 */
function normalizeMessageText(text: string): string {
	let normalized = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
	const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
	if (attachmentsIdx !== -1) {
		normalized = normalized.substring(0, attachmentsIdx);
	}
	return normalized;
}

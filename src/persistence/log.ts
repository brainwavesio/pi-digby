/**
 * Sync visible log messages from log.jsonl into SessionManager context.
 *
 * This ensures messages logged while the bot was offline or busy
 * (channel chatter, backfilled messages) are added to the LLM context.
 */

import type { UserMessage } from "@earendil-works/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface LogMessage {
	date?: string;
	ts?: string;
	threadTs?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

export type LogContextScope =
	| { source: "linear"; kind: "chronological" }
	| { source: "slack"; kind: "channel" }
	| { source: "slack"; kind: "thread"; rootTs: string };

export interface SelectedContextMessage {
	id: string;
	timestamp: number;
	text: string;
	isBot?: boolean;
}

interface SelectLogMessagesOptions {
	currentTs: string;
	scope: LogContextScope;
}

const SLACK_THREAD_BOUNDARY_PREFIX = "Slack thread boundary";

function parseSlackTs(ts: string | undefined): number | null {
	if (!ts) return null;
	const parsed = Number.parseFloat(ts);
	return Number.isFinite(parsed) ? parsed : null;
}

function compareSlackTs(a: string | undefined, b: string | undefined): number {
	const aNum = parseSlackTs(a);
	const bNum = parseSlackTs(b);
	if (aNum === null || bNum === null) return 0;
	return aNum - bNum;
}

function timestampForMessage(logMsg: LogMessage): number {
	const slackTs = parseSlackTs(logMsg.ts);
	if (slackTs !== null) return slackTs * 1000;
	if (logMsg.date) {
		const dateMs = new Date(logMsg.date).getTime();
		if (!Number.isNaN(dateMs)) return dateMs;
	}
	return Date.now();
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function displayName(logMsg: LogMessage): string {
	if (logMsg.isBot && logMsg.user === "bot") return "digby";
	return logMsg.userName || logMsg.user || "unknown";
}

export function formatLogMessageForContext(source: "linear" | "slack", logMsg: LogMessage): string {
	const ts = logMsg.ts || "unknown";
	const attrs = [`ts="${escapeAttribute(ts)}"`];
	if (source === "slack" && logMsg.threadTs) attrs.push(`thread_ts="${escapeAttribute(logMsg.threadTs)}"`);
	const user = displayName(logMsg);
	attrs.push(`user="${escapeAttribute(user)}"`);
	const tag = source === "slack" ? "slack_message" : "linear_message";
	return `<${tag} ${attrs.join(" ")}>\n[${user}]: ${logMsg.text || ""}\n</${tag}>`;
}

export function formatSlackThreadBoundary(rootTs: string): SelectedContextMessage {
	const rootTimestamp = (parseSlackTs(rootTs) ?? Date.now() / 1000) * 1000;
	return {
		id: `slack-thread-boundary:${rootTs}`,
		// Slack timestamps are microsecond precision; this keeps the boundary after
		// any message strictly before the root while still sorting before the root.
		timestamp: rootTimestamp - 0.0005,
		text: `<slack_thread_boundary root_ts="${escapeAttribute(rootTs)}">\nSystem note: ${SLACK_THREAD_BOUNDARY_PREFIX}. The next Slack message is the root message of this thread. Do not treat later top-level channel messages as visible in this thread; only replies with this thread timestamp are part of the thread after the root.\n</slack_thread_boundary>`,
	};
}

function contextMessageFromLog(source: "linear" | "slack", logMsg: LogMessage): SelectedContextMessage {
	const ts = logMsg.ts || `missing-ts:${timestampForMessage(logMsg)}`;
	return {
		id: `${source}:${ts}`,
		timestamp: timestampForMessage(logMsg),
		text: formatLogMessageForContext(source, logMsg),
		isBot: logMsg.isBot,
	};
}

function sortLogMessages(messages: LogMessage[]): LogMessage[] {
	return [...messages].sort((a, b) => timestampForMessage(a) - timestampForMessage(b));
}

function messageCompletenessScore(logMsg: LogMessage): number {
	return (
		(logMsg.threadTs ? 32 : 0) +
		(logMsg.date ? 16 : 0) +
		(logMsg.text ? 8 : 0) +
		(logMsg.userName ? 4 : 0) +
		(logMsg.user ? 2 : 0) +
		(logMsg.isBot !== undefined ? 1 : 0)
	);
}

function mergeLogMessage(primary: LogMessage, secondary: LogMessage): LogMessage {
	return {
		...secondary,
		...primary,
		isBot: primary.isBot ?? secondary.isBot,
	};
}

function dedupeLogMessagesByTs(messages: LogMessage[]): LogMessage[] {
	const deduped: LogMessage[] = [];
	const byTs = new Map<string, number>();

	for (const logMsg of messages) {
		if (!logMsg.ts) {
			deduped.push(logMsg);
			continue;
		}

		const existingIndex = byTs.get(logMsg.ts);
		if (existingIndex === undefined) {
			byTs.set(logMsg.ts, deduped.length);
			deduped.push(logMsg);
			continue;
		}

		const existing = deduped[existingIndex];
		const preferred =
			messageCompletenessScore(logMsg) >= messageCompletenessScore(existing)
				? mergeLogMessage(logMsg, existing)
				: mergeLogMessage(existing, logMsg);
		deduped[existingIndex] = preferred;
	}

	return deduped;
}

function isBeforeCurrent(logMsg: LogMessage, currentTs: string): boolean {
	return !!logMsg.ts && compareSlackTs(logMsg.ts, currentTs) < 0;
}

function isTopLevelSlackMessage(logMsg: LogMessage): boolean {
	return !logMsg.threadTs || logMsg.threadTs === logMsg.ts;
}

function selectSlackChannelMessages(messages: LogMessage[], currentTs: string): SelectedContextMessage[] {
	return sortLogMessages(messages)
		.filter((logMsg) => isBeforeCurrent(logMsg, currentTs))
		.filter(isTopLevelSlackMessage)
		.map((logMsg) => contextMessageFromLog("slack", logMsg));
}

function selectSlackThreadMessages(
	messages: LogMessage[],
	currentTs: string,
	rootTs: string,
): SelectedContextMessage[] {
	const beforeRoot = sortLogMessages(messages)
		.filter((logMsg) => isBeforeCurrent(logMsg, rootTs))
		.filter((logMsg) => !logMsg.isBot)
		.filter(isTopLevelSlackMessage)
		.map((logMsg) => contextMessageFromLog("slack", logMsg));

	const root = sortLogMessages(messages)
		.filter((logMsg) => isBeforeCurrent(logMsg, currentTs))
		.filter((logMsg) => logMsg.ts === rootTs)
		.map((logMsg) => contextMessageFromLog("slack", logMsg));

	const threadReplies = sortLogMessages(messages)
		.filter((logMsg) => isBeforeCurrent(logMsg, currentTs))
		.filter((logMsg) => logMsg.ts !== rootTs)
		.filter((logMsg) => logMsg.threadTs === rootTs)
		.map((logMsg) => contextMessageFromLog("slack", logMsg));

	return [...beforeRoot, formatSlackThreadBoundary(rootTs), ...root, ...threadReplies];
}

function selectLinearMessages(messages: LogMessage[], currentTs: string): SelectedContextMessage[] {
	return sortLogMessages(messages)
		.filter((logMsg) => isBeforeCurrent(logMsg, currentTs))
		.filter((logMsg) => !logMsg.isBot)
		.map((logMsg) => contextMessageFromLog("linear", logMsg));
}

export function selectLogMessagesForContext(
	messages: LogMessage[],
	options: SelectLogMessagesOptions,
): SelectedContextMessage[] {
	if (options.scope.source === "linear") {
		return selectLinearMessages(messages, options.currentTs);
	}
	const dedupedMessages = dedupeLogMessagesByTs(messages);
	if (options.scope.kind === "channel") {
		return selectSlackChannelMessages(dedupedMessages, options.currentTs);
	}
	return selectSlackThreadMessages(dedupedMessages, options.currentTs, options.scope.rootTs);
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * Reads log.jsonl, selects messages visible to the current surface/scope,
 * and appends anything not already in the session context. Skips the current
 * triggering message (which will be added via prompt()).
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param currentTs - Surface timestamp of the current message (skip, added via prompt())
 * @param scope - Surface-specific visibility rules for this run
 * @returns Number of messages synced
 */
export function syncLogToContext(
	sessionManager: SessionManager,
	channelDir: string,
	currentTs: string,
	scope: LogContextScope = { source: "slack", kind: "channel" },
): number {
	const logFile = join(channelDir, "log.jsonl");
	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session for dedup
	const existingLegacyMessages = new Set<string>();
	const existingContextIds = new Set<string>();
	let hasAssistantInSession = false;
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "assistant") {
				hasAssistantInSession = true;
			}
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					const contextIds = extractContextIds(content);
					for (const id of contextIds) existingContextIds.add(id);
					if (contextIds.length === 0) existingLegacyMessages.add(normalizeMessageText(content));
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							const text = (part as { type: "text"; text: string }).text;
							const contextIds = extractContextIds(text);
							for (const id of contextIds) existingContextIds.add(id);
							if (contextIds.length === 0) existingLegacyMessages.add(normalizeMessageText(text));
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const logMessages: LogMessage[] = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;
			logMessages.push(logMsg);
		} catch {
			// Skip malformed lines
		}
	}

	const selected = selectLogMessagesForContext(logMessages, { currentTs, scope });
	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const selectedMessage of selected) {
		if (selectedMessage.isBot && hasAssistantInSession) continue;
		if (existingContextIds.has(selectedMessage.id)) continue;
		if (existingLegacyMessages.has(normalizeMessageText(selectedMessage.text))) continue;

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: selectedMessage.text }],
			timestamp: selectedMessage.timestamp,
		};

		newMessages.push({ timestamp: selectedMessage.timestamp, message: userMessage });
		existingContextIds.add(selectedMessage.id);
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
	const wrappedMessage = normalized.match(/^<((?:slack|linear)_message)\b[^>]*>\n([\s\S]*?)\n<\/\1>/);
	if (wrappedMessage) {
		normalized = wrappedMessage[2];
	}
	const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
	if (attachmentsIdx !== -1) {
		normalized = normalized.substring(0, attachmentsIdx);
	}
	const genericAttachmentsIdx = normalized.indexOf("\n\n<attachments>\n");
	if (genericAttachmentsIdx !== -1) {
		normalized = normalized.substring(0, genericAttachmentsIdx);
	}
	return normalized;
}

function extractContextIds(text: string): string[] {
	const ids: string[] = [];

	for (const match of text.matchAll(/<slack_message\s+[^>]*ts="([^"]+)"/g)) {
		ids.push(`slack:${match[1]}`);
	}
	for (const match of text.matchAll(/<linear_message\s+[^>]*ts="([^"]+)"/g)) {
		ids.push(`linear:${match[1]}`);
	}
	for (const match of text.matchAll(/<slack_thread_boundary\s+root_ts="([^"]+)"/g)) {
		ids.push(`slack-thread-boundary:${match[1]}`);
	}

	return ids;
}

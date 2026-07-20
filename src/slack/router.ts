import QuickLRU from "quick-lru";
import { shouldProcessAllMessages, shouldReplyInThread } from "../config.js";
import * as log from "../log.js";
import type { SlackClient } from "./client.js";
import type { SlackEvent } from "./types.js";

const DEFAULT_SUGGESTED_PROMPTS = [
	{ title: "Linear cycle report", message: "Give me a summary of the current Linear cycle" },
	{ title: "Recent errors", message: "Any new errors in #errors in the last 24h?" },
	{ title: "Morning digest", message: "What's new since yesterday?" },
	{ title: "Draft a ticket", message: "Create a Linear ticket for: " },
];

export interface RouterHandler {
	/** Check if this event's conversation lane is currently busy (SYNC) */
	isBusy(event: SlackEvent): boolean;
	/** Handle an event that triggers the bot (ASYNC) */
	handleEvent(event: SlackEvent, isEvent?: boolean): Promise<void>;
	/** Handle stop command */
	handleStop(event: SlackEvent): Promise<void>;
	/** Log a message to log.jsonl without triggering a run */
	logMessage(event: SlackEvent): void;
}

type DuplicateChecker = (channel: string, ts: string) => boolean;

function createDuplicateChecker(): DuplicateChecker {
	// Dedup incoming Slack events by channel:ts — Slack replays events on reconnect.
	// QuickLRU evicts oldest entries once maxSize is reached.
	const seenEvents = new QuickLRU<string, true>({ maxSize: 100 });

	return (channel: string, ts: string): boolean => {
		const key = `${channel}:${ts}`;
		if (seenEvents.has(key)) return true;
		seenEvents.set(key, true);
		return false;
	};
}

/**
 * Routes Slack events to the appropriate handler.
 * Classifies events, deduplicates, and handles busy/stop states.
 */
export function setupRouter(client: SlackClient, handler: RouterHandler, startupTs: string): void {
	const botUserId = client.getBotUserId();
	const isDuplicate = createDuplicateChecker();
	// Tracks threads where the bot was @mentioned in a reply (not necessarily the root).
	// Key: "channel:thread_ts". In-memory only; repopulated on restart via first @mention.
	const mentionedThreads = new QuickLRU<string, true>({ maxSize: 500 });

	// ===== Suggested prompts on thread open =====
	client.onAssistantThreadStarted((event) => {
		const e = event as { assistant_thread?: { channel_id?: string; thread_ts?: string } };
		const channel = e.assistant_thread?.channel_id;
		const threadTs = e.assistant_thread?.thread_ts;
		if (!channel || !threadTs) return;

		client.setSuggestedPrompts(channel, threadTs, "What can I help with?", DEFAULT_SUGGESTED_PROMPTS).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("missing_scope")) {
				log.info("setSuggestedPrompts: missing_scope (assistant:write scope not yet provisioned)");
			} else {
				log.warn("Failed to set suggested prompts", msg);
			}
		});
	});

	// ===== Channel @mentions =====
	client.onAppMention((event) => {
		const e = event as {
			text: string;
			channel: string;
			user: string;
			ts: string;
			thread_ts?: string;
			files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
		};

		// Skip DMs (handled by message event)
		if (e.channel.startsWith("D")) return;

		// In processAllMessages channels, the message handler covers everything —
		// EXCEPT @mentions, which should always be processed regardless.
		// (The message handler skips non-bot-thread messages in these channels,
		// so an @mention in a thread we don't own would otherwise be silently dropped.)

		const slackEvent: SlackEvent = {
			type: "mention",
			source: "slack",
			channel: e.channel,
			ts: e.ts,
			user: e.user,
			text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: e.files,
			threadTs: e.thread_ts,
		};

		// Only trigger processing for messages after startup
		if (e.ts < startupTs) {
			log.info(`[${e.channel}] Skipping old mention (pre-startup)`);
			return;
		}

		// Track threads where the bot is @mentioned in a reply so subsequent
		// messages in that thread trigger the bot without another @mention.
		if (e.thread_ts) {
			mentionedThreads.set(`${e.channel}:${e.thread_ts}`, true);
		}

		processOrBusy(client, handler, slackEvent, e.channel, isDuplicate);
	});

	// ===== All messages (logging + DMs + bot-thread replies) =====
	client.onMessage((event) => {
		const e = event as {
			text?: string;
			channel: string;
			user?: string;
			ts: string;
			thread_ts?: string;
			channel_type?: string;
			subtype?: string;
			bot_id?: string;
			files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
		};

		// Skip our own messages and non-message subtypes
		if (e.user === botUserId) return;
		if (!e.user && !e.bot_id) return;
		if (e.subtype !== undefined && e.subtype !== "file_share" && e.subtype !== "bot_message") return;
		if (!e.text && (!e.files || e.files.length === 0)) return;

		// Other bots (Linear, etc.) — log but never trigger runs
		if (e.bot_id) {
			const slackEvent: SlackEvent = {
				type: "channel",
				source: "slack",
				channel: e.channel,
				ts: e.ts,
				user: e.user || e.bot_id,
				text: e.text || "",
				files: e.files,
				threadTs: e.thread_ts,
			};
			handler.logMessage(slackEvent);
			return;
		}

		const isDm = e.channel_type === "im" || e.channel_type === "mpim";
		const isAlwaysChannel = shouldProcessAllMessages(e.channel) || shouldReplyInThread(e.channel);
		const isChannelThread = !isDm && !!e.thread_ts;

		// At this point e.user must exist: bot messages (bot_id) already returned,
		// and messages with neither user nor bot_id were filtered above.
		const slackEvent: SlackEvent = {
			type: isDm ? "dm" : "channel",
			source: "slack",
			channel: e.channel,
			ts: e.ts,
			user: e.user!,
			text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
			files: e.files,
			threadTs: e.thread_ts,
		};

		// Non-triggering channel messages — log but don't process
		if (!isDm && !isAlwaysChannel && !isChannelThread) {
			handler.logMessage(slackEvent);
			return;
		}

		// Skip old messages
		if (e.ts < startupTs) return;

		// In processAllMessages channels, skip non-threaded messages that @mention the bot —
		// app_mention will handle those to avoid double-responses.
		if (isAlwaysChannel && !e.thread_ts) {
			const text = e.text || "";
			const botMentioned = !!botUserId && text.includes(`<@${botUserId}>`);
			if (botMentioned) {
				handler.logMessage(slackEvent);
				return;
			}
		}

		if (isChannelThread) {
			// In bot-owned threads: trigger unless another user (not bot) is mentioned
			const text = e.text || "";
			const botMentioned = !!botUserId && text.includes(`<@${botUserId}>`);
			const anyMention = /<@[A-Z0-9]+>/i.test(text);
			if (!botMentioned && anyMention) {
				handler.logMessage(slackEvent);
				return;
			}

			// Fast path: bot was @mentioned in this thread previously — treat as bot-active.
			if (mentionedThreads.has(`${e.channel}:${e.thread_ts!}`)) {
				processOrBusy(client, handler, slackEvent, e.channel, isDuplicate);
				return;
			}

			client
				.isBotThread(e.channel, e.thread_ts!)
				.then((owned) => {
					if (owned) {
						processOrBusy(client, handler, slackEvent, e.channel, isDuplicate);
					} else {
						handler.logMessage(slackEvent);
					}
				})
				.catch(() => {
					// Ignore lookup errors — thread messages are best-effort
				});
			return;
		}

		processOrBusy(client, handler, slackEvent, e.channel, isDuplicate);
	});
}

function processOrBusy(
	client: SlackClient,
	handler: RouterHandler,
	event: SlackEvent,
	channel: string,
	isDuplicate: DuplicateChecker,
): void {
	if (isDuplicate(channel, event.ts)) {
		log.info(`[${channel}] Dropping duplicate event ts=${event.ts}`);
		return;
	}

	const text = event.text.toLowerCase().trim();

	// Stop command — log and execute immediately, don't queue
	if (text === "stop") {
		handler.logMessage(event);
		handler.handleStop(event).catch((err) => {
			log.warn(`Stop handler error [${channel}]`, err instanceof Error ? err.message : String(err));
		});
		return;
	}

	// Check if busy — acknowledge and hand off so the channel adapter can queue it.
	if (handler.isBusy(event)) {
		handler.handleEvent(event).catch((err) => {
			log.warn(`Queued handler error [${channel}]`, err instanceof Error ? err.message : String(err));
		});
		const queuedMsg =
			event.type === "mention"
				? "_Queued. Say `@digby stop` to cancel the current run._"
				: "_Queued. Say `stop` to cancel the current run._";
		client.postMessage(channel, queuedMsg, event.threadTs).catch((err) => {
			log.warn("Failed to post queued message", err instanceof Error ? err.message : String(err));
		});
		return;
	}

	// Route to handler
	handler.handleEvent(event).catch((err) => {
		log.warn(`Handler error [${channel}]`, err instanceof Error ? err.message : String(err));
	});
}

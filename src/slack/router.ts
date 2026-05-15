import QuickLRU from "quick-lru";
import { shouldProcessAllMessages } from "../config.js";
import * as log from "../log.js";
import type { SlackClient } from "./client.js";
import type { SlackEvent } from "./types.js";

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

		// Skip channels where message handler processes everything
		if (shouldProcessAllMessages(e.channel)) return;

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
		const isAlwaysChannel = shouldProcessAllMessages(e.channel);
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

		if (isChannelThread) {
			// In bot-owned threads: trigger unless another user (not bot) is mentioned
			const text = e.text || "";
			const botMentioned = !!botUserId && text.includes(`<@${botUserId}>`);
			const anyMention = /<@[A-Z0-9]+>/i.test(text);
			if (!botMentioned && anyMention) {
				handler.logMessage(slackEvent);
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

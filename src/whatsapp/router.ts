import QuickLRU from "quick-lru";
import * as log from "../log.js";
import { channelIdToJid, type WhatsAppClient } from "./client.js";
import type { WhatsAppEvent } from "./types.js";

export interface WhatsAppRouterHandler {
	isBusy(event: WhatsAppEvent): boolean;
	handleEvent(event: WhatsAppEvent): Promise<void>;
	handleStop(event: WhatsAppEvent): Promise<void>;
	logMessage(event: WhatsAppEvent): void;
}

type DuplicateChecker = (channel: string, ts: string) => boolean;

function createDuplicateChecker(): DuplicateChecker {
	const seenEvents = new QuickLRU<string, true>({ maxSize: 100 });

	return (channel: string, ts: string): boolean => {
		const key = `${channel}:${ts}`;
		if (seenEvents.has(key)) return true;
		seenEvents.set(key, true);
		return false;
	};
}

export function setupWhatsAppRouter(
	client: WhatsAppClient,
	handler: WhatsAppRouterHandler,
	startupTs: string,
): void {
	const isDuplicate = createDuplicateChecker();

	client.onMessage((event) => {
		if (event.ts < startupTs) {
			log.info(`[${event.channel}] Skipping old WhatsApp message (pre-startup)`);
			return;
		}

		processOrBusy(client, handler, event, isDuplicate);
	});
}

function processOrBusy(
	client: WhatsAppClient,
	handler: WhatsAppRouterHandler,
	event: WhatsAppEvent,
	isDuplicate: DuplicateChecker,
): void {
	if (isDuplicate(event.channel, event.ts)) {
		log.info(`[${event.channel}] Dropping duplicate WhatsApp event ts=${event.ts}`);
		return;
	}

	const text = event.text.toLowerCase().trim();

	if (text === "stop") {
		handler.logMessage(event);
		handler.handleStop(event).catch((err) => {
			log.warn(`[${event.channel}] WhatsApp stop handler error`, err instanceof Error ? err.message : String(err));
		});
		return;
	}

	if (handler.isBusy(event)) {
		handler.handleEvent(event).catch((err) => {
			log.warn(`[${event.channel}] WhatsApp queued handler error`, err instanceof Error ? err.message : String(err));
		});

		const jid = channelIdToJid(event.channel);
		client.sendMessage(jid, "_Queued. Say `stop` to cancel the current run._").catch((err) => {
			log.warn("[WhatsApp] Failed to send queued message", err instanceof Error ? err.message : String(err));
		});
		return;
	}

	handler.handleEvent(event).catch((err) => {
		log.warn(`[${event.channel}] WhatsApp handler error`, err instanceof Error ? err.message : String(err));
	});
}

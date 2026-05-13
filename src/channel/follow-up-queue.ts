import type { BotEvent } from "../types.js";

export class FollowUpQueue {
	private readonly itemsByRunnerId = new Map<string, BotEvent[]>();

	enqueue(runnerId: string, event: BotEvent): number {
		const items = this.itemsByRunnerId.get(runnerId) ?? [];
		items.push(cloneEvent(event));
		this.itemsByRunnerId.set(runnerId, items);
		return items.length;
	}

	drain(runnerId: string): BotEvent[] {
		const items = this.itemsByRunnerId.get(runnerId);
		if (!items) return [];
		this.itemsByRunnerId.delete(runnerId);
		return items;
	}

	size(runnerId: string): number {
		return this.itemsByRunnerId.get(runnerId)?.length ?? 0;
	}
}

export function createQueuedFollowUpTrigger(events: BotEvent[], nowMs = Date.now()): BotEvent {
	if (events.length === 0) {
		throw new Error("Cannot create queued follow-up trigger without queued events");
	}

	const last = events[events.length - 1]!;
	const attachments = events.flatMap((event) => event.attachments ?? []);
	return {
		type: last.type,
		source: last.source,
		channel: last.channel,
		ts: nextTimestampAfter(events, nowMs),
		user: "system",
		text: formatQueuedFollowUpPrompt(events.length, last.source),
		...(last.threadTs && { threadTs: last.threadTs }),
		...(attachments.length > 0 && { attachments: attachments.map((attachment) => ({ ...attachment })) }),
	};
}

export function formatQueuedFollowUpPrompt(count: number, source: BotEvent["source"]): string {
	const sourceLabel = source === "slack" ? "Slack" : "Linear";
	const noun = count === 1 ? "message" : "messages";
	return `[QUEUED_MESSAGES:${count}] ${count} queued ${sourceLabel} ${noun} arrived while you were busy. They have already been added to the visible conversation context from log.jsonl. Respond to the latest queued message, taking the full queued sequence into account.`;
}

function cloneEvent(event: BotEvent): BotEvent {
	return {
		...event,
		...(event.files && { files: event.files.map((file) => ({ ...file })) }),
		...(event.attachments && { attachments: event.attachments.map((attachment) => ({ ...attachment })) }),
	};
}

function nextTimestampAfter(events: BotEvent[], nowMs: number): string {
	let latestSeconds = nowMs / 1000;
	for (const event of events) {
		const eventSeconds = Number.parseFloat(event.ts);
		if (Number.isFinite(eventSeconds)) {
			latestSeconds = Math.max(latestSeconds, eventSeconds);
		}
	}
	return (latestSeconds + 0.000001).toFixed(6);
}

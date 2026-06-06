import { join } from "path";
import { shouldReplyInThread } from "../config.js";
import type { LogContextScope } from "../persistence/log.js";
import type { SlackEvent } from "./types.js";

export interface SlackConversationTarget {
	runnerId: string;
	sessionDir: string;
	replyThreadTs?: string;
	logContextScope: LogContextScope;
}

function safePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function slackReplyThreadTs(event: SlackEvent, isEvent = false): string | undefined {
	if (isEvent) return event.threadTs;
	if (event.type === "mention") return event.threadTs ?? event.ts;
	// In replyInThread channels: always thread, using ts as root for top-level messages
	if (shouldReplyInThread(event.channel)) return event.threadTs ?? event.ts;
	return event.threadTs;
}

export function slackStopReplyThreadTs(event: SlackEvent): string | undefined {
	return event.threadTs;
}

export function getSlackConversationTarget(
	event: SlackEvent,
	channelDir: string,
	isEvent = false,
): SlackConversationTarget {
	const replyThreadTs = slackReplyThreadTs(event, isEvent);

	if (!replyThreadTs) {
		return {
			runnerId: `slack:${event.channel}:channel`,
			sessionDir: channelDir,
			logContextScope: { source: "slack", kind: "channel" },
		};
	}

	return {
		runnerId: `slack:${event.channel}:thread:${replyThreadTs}`,
		sessionDir: join(channelDir, "threads", safePathSegment(replyThreadTs)),
		replyThreadTs,
		logContextScope: { source: "slack", kind: "thread", rootTs: replyThreadTs },
	};
}

export function getSlackStopConversationTarget(event: SlackEvent, channelDir: string): SlackConversationTarget {
	const replyThreadTs = slackStopReplyThreadTs(event);

	if (!replyThreadTs) {
		return {
			runnerId: `slack:${event.channel}:channel`,
			sessionDir: channelDir,
			logContextScope: { source: "slack", kind: "channel" },
		};
	}

	return {
		runnerId: `slack:${event.channel}:thread:${replyThreadTs}`,
		sessionDir: join(channelDir, "threads", safePathSegment(replyThreadTs)),
		replyThreadTs,
		logContextScope: { source: "slack", kind: "thread", rootTs: replyThreadTs },
	};
}

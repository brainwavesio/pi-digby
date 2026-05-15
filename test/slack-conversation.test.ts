import { describe, expect, it } from "vitest";
import {
	getSlackConversationTarget,
	getSlackStopConversationTarget,
	slackReplyThreadTs,
	slackStopReplyThreadTs,
} from "../src/slack/conversation.js";
import type { SlackEvent } from "../src/slack/types.js";

function event(opts: Partial<SlackEvent> = {}): SlackEvent {
	return {
		type: "mention",
		source: "slack",
		channel: "C123",
		ts: "1700000000.000000",
		user: "U123",
		text: "hello",
		...opts,
	};
}

describe("Slack conversation targeting", () => {
	it("threads normal top-level mentions under the mention timestamp", () => {
		const slackEvent = event();
		const target = getSlackConversationTarget(slackEvent, "/tmp/C123");

		expect(slackReplyThreadTs(slackEvent)).toBe(slackEvent.ts);
		expect(target.replyThreadTs).toBe(slackEvent.ts);
		expect(target.runnerId).toBe("slack:C123:thread:1700000000.000000");
		expect(target.logContextScope).toEqual({ source: "slack", kind: "thread", rootTs: slackEvent.ts });
	});

	it("keeps channel events top-level by default", () => {
		const slackEvent = event({ user: "system", text: "[EVENT:ingest.json:periodic:* * * * *] ingest" });
		const target = getSlackConversationTarget(slackEvent, "/tmp/C123", true);

		expect(slackReplyThreadTs(slackEvent, true)).toBeUndefined();
		expect(target.replyThreadTs).toBeUndefined();
		expect(target.runnerId).toBe("slack:C123:channel");
		expect(target.sessionDir).toBe("/tmp/C123");
		expect(target.logContextScope).toEqual({ source: "slack", kind: "channel" });
	});

	it("allows events to target an existing Slack thread explicitly", () => {
		const slackEvent = event({
			user: "system",
			text: "[EVENT:thread.json:one-shot:2026-05-13T00:00:00Z] follow up",
			threadTs: "1699999999.000000",
		});
		const target = getSlackConversationTarget(slackEvent, "/tmp/C123", true);

		expect(slackReplyThreadTs(slackEvent, true)).toBe("1699999999.000000");
		expect(target.replyThreadTs).toBe("1699999999.000000");
		expect(target.runnerId).toBe("slack:C123:thread:1699999999.000000");
		expect(target.logContextScope).toEqual({ source: "slack", kind: "thread", rootTs: "1699999999.000000" });
	});

	it("targets top-level stop commands at the channel lane", () => {
		const slackEvent = event({ text: "stop" });
		const target = getSlackStopConversationTarget(slackEvent, "/tmp/C123");

		expect(slackStopReplyThreadTs(slackEvent)).toBeUndefined();
		expect(target.replyThreadTs).toBeUndefined();
		expect(target.runnerId).toBe("slack:C123:channel");
		expect(target.sessionDir).toBe("/tmp/C123");
		expect(target.logContextScope).toEqual({ source: "slack", kind: "channel" });
	});

	it("targets threaded stop commands at the existing thread lane", () => {
		const slackEvent = event({ text: "stop", threadTs: "1699999999.000000" });
		const target = getSlackStopConversationTarget(slackEvent, "/tmp/C123");

		expect(slackStopReplyThreadTs(slackEvent)).toBe("1699999999.000000");
		expect(target.replyThreadTs).toBe("1699999999.000000");
		expect(target.runnerId).toBe("slack:C123:thread:1699999999.000000");
		expect(target.sessionDir).toBe("/tmp/C123/threads/1699999999.000000");
		expect(target.logContextScope).toEqual({ source: "slack", kind: "thread", rootTs: "1699999999.000000" });
	});
});

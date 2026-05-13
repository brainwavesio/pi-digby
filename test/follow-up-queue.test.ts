import { describe, expect, it } from "vitest";
import {
	createQueuedFollowUpTrigger,
	FollowUpQueue,
	formatQueuedFollowUpPrompt,
} from "../src/channel/follow-up-queue.js";
import type { BotEvent } from "../src/types.js";

function slackEvent(ts: string, text: string, threadTs?: string, attachmentName?: string): BotEvent {
	return {
		type: "channel",
		source: "slack",
		channel: "C123",
		ts,
		user: "U_USER",
		text,
		...(threadTs && { threadTs }),
		...(attachmentName && { attachments: [{ name: attachmentName, local: `C123/attachments/${attachmentName}` }] }),
	};
}

describe("FollowUpQueue", () => {
	it("drains queued events for one runner in arrival order", () => {
		const queue = new FollowUpQueue();
		const first = slackEvent("100.000001", "first");
		const second = slackEvent("100.000002", "second");
		const other = slackEvent("100.000003", "other");

		expect(queue.enqueue("runner:a", first)).toBe(1);
		expect(queue.enqueue("runner:a", second)).toBe(2);
		expect(queue.enqueue("runner:b", other)).toBe(1);

		expect(queue.size("runner:a")).toBe(2);
		expect(queue.drain("runner:a").map((event) => event.text)).toEqual(["first", "second"]);
		expect(queue.drain("runner:a")).toEqual([]);
		expect(queue.drain("runner:b").map((event) => event.text)).toEqual(["other"]);
	});

	it("creates a synthetic trigger after all queued Slack timestamps", () => {
		const trigger = createQueuedFollowUpTrigger(
			[slackEvent("100.000001", "first", "99.000000"), slackEvent("100.000002", "second", "99.000000")],
			100_000,
		);

		expect(trigger.source).toBe("slack");
		expect(trigger.channel).toBe("C123");
		expect(trigger.threadTs).toBe("99.000000");
		expect(Number.parseFloat(trigger.ts)).toBeGreaterThan(100.000002);
		expect(trigger.text).toBe(formatQueuedFollowUpPrompt(2, "slack"));
	});

	it("carries downloaded attachments into the synthetic trigger", () => {
		const trigger = createQueuedFollowUpTrigger([
			slackEvent("100.000001", "first", undefined, "one.png"),
			slackEvent("100.000002", "second", undefined, "two.txt"),
		]);

		expect(trigger.attachments).toEqual([
			{ name: "one.png", local: "C123/attachments/one.png" },
			{ name: "two.txt", local: "C123/attachments/two.txt" },
		]);
	});
});

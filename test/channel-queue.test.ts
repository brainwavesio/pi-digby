import { describe, expect, it } from "vitest";
import { ChannelQueue } from "../src/channel/queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("ChannelQueue", () => {
	it("reports pending and processing work", async () => {
		const queue = new ChannelQueue();
		const gate = deferred();

		queue.enqueue(async () => {
			await gate.promise;
		});
		queue.enqueue(async () => {});

		expect(queue.isProcessing()).toBe(true);
		expect(queue.isBusy()).toBe(true);
		expect(queue.size()).toBe(1);

		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(queue.isProcessing()).toBe(false);
		expect(queue.isBusy()).toBe(false);
		expect(queue.size()).toBe(0);
	});

	it("lets separate queues run concurrently while each queue remains FIFO", async () => {
		const left = new ChannelQueue();
		const right = new ChannelQueue();
		const leftGate = deferred();
		const rightGate = deferred();
		const seen: string[] = [];

		left.enqueue(async () => {
			seen.push("left:first:start");
			await leftGate.promise;
			seen.push("left:first:end");
		});
		left.enqueue(async () => {
			seen.push("left:second");
		});

		right.enqueue(async () => {
			seen.push("right:first:start");
			await rightGate.promise;
			seen.push("right:first:end");
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(seen).toEqual(["left:first:start", "right:first:start"]);
		expect(left.isBusy()).toBe(true);
		expect(right.isBusy()).toBe(true);

		rightGate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["left:first:start", "right:first:start", "right:first:end"]);

		leftGate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual([
			"left:first:start",
			"right:first:start",
			"right:first:end",
			"left:first:end",
			"left:second",
		]);
	});
});

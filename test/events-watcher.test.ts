import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsWatcherImpl } from "../src/events/watcher.js";

describe("EventsWatcher fs.watch error handling", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "digby-events-"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries the events fs watcher 5 seconds after an async error", async () => {
		vi.useFakeTimers();

		const eventsDir = join(tempDir, "events");
		mkdirSync(eventsDir, { recursive: true });

		const trigger = vi.fn(() => true);
		const watcher = new EventsWatcherImpl(eventsDir, trigger);

		try {
			watcher.start();
			const internals = watcher as unknown as { fsWatcher: FSWatcher | null };
			const originalWatcher = internals.fsWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(internals.fsWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(internals.fsWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(internals.fsWatcher).not.toBeNull();
			expect(internals.fsWatcher).not.toBe(originalWatcher);
		} finally {
			watcher.stop();
			vi.useRealTimers();
		}
	});
});

describe("EventsWatcher event targets", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "digby-events-"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("passes optional Slack thread targets through to the trigger", async () => {
		const eventsDir = join(tempDir, "events");
		mkdirSync(eventsDir, { recursive: true });

		const trigger = vi.fn(() => true);
		const watcher = new EventsWatcherImpl(eventsDir, trigger);
		const filename = "thread-event.json";
		const filePath = join(eventsDir, filename);
		writeFileSync(
			filePath,
			JSON.stringify({
				type: "immediate",
				channelId: "C123",
				threadTs: "1699999999.000000",
				text: "thread follow-up",
			}),
		);
		utimesSync(filePath, new Date(), new Date(Date.now() + 1000));

		const internals = watcher as unknown as { handleFile: (filename: string) => Promise<void> };
		await internals.handleFile(filename);

		expect(trigger).toHaveBeenCalledWith({
			channelId: "C123",
			filename,
			threadTs: "1699999999.000000",
			text: "[EVENT:thread-event.json:immediate:immediate] thread follow-up",
		});
	});

	it("keeps channel events unthreaded by default", async () => {
		const eventsDir = join(tempDir, "events");
		mkdirSync(eventsDir, { recursive: true });

		const trigger = vi.fn(() => true);
		const watcher = new EventsWatcherImpl(eventsDir, trigger);
		const filename = "channel-event.json";
		const filePath = join(eventsDir, filename);
		writeFileSync(
			filePath,
			JSON.stringify({
				type: "immediate",
				channelId: "C123",
				text: "channel follow-up",
			}),
		);
		utimesSync(filePath, new Date(), new Date(Date.now() + 1000));

		const internals = watcher as unknown as { handleFile: (filename: string) => Promise<void> };
		await internals.handleFile(filename);

		expect(trigger).toHaveBeenCalledWith({
			channelId: "C123",
			filename,
			text: "[EVENT:channel-event.json:immediate:immediate] channel follow-up",
			threadTs: undefined,
		});
	});
});

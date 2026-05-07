import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

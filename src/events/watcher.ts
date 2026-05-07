import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import * as log from "../log.js";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "./fs-watch.js";

// ============================================================================
// Event types
// ============================================================================

export interface ImmediateEvent {
	type: "immediate";
	channelId: string;
	text: string;
}

export interface OneShotEvent {
	type: "one-shot";
	channelId: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
	type: "periodic";
	channelId: string;
	text: string;
	schedule: string; // cron expression
	timezone: string; // IANA timezone, e.g. "America/New_York"
}

export type MomEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

// ============================================================================
// Trigger function — the watcher calls this to wake the bot
// ============================================================================

/** Returns true if the event was enqueued, false if the queue is full. */
export type TriggerFn = (event: { channelId: string; text: string; filename: string }) => boolean;

// ============================================================================
// EventsWatcher
// ============================================================================

export interface EventsWatcher {
	start(): void;
	stop(): void;
}

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcherImpl implements EventsWatcher {
	private timers = new Map<string, NodeJS.Timeout>();
	private crons = new Map<string, Cron>();
	private debounceTimers = new Map<string, NodeJS.Timeout>();
	private knownFiles = new Set<string>();
	private fsWatcher: FSWatcher | null = null;
	private fsWatcherRetryTimer: NodeJS.Timeout | null = null;
	private stopped = true;
	private startTime: number;

	constructor(
		private eventsDir: string,
		private trigger: TriggerFn,
	) {
		this.startTime = Date.now();
	}

	// ------------------------------------------------------------------
	// Public
	// ------------------------------------------------------------------

	start(): void {
		this.stopped = false;

		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		log.info(`Events watcher starting, dir: ${this.eventsDir}`);

		this.scanExisting();

		this.startFsWatcher();

		log.info(`Events watcher started, tracking ${this.knownFiles.size} file(s)`);
	}

	stop(): void {
		this.stopped = true;

		closeWatcher(this.fsWatcher);
		this.fsWatcher = null;

		if (this.fsWatcherRetryTimer) {
			clearTimeout(this.fsWatcherRetryTimer);
			this.fsWatcherRetryTimer = null;
		}

		for (const t of this.debounceTimers.values()) clearTimeout(t);
		this.debounceTimers.clear();

		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();

		for (const c of this.crons.values()) c.stop();
		this.crons.clear();

		this.knownFiles.clear();
		log.info("Events watcher stopped");
	}

	// ------------------------------------------------------------------
	// fs.watch lifecycle (with retry on async errors)
	// ------------------------------------------------------------------

	private startFsWatcher(): void {
		this.fsWatcher = watchWithErrorHandler(
			this.eventsDir,
			(_type, filename) => {
				if (!filename || !filename.endsWith(".json")) return;
				this.debounce(filename, () => this.handleFileChange(filename));
			},
			() => this.handleFsWatcherError(),
		);
	}

	private handleFsWatcherError(): void {
		log.warn("Events fs watcher errored, scheduling retry");
		closeWatcher(this.fsWatcher);
		this.fsWatcher = null;
		this.scheduleFsWatcherRetry();
	}

	private scheduleFsWatcherRetry(): void {
		if (this.stopped || this.fsWatcherRetryTimer) {
			return;
		}

		this.fsWatcherRetryTimer = setTimeout(() => {
			this.fsWatcherRetryTimer = null;
			if (this.stopped) {
				return;
			}
			this.startFsWatcher();
			if (this.fsWatcher) {
				this.rescanExisting();
			}
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private rescanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.warn("Failed to read events directory", String(err));
			return;
		}

		const currentFiles = new Set(files);
		for (const filename of files) {
			this.handleFileChange(filename);
		}
		for (const filename of Array.from(this.knownFiles)) {
			if (!currentFiles.has(filename)) {
				this.handleDelete(filename);
			}
		}
	}

	// ------------------------------------------------------------------
	// File-change handling
	// ------------------------------------------------------------------

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) clearTimeout(existing);

		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.warn("Failed to read events directory", String(err));
			return;
		}
		for (const f of files) this.handleFile(f);
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			// Modified — cancel existing schedule then re-process
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;
		log.info(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}
		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	// ------------------------------------------------------------------
	// Parse & dispatch
	// ------------------------------------------------------------------

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		let event: MomEvent | null = null;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const raw = await readFile(filePath, "utf-8");
				event = this.parseEvent(raw, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < MAX_RETRIES - 1) {
					await sleep(RETRY_BASE_MS * 2 ** attempt);
				}
			}
		}

		if (!event) {
			log.warn(`Failed to parse event after ${MAX_RETRIES} retries: ${filename}`, lastError?.message ?? "");
			this.removeFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): MomEvent {
		const data = JSON.parse(content);

		if (!data.type || !data.channelId || !data.text) {
			throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
		}

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text };

			case "one-shot":
				if (!data.at) throw new Error(`Missing 'at' for one-shot event in ${filename}`);
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at };

			case "periodic":
				if (!data.schedule) throw new Error(`Missing 'schedule' for periodic event in ${filename}`);
				if (!data.timezone) throw new Error(`Missing 'timezone' for periodic event in ${filename}`);
				return {
					type: "periodic",
					channelId: data.channelId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	// ------------------------------------------------------------------
	// Type-specific handlers
	// ------------------------------------------------------------------

	private handleImmediate(filename: string, event: ImmediateEvent): void {
		const filePath = join(this.eventsDir, filename);

		// Skip stale immediate events that existed before the watcher started
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.info(`Stale immediate event, deleting: ${filename}`);
				this.removeFile(filename);
				return;
			}
		} catch {
			return; // file already gone
		}

		log.info(`Executing immediate event: ${filename}`);
		this.execute(filename, event, true);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atMs = new Date(event.at).getTime();
		const now = Date.now();

		if (atMs <= now) {
			log.info(`One-shot event in the past, deleting: ${filename}`);
			this.removeFile(filename);
			return;
		}

		const delayMs = atMs - now;
		log.info(`Scheduling one-shot event: ${filename} in ${Math.round(delayMs / 1000)}s`);

		const timer = setTimeout(() => {
			this.timers.delete(filename);
			log.info(`Executing one-shot event: ${filename}`);
			this.execute(filename, event, true);
		}, delayMs);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				log.info(`Executing periodic event: ${filename}`);
				this.execute(filename, event, false);
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.info(`Scheduled periodic event: ${filename}, next: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			log.warn(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.removeFile(filename);
		}
	}

	// ------------------------------------------------------------------
	// Execution & cleanup
	// ------------------------------------------------------------------

	private execute(filename: string, event: MomEvent, deleteAfter: boolean): void {
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const text = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;
		const enqueued = this.trigger({ channelId: event.channelId, text, filename });

		if (!enqueued) {
			log.warn(`Event queue full, discarded: ${filename}`);
		}

		// Delete immediate / one-shot files regardless of queue result
		if (deleteAfter) {
			this.removeFile(filename);
		}
	}

	private removeFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}
}

// ============================================================================
// Helper
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an events watcher for the given working directory.
 *
 * Events are JSON files placed in `{workingDir}/events/`. The watcher
 * monitors that directory and calls `triggerFn` when an event is due.
 */
export function createEventsWatcher(workingDir: string, triggerFn: TriggerFn): EventsWatcher {
	const eventsDir = join(workingDir, "events");
	return new EventsWatcherImpl(eventsDir, triggerFn);
}

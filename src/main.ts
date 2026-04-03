#!/usr/bin/env node

import { resolve } from "path";
import { getOrCreateRunner, shutdownAllRunners } from "./agent/setup.js";
import { ChannelQueue } from "./channel/queue.js";
import { RunContext } from "./channel/run-context.js";
import { createRunStats } from "./channel/run-stats.js";
import { ChannelState } from "./channel/state.js";
import { initConfig } from "./config.js";
import { createEventsWatcher } from "./events/watcher.js";
import { startHealthServer } from "./health.js";
import * as log from "./log.js";
import { SlackClient } from "./slack/client.js";
import { type RouterHandler, setupRouter } from "./slack/router.js";
import type { SlackEvent } from "./slack/types.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

function parseArgs(): { workingDir: string } {
	const args = process.argv.slice(2);
	let workingDir: string | undefined;

	for (const arg of args) {
		if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	if (!workingDir) {
		console.error("Usage: digby <working-directory>");
		process.exit(1);
	}

	return { workingDir: resolve(workingDir) };
}

const { workingDir } = parseArgs();

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

initConfig(workingDir);

// ============================================================================
// Per-channel state
// ============================================================================

interface ChannelRunState {
	running: boolean;
	channelState: ChannelState;
	queue: ChannelQueue;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelRunState>();

function getChannelRunState(channelId: string): ChannelRunState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {
			running: false,
			channelState: new ChannelState(channelId, workingDir),
			queue: new ChannelQueue(),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Handler
// ============================================================================

async function handleEvent(event: SlackEvent, client: SlackClient, _isEvent?: boolean): Promise<void> {
	const state = getChannelRunState(event.channel);
	const runner = await getOrCreateRunner(event.channel, state.channelState.channelDir, workingDir);

	// Log user message
	const user = client.getUser(event.user);
	state.channelState.logUserMessage(event, user?.userName, user?.displayName);

	// Determine reply thread
	const replyThreadTs =
		event.type === "mention"
			? (event.threadTs ?? event.ts) // always thread in channels
			: event.threadTs; // DMs: thread only if already in one

	// Stats shared between RunContext (footer) and event handler (updates)
	const stats = createRunStats();

	// Create RunContext — guaranteed to resolve via finally
	const ctx = new RunContext(client, event.channel, stats, replyThreadTs);

	state.running = true;
	state.stopRequested = false;

	log.info(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

	try {
		ctx.postThinking();

		const result = await runner.run(
			ctx,
			event,
			state.channelState,
			client.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			client.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
			user?.userName,
			stats,
		);

		if (result.stopReason === "aborted" && state.stopRequested) {
			if (state.stopMessageTs) {
				await client.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
				state.stopMessageTs = undefined;
			}
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.warn(`[${event.channel}] Run error`, errMsg);
		ctx.reject(`Something went wrong: ${errMsg.substring(0, 500)}`);
	} finally {
		ctx.resolve(); // No-op if already rejected/deleted. Sets streaming=false, adds cost footer.
		await ctx.flush();
		state.running = false;
	}
}

// ============================================================================
// Router handler adapter
// ============================================================================

const client = new SlackClient({
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
});

const handler: RouterHandler = {
	isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	},

	async handleEvent(event: SlackEvent, isEvent?: boolean): Promise<void> {
		const state = getChannelRunState(event.channel);
		state.queue.enqueue(() => handleEvent(event, client, isEvent));
	},

	async handleStop(channelId: string, threadTs?: string): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			const runner = await getOrCreateRunner(channelId, state.channelState.channelDir, workingDir);
			runner.abort();
			const ts = await client.postMessage(channelId, "_Stopping..._", threadTs);
			state.stopMessageTs = ts;
		} else {
			await client.postMessage(channelId, "_Nothing running_", threadTs);
		}
	},
};

// ============================================================================
// Backfill
// ============================================================================

async function backfillAllChannels(): Promise<void> {
	const start = Date.now();
	let total = 0;

	for (const [channelId, channel] of client.getAllChannels().map((c) => [c.id, c] as const)) {
		const state = getChannelRunState(channelId);
		if (!state.channelState.hasLog()) continue;

		try {
			const existing = state.channelState.getLogTimestamps();
			const count = await client.backfillChannel(channelId, existing, (entry) => {
				state.channelState.appendLog(entry);
			});
			if (count > 0) log.info(`Backfilled #${channel.name}: ${count} messages`);
			total += count;
		} catch (err) {
			log.warn(`Failed to backfill #${channel.name}`, err instanceof Error ? err.message : String(err));
		}
	}

	const dur = ((Date.now() - start) / 1000).toFixed(1);
	log.info(`Backfill complete: ${total} messages in ${dur}s`);
}

// ============================================================================
// Start
// ============================================================================

log.info(`Starting pi-digby v2 (workingDir: ${workingDir})`);

// Start health check server (ECS container health check)
startHealthServer();

// Start Slack client
await client.start();

// Backfill channels with existing logs
await backfillAllChannels();

// Record startup time — messages older than this are just logged, not processed
const startupTs = (Date.now() / 1000).toFixed(6);

// Set up event routing
setupRouter(client, handler, startupTs);

// Start events watcher (scheduled/periodic events)
const eventsWatcher = createEventsWatcher(workingDir, ({ channelId, text, filename }) => {
	const event: SlackEvent = {
		type: "mention",
		channel: channelId,
		ts: (Date.now() / 1000).toFixed(6),
		user: "system",
		text: `[EVENT:${filename}:${text}]`,
	};
	const state = getChannelRunState(channelId);
	if (state.queue.size() >= 5) {
		log.warn(`Event queue full for ${channelId}, discarding: ${text.substring(0, 50)}`);
		return false;
	}
	state.queue.enqueue(() => handleEvent(event, client, true));
	return true;
});
eventsWatcher.start();

log.info("Ready");

// ============================================================================
// Shutdown
// ============================================================================

function shutdown(signal: string): void {
	log.info(`Shutting down (${signal})...`);
	eventsWatcher.stop();
	shutdownAllRunners()
		.catch((err) => log.warn("Shutdown error", String(err)))
		.finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Safety net: don't crash on unhandled errors
process.on("uncaughtException", (err) => {
	log.warn("Uncaught exception (continuing)", err.message);
});
process.on("unhandledRejection", (reason) => {
	log.warn("Unhandled rejection (continuing)", reason instanceof Error ? reason.message : String(reason));
});

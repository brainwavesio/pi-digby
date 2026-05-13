#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { type ChannelRunner, getOrCreateRunner, shutdownAllRunners } from "./agent/setup.js";
import { ChannelQueue } from "./channel/queue.js";
import { createRunStats } from "./channel/run-stats.js";
import { ChannelState } from "./channel/state.js";
import { initConfig } from "./config.js";
import { createEventsWatcher } from "./events/watcher.js";
import { HttpServer } from "./http-server.js";
import * as log from "./log.js";
import { SlackClient } from "./slack/client.js";
import { getSlackConversationTarget } from "./slack/conversation.js";
import { type RouterHandler, setupRouter } from "./slack/router.js";
import type { Attachment, SlackEvent } from "./slack/types.js";
import { SlackSurface } from "./surface/slack.js";
import { THINKING_PLACEHOLDER } from "./surface/types.js";

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
	activeRunner?: ChannelRunner;
	activeRunnerId?: string;
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

async function downloadAttachments(event: SlackEvent, client: SlackClient): Promise<void> {
	if (!event.files || event.files.length === 0) return;

	const attachments: Attachment[] = [];
	for (const file of event.files) {
		const url = file.url_private_download || file.url_private;
		const name = file.name || "file";
		if (!url) continue;

		try {
			const localRelPath = `${event.channel}/attachments/${event.ts}_${name}`;
			const fullPath = join(workingDir, localRelPath);
			mkdirSync(dirname(fullPath), { recursive: true });
			const buffer = await client.downloadFile(url);
			writeFileSync(fullPath, buffer);
			attachments.push({ name, local: localRelPath });
		} catch (err) {
			log.warn(`Failed to download attachment ${name}`, err instanceof Error ? err.message : String(err));
		}
	}
	event.attachments = attachments;
}

async function hydrateSlackThreadCache(
	client: SlackClient,
	channelState: ChannelState,
	channelId: string,
	rootTs: string,
): Promise<void> {
	try {
		const existing = channelState.getLogTimestampsForThread(rootTs);
		const count = await client.backfillThread(channelId, rootTs, existing, (entry) => {
			channelState.appendLog(entry);
		});
		if (count > 0) log.info(`[${channelId}] Hydrated thread ${rootTs}: ${count} messages`);
	} catch (err) {
		log.warn(`[${channelId}] Failed to hydrate thread ${rootTs}`, err instanceof Error ? err.message : String(err));
	}
}

async function handleEvent(event: SlackEvent, client: SlackClient, isEvent?: boolean): Promise<void> {
	const state = getChannelRunState(event.channel);

	// Download file attachments before logging or running
	await downloadAttachments(event, client);

	// Log user message (now includes downloaded attachments)
	const user = client.getUser(event.user);
	state.channelState.logUserMessage(event, user?.userName, user?.displayName);

	const conversation = getSlackConversationTarget(event, state.channelState.channelDir, isEvent);
	if (conversation.logContextScope.kind === "thread" && event.threadTs) {
		await hydrateSlackThreadCache(client, state.channelState, event.channel, conversation.logContextScope.rootTs);
	}

	const runner = await getOrCreateRunner({
		runnerId: conversation.runnerId,
		channelId: event.channel,
		channelDir: state.channelState.channelDir,
		sessionDir: conversation.sessionDir,
		workingDir,
	});

	// Stats shared between surface (footer) and event handler (updates)
	const stats = createRunStats();

	// Create surface — guaranteed to resolve via finally
	const ctx = new SlackSurface(client, event.channel, stats, conversation.replyThreadTs);

	state.running = true;
	state.activeRunner = runner;
	state.activeRunnerId = conversation.runnerId;
	state.stopRequested = false;

	log.info(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

	try {
		ctx.emitThinking();

		const result = await runner.run(
			ctx,
			event,
			state.channelState,
			client.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			client.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
			user?.userName,
			stats,
			conversation.logContextScope,
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

		// Log bot response to log.jsonl (skip thinking-only or deleted messages)
		const finalText = ctx.finalText;
		const messageTs = ctx.finalMessageTs;
		if (finalText && finalText !== THINKING_PLACEHOLDER && messageTs && !ctx.wasDeleted) {
			state.channelState.logBotResponse(finalText, messageTs, conversation.replyThreadTs);
		}

		state.running = false;
		if (state.activeRunnerId === conversation.runnerId) {
			state.activeRunner = undefined;
			state.activeRunnerId = undefined;
		}
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

	logMessage(event: SlackEvent): void {
		const state = getChannelRunState(event.channel);
		const user = client.getUser(event.user);
		state.channelState.logUserMessage(event, user?.userName, user?.displayName);
	},

	async handleStop(channelId: string, threadTs?: string): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.activeRunner?.abort();
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

// Start HTTP server (health checks + webhooks)
const httpServer = new HttpServer();
httpServer.start();

// Start Slack client
await client.start();

// Backfill channels with existing logs
await backfillAllChannels();

// Record startup time — messages older than this are just logged, not processed
const startupTs = (Date.now() / 1000).toFixed(6);

// Set up event routing
setupRouter(client, handler, startupTs);

// Start events watcher (scheduled/periodic events)
const eventsWatcher = createEventsWatcher(workingDir, ({ channelId, text, filename, threadTs }) => {
	const event: SlackEvent = {
		type: "mention",
		source: "slack",
		channel: channelId,
		ts: (Date.now() / 1000).toFixed(6),
		user: "system",
		text: `[EVENT:${filename}:${text}]`,
		threadTs,
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

// ============================================================================
// Linear agent (optional — only if credentials are present)
// ============================================================================

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;

if (LINEAR_API_KEY && LINEAR_WEBHOOK_SECRET) {
	const { LinearClient } = await import("./linear/client.js");
	const { createLinearWebhookHandler } = await import("./linear/router.js");
	const { LinearSurface } = await import("./surface/linear.js");

	const linearClient = new LinearClient(LINEAR_API_KEY);

	const linearHandler = createLinearWebhookHandler(LINEAR_WEBHOOK_SECRET, {
		async handleEvent(event) {
			const state = getChannelRunState(event.channel);
			state.queue.enqueue(async () => {
				const runner = await getOrCreateRunner({
					runnerId: event.channel,
					channelId: event.channel,
					channelDir: state.channelState.channelDir,
					sessionDir: state.channelState.channelDir,
					workingDir,
				});

				// Log user message (mirrors Slack path)
				state.channelState.logUserMessage(event);

				const stats = createRunStats();
				const sessionId = event.channel.replace("linear:", "");
				const ctx = new LinearSurface(linearClient, sessionId, stats);

				state.running = true;
				state.activeRunner = runner;
				state.activeRunnerId = event.channel;
				state.stopRequested = false;

				log.info(`[${event.channel}] Starting Linear run: ${event.text.substring(0, 50)}`);

				try {
					ctx.emitThinking();

					const result = await runner.run(ctx, event, state.channelState, [], [], undefined, stats, {
						source: "linear",
						kind: "chronological",
					});

					if (result.stopReason === "aborted" && state.stopRequested) {
						log.info(`[${event.channel}] Linear run stopped`);
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.warn(`[${event.channel}] Linear run error`, errMsg);
					ctx.reject(`Something went wrong: ${errMsg.substring(0, 500)}`);
				} finally {
					ctx.resolve();
					await ctx.flush();

					const finalText = ctx.finalText;
					if (finalText && finalText !== THINKING_PLACEHOLDER && !ctx.wasDeleted) {
						state.channelState.logBotResponse(finalText, String(Date.now() / 1000));
					}

					state.running = false;
					if (state.activeRunnerId === event.channel) {
						state.activeRunner = undefined;
						state.activeRunnerId = undefined;
					}
				}
			});
		},

		async handleStop(channelId) {
			const state = channelStates.get(channelId);
			if (state?.running) {
				state.stopRequested = true;
				state.activeRunner?.abort();
				log.info(`[${channelId}] Linear stop requested`);
			}
		},
	});

	httpServer.registerWebhook("/webhooks/linear", linearHandler);
	log.info("Linear agent enabled");
} else {
	log.info("Linear agent disabled (missing LINEAR_API_KEY/LINEAR_WEBHOOK_SECRET)");
}

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

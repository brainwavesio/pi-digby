#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { type ChannelRunner, evictRunner, getOrCreateRunner, shutdownAllRunners } from "./agent/setup.js";
import { createQueuedFollowUpTrigger, FollowUpQueue } from "./channel/follow-up-queue.js";
import { ChannelQueue } from "./channel/queue.js";
import { createRunStats } from "./channel/run-stats.js";
import { ChannelState } from "./channel/state.js";
import { initConfig } from "./config.js";
import { createEventsWatcher } from "./events/watcher.js";
import { HttpServer } from "./http-server.js";
import * as log from "./log.js";
import { SlackClient } from "./slack/client.js";
import { getSlackConversationTarget, getSlackStopConversationTarget } from "./slack/conversation.js";
import { type RouterHandler, setupRouter } from "./slack/router.js";
import type { Attachment, SlackEvent } from "./slack/types.js";
import { SlackSurface } from "./surface/slack.js";
import { THINKING_PLACEHOLDER } from "./surface/types.js";
import type { BotEvent } from "./types.js";

// ============================================================================
// Config
// ============================================================================

const DIGBY_SLACK_APP_TOKEN = process.env.DIGBY_SLACK_APP_TOKEN;
const DIGBY_SLACK_BOT_TOKEN = process.env.DIGBY_SLACK_BOT_TOKEN;

// Wiki — the four DIGBY_* env vars below are required in production: ECS
// wires them in via the `Secrets:` block (deploy/cloudformation.yml), so a
// missing key in pi-digby/env will fail the task at boot with a clear
// ResourceInitializationError — which is what we want. We'd rather fail
// loud at deploy than ship a bot whose /w/* silently 302s into nothing.
//
// The env-var gate below exists only for local dev, where these aren't set
// and the bot should run with the wiki disabled.
const DIGBY_COOKIE_SECRET = process.env.DIGBY_COOKIE_SECRET;
const DIGBY_SLACK_CLIENT_ID = process.env.DIGBY_SLACK_CLIENT_ID;
const DIGBY_SLACK_CLIENT_SECRET = process.env.DIGBY_SLACK_CLIENT_SECRET;
const DIGBY_SLACK_TEAM_ID = process.env.DIGBY_SLACK_TEAM_ID;
const DIGBY_WIKI_BASE_URL = process.env.DIGBY_WIKI_BASE_URL ?? "";

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

if (!DIGBY_SLACK_APP_TOKEN || !DIGBY_SLACK_BOT_TOKEN) {
	console.error("Missing env: DIGBY_SLACK_APP_TOKEN, DIGBY_SLACK_BOT_TOKEN");
	process.exit(1);
}

initConfig(workingDir);

// ============================================================================
// Per-channel state
// ============================================================================

interface ChannelRunState {
	channelState: ChannelState;
	lanes: Map<string, LaneRunState>;
}

interface LaneRunState {
	running: boolean;
	acceptingFollowUps: boolean;
	queue: ChannelQueue;
	followUps: FollowUpQueue;
	stopRequested: boolean;
	stopMessageTs?: string;
	activeRunner?: ChannelRunner;
}

const channelStates = new Map<string, ChannelRunState>();

function getChannelRunState(channelId: string): ChannelRunState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {
			channelState: new ChannelState(channelId, workingDir),
			lanes: new Map(),
		};
		channelStates.set(channelId, state);
	}
	return state;
}

function getLaneRunState(state: ChannelRunState, laneId: string): LaneRunState {
	let lane = state.lanes.get(laneId);
	if (!lane) {
		lane = {
			running: false,
			acceptingFollowUps: false,
			queue: new ChannelQueue(),
			followUps: new FollowUpQueue(),
			stopRequested: false,
		};
		state.lanes.set(laneId, lane);
	}
	return lane;
}

function isLaneBusy(lane: LaneRunState | undefined): boolean {
	return !!lane && (lane.running || lane.queue.isBusy());
}

// ============================================================================
// Handler
// ============================================================================

async function downloadAttachments(event: SlackEvent, client: SlackClient): Promise<void> {
	if (event.attachments) return;
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

async function prepareAndLogSlackUserMessage(
	state: ChannelRunState,
	event: SlackEvent,
	client: SlackClient,
): Promise<string | undefined> {
	await downloadAttachments(event, client);
	const user = client.getUser(event.user);
	state.channelState.logUserMessage(event, user?.userName, user?.displayName);
	return user?.userName;
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

async function runSlackEvent(
	event: SlackEvent,
	client: SlackClient,
	options: { isEvent?: boolean; logTrigger?: boolean } = {},
): Promise<void> {
	const state = getChannelRunState(event.channel);
	const isEvent = options.isEvent ?? false;
	const conversation = getSlackConversationTarget(event, state.channelState.channelDir, isEvent);
	const lane = getLaneRunState(state, conversation.runnerId);

	lane.running = true;
	lane.acceptingFollowUps = false;
	lane.activeRunner = undefined;

	// Stats shared between surface (footer) and event handler (updates)
	const stats = createRunStats();

	// Create surface — guaranteed to resolve via finally
	const ctx = new SlackSurface(client, event.channel, stats, conversation.replyThreadTs);

	try {
		const userName =
			options.logTrigger === false
				? client.getUser(event.user)?.userName
				: await prepareAndLogSlackUserMessage(state, event, client);

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

		lane.activeRunner = runner;
		if (lane.stopRequested) {
			runner.abort();
		}
		lane.acceptingFollowUps = true;

		log.info(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		ctx.emitThinking();

		const result = await runner.run(
			ctx,
			event,
			state.channelState,
			client.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			client.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
			userName,
			stats,
			conversation.logContextScope,
		);

		if (result.stopReason === "aborted" && lane.stopRequested) {
			if (lane.stopMessageTs) {
				await client.updateMessage(event.channel, lane.stopMessageTs, "_Stopped_");
				lane.stopMessageTs = undefined;
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

		lane.acceptingFollowUps = false;
		const queuedFollowUps = lane.followUps.drain(conversation.runnerId);
		if (queuedFollowUps.length > 0) {
			const trigger = createQueuedFollowUpTrigger(queuedFollowUps);
			log.info(`[${event.channel}] Scheduling ${queuedFollowUps.length} queued follow-up message(s)`);
			lane.queue.enqueue(() => runSlackEvent(trigger, client, { isEvent: true, logTrigger: false }));
		}

		lane.running = false;
		lane.activeRunner = undefined;
		lane.stopRequested = false;
		lane.stopMessageTs = undefined;

		// Evict runner so the next trigger rebuilds from disk. Bounds in-memory
		// SessionManager growth and ensures external edits to context.jsonl take
		// effect on the next run. Queued follow-ups will simply re-create the
		// runner when they're dequeued.
		await evictRunner(conversation.runnerId);
	}
}

async function enqueueSlackEvent(event: SlackEvent, client: SlackClient, isEvent?: boolean): Promise<void> {
	const state = getChannelRunState(event.channel);
	const conversation = getSlackConversationTarget(event, state.channelState.channelDir, isEvent);
	const lane = getLaneRunState(state, conversation.runnerId);

	if (lane.running && lane.acceptingFollowUps) {
		await downloadAttachments(event, client);
		if (lane.running && lane.acceptingFollowUps) {
			const user = client.getUser(event.user);
			state.channelState.logUserMessage(event, user?.userName, user?.displayName);
			const count = lane.followUps.enqueue(conversation.runnerId, event);
			log.info(`[${event.channel}] Queued follow-up ${count} for ${conversation.runnerId}`);
			return;
		}
	}

	lane.queue.enqueue(() => runSlackEvent(event, client, { isEvent }));
}

// ============================================================================
// Router handler adapter
// ============================================================================

const client = new SlackClient({
	appToken: DIGBY_SLACK_APP_TOKEN,
	botToken: DIGBY_SLACK_BOT_TOKEN,
});

const handler: RouterHandler = {
	isBusy(event: SlackEvent): boolean {
		const state = getChannelRunState(event.channel);
		const conversation = getSlackConversationTarget(event, state.channelState.channelDir);
		return isLaneBusy(state.lanes.get(conversation.runnerId));
	},

	async handleEvent(event: SlackEvent, isEvent?: boolean): Promise<void> {
		await enqueueSlackEvent(event, client, isEvent);
	},

	logMessage(event: SlackEvent): void {
		const state = getChannelRunState(event.channel);
		const user = client.getUser(event.user);
		state.channelState.logUserMessage(event, user?.userName, user?.displayName);
	},

	async handleStop(event: SlackEvent): Promise<void> {
		const state = getChannelRunState(event.channel);
		const conversation = getSlackStopConversationTarget(event, state.channelState.channelDir);
		const lane = getLaneRunState(state, conversation.runnerId);
		if (isLaneBusy(lane)) {
			lane.stopRequested = true;
			lane.activeRunner?.abort();
			const ts = await client.postMessage(event.channel, "_Stopping..._", conversation.replyThreadTs);
			lane.stopMessageTs = ts;
		} else {
			await client.postMessage(event.channel, "_Nothing running_", conversation.replyThreadTs);
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

// Start Slack client
await client.start();

// Enable the wiki (/w/*, /auth/*, /public/*) when fully configured.
if (DIGBY_COOKIE_SECRET && DIGBY_SLACK_CLIENT_ID && DIGBY_SLACK_CLIENT_SECRET && DIGBY_SLACK_TEAM_ID) {
	const { createWikiHandler } = await import("./wiki/handler.js");
	const wikiHandler = await createWikiHandler({
		workingDir,
		cookieSecret: DIGBY_COOKIE_SECRET,
		slack: {
			clientId: DIGBY_SLACK_CLIENT_ID,
			clientSecret: DIGBY_SLACK_CLIENT_SECRET,
			teamId: DIGBY_SLACK_TEAM_ID,
			redirectUri: `${DIGBY_WIKI_BASE_URL}/auth/slack/callback`,
		},
		lookupChannel: (id) => client.getChannel(id)?.name,
		// entrypoint.sh symlinks /data/.cache/qmd onto the EFS path, so the
		// sqlite index is the same one the CLI maintains. createWikiSearch
		// degrades to "search unavailable" if the DB is absent.
		qmdDbPath: join(workingDir, ".cache", "qmd", "index.sqlite"),
	});
	// Order matters — these are checked in registration order.
	httpServer.registerGetPrefix("/public/", wikiHandler);
	httpServer.registerGetPrefix("/auth/", wikiHandler);
	httpServer.registerGetPrefix("/w", wikiHandler);
	log.info("Wiki enabled at /w/");

	const { createRawHandler } = await import("./wiki/raw-handler.js");
	const rawHandler = await createRawHandler({
		workingDir,
		cookieSecret: DIGBY_COOKIE_SECRET,
		slack: {
			clientId: DIGBY_SLACK_CLIENT_ID,
			clientSecret: DIGBY_SLACK_CLIENT_SECRET,
			teamId: DIGBY_SLACK_TEAM_ID,
			redirectUri: `${DIGBY_WIKI_BASE_URL}/auth/slack/callback`,
		},
	});
	httpServer.registerGetPrefix("/r", rawHandler);
	log.info("Raw file endpoint enabled at /r/");
} else {
	log.info("Wiki disabled — DIGBY_COOKIE_SECRET / DIGBY_SLACK_* env not set");
}

httpServer.start();

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
	const conversation = getSlackConversationTarget(event, state.channelState.channelDir, true);
	const lane = getLaneRunState(state, conversation.runnerId);
	if (lane.queue.size() >= 5) {
		log.warn(`Event queue full for ${channelId}, discarding: ${text.substring(0, 50)}`);
		return false;
	}
	enqueueSlackEvent(event, client, true).catch((err) => {
		log.warn(`[${channelId}] Failed to enqueue event`, err instanceof Error ? err.message : String(err));
	});
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

	async function runLinearEvent(event: BotEvent, options: { logTrigger?: boolean } = {}): Promise<void> {
		const state = getChannelRunState(event.channel);
		const runnerId = event.channel;
		const lane = getLaneRunState(state, runnerId);

		lane.running = true;
		lane.acceptingFollowUps = false;
		lane.activeRunner = undefined;

		const stats = createRunStats();
		const sessionId = event.channel.replace("linear:", "");
		const ctx = new LinearSurface(linearClient, sessionId, stats);

		try {
			if (options.logTrigger !== false) {
				state.channelState.logUserMessage(event);
			}

			const runner = await getOrCreateRunner({
				runnerId,
				channelId: event.channel,
				channelDir: state.channelState.channelDir,
				sessionDir: state.channelState.channelDir,
				workingDir,
			});

			lane.activeRunner = runner;
			if (lane.stopRequested) {
				runner.abort();
			}
			lane.acceptingFollowUps = true;

			log.info(`[${event.channel}] Starting Linear run: ${event.text.substring(0, 50)}`);

			ctx.emitThinking();

			const result = await runner.run(ctx, event, state.channelState, [], [], undefined, stats, {
				source: "linear",
				kind: "chronological",
			});

			if (result.stopReason === "aborted" && lane.stopRequested) {
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

			lane.acceptingFollowUps = false;
			const queuedFollowUps = lane.followUps.drain(runnerId);
			if (queuedFollowUps.length > 0) {
				const trigger = createQueuedFollowUpTrigger(queuedFollowUps);
				log.info(`[${event.channel}] Scheduling ${queuedFollowUps.length} queued Linear follow-up message(s)`);
				lane.queue.enqueue(() => runLinearEvent(trigger, { logTrigger: false }));
			}

			lane.running = false;
			lane.activeRunner = undefined;
			lane.stopRequested = false;
			lane.stopMessageTs = undefined;

			// Evict — see runSlackEvent for rationale.
			await evictRunner(runnerId);
		}
	}

	async function enqueueLinearEvent(event: BotEvent): Promise<void> {
		const state = getChannelRunState(event.channel);
		const runnerId = event.channel;
		const lane = getLaneRunState(state, runnerId);

		if (lane.running && lane.acceptingFollowUps) {
			state.channelState.logUserMessage(event);
			const count = lane.followUps.enqueue(runnerId, event);
			log.info(`[${event.channel}] Queued Linear follow-up ${count}`);
			return;
		}

		lane.queue.enqueue(() => runLinearEvent(event));
	}

	const linearHandler = createLinearWebhookHandler(LINEAR_WEBHOOK_SECRET, {
		async handleEvent(event) {
			await enqueueLinearEvent(event);
		},

		async handleStop(channelId) {
			const state = getChannelRunState(channelId);
			const lane = getLaneRunState(state, channelId);
			if (isLaneBusy(lane)) {
				lane.stopRequested = true;
				lane.activeRunner?.abort();
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

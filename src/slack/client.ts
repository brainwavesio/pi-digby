import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { basename } from "path";
import * as log from "../log.js";
import type { SlackChannel, SlackUser } from "./types.js";

// ============================================================================
// Retry helper
// ============================================================================

function isRetryable(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("rate_limited") ||
		msg.includes("timeout") ||
		msg.includes("econnreset") ||
		msg.includes("econnrefused") ||
		msg.includes("socket hang up") ||
		msg.includes("no active connection") ||
		msg.includes("fetch failed")
	);
}

async function withRetry<T>(op: () => Promise<T>, context: string, maxRetries = 3, baseDelay = 1000): Promise<T> {
	for (let i = 0; i <= maxRetries; i++) {
		try {
			return await op();
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (i === maxRetries || !isRetryable(err)) {
				log.warn(`Slack API failed (${context})`, errMsg);
				throw err;
			}
			const delay = baseDelay * 2 ** i;
			log.warn(`Slack API retry ${i + 1}/${maxRetries} (${context})`, `${errMsg} — retrying in ${delay}ms`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw new Error("unreachable");
}

// ============================================================================
// SlackClient
// ============================================================================

export class SlackClient {
	private socket: SocketModeClient;
	private web: WebClient;
	private botUserId: string | null = null;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();

	// Cache: thread root ts → whether bot owns/was mentioned in root
	private botThreads = new Map<string, boolean>();
	// Dedup in-flight lookups
	private botThreadPending = new Map<string, Promise<boolean>>();

	private botToken: string;

	constructor(config: { appToken: string; botToken: string }) {
		this.socket = new SocketModeClient({ appToken: config.appToken });
		this.web = new WebClient(config.botToken);
		this.botToken = config.botToken;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.web.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.info(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		// Handle socket errors — client auto-reconnects, but unhandled errors crash the process
		this.socket.on("error", (error) => {
			log.warn("Socket mode error (will auto-reconnect)", error instanceof Error ? error.message : String(error));
		});

		await this.socket.start();
		log.info("Connected to Slack");
	}

	// ==========================================================================
	// Event subscription
	// ==========================================================================

	onAppMention(handler: (event: Record<string, any>) => void): void {
		this.socket.on("app_mention", ({ event, ack }) => {
			ack();
			handler(event);
		});
	}

	onMessage(handler: (event: Record<string, any>) => void): void {
		this.socket.on("message", ({ event, ack }) => {
			ack();
			handler(event);
		});
	}

	// ==========================================================================
	// Slack API (all with retry)
	// ==========================================================================

	async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
		const result = await withRetry(
			() => this.web.chat.postMessage({ channel, text, ...(threadTs && { thread_ts: threadTs }) }),
			"postMessage",
		);
		const ts = result.ts as string;
		// Mark root messages as bot-owned for thread routing
		if (!threadTs && ts) {
			this.botThreads.set(`${channel}:${ts}`, true);
		}
		return ts;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await withRetry(() => this.web.chat.update({ channel, ts, text }), "updateMessage");
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await withRetry(() => this.web.chat.delete({ channel, ts }), "deleteMessage");
	}

	async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
		try {
			await withRetry(() => this.web.reactions.add({ channel, timestamp: ts, name: emoji }), "addReaction");
		} catch {
			// Reactions are best-effort — don't propagate
		}
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		const args = threadTs
			? { channels: channel, file: fileContent, filename: fileName, title: fileName, thread_ts: threadTs }
			: { channel_id: channel, file: fileContent, filename: fileName, title: fileName };
		await withRetry(() => this.web.files.uploadV2(args as any), "uploadFile");
	}

	async uploadContent(
		channel: string,
		content: string,
		filename: string,
		title?: string,
		threadTs?: string,
	): Promise<void> {
		const buf = Buffer.from(content, "utf-8");
		const args = threadTs
			? { channel_id: channel, file: buf, filename, title: title ?? filename, thread_ts: threadTs }
			: { channel_id: channel, file: buf, filename, title: title ?? filename };
		await withRetry(() => this.web.files.uploadV2(args as any), "uploadContent");
	}

	async downloadFile(url: string): Promise<Buffer> {
		return withRetry(async () => {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${this.botToken}` },
			});
			if (!response.ok) {
				throw new Error(`Download failed: ${response.status} ${response.statusText}`);
			}
			return Buffer.from(await response.arrayBuffer());
		}, "downloadFile");
	}

	// ==========================================================================
	// Lookups
	// ==========================================================================

	getBotUserId(): string | null {
		return this.botUserId;
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	/**
	 * Check if a thread was started by or mentions this bot.
	 * Deduplicates concurrent lookups for the same thread.
	 */
	async isBotThread(channel: string, threadTs: string): Promise<boolean> {
		const key = `${channel}:${threadTs}`;

		// Check cache
		if (this.botThreads.has(key)) return this.botThreads.get(key)!;

		// Deduplicate in-flight lookups
		const pending = this.botThreadPending.get(key);
		if (pending) return pending;

		const lookup = (async () => {
			try {
				const result = await this.web.conversations.history({
					channel,
					latest: threadTs,
					inclusive: true,
					limit: 1,
				});
				const root = (result.messages as Array<{ user?: string; text?: string }> | undefined)?.[0];
				const owned =
					!!root &&
					(root.user === this.botUserId || (!!this.botUserId && !!root.text?.includes(`<@${this.botUserId}>`)));
				this.botThreads.set(key, owned);
				return owned;
			} catch {
				return false;
			} finally {
				this.botThreadPending.delete(key);
			}
		})();

		this.botThreadPending.set(key, lookup);
		return lookup;
	}

	// ==========================================================================
	// Backfill — log missed messages on startup
	// ==========================================================================

	async backfillChannel(
		channelId: string,
		existingTs: Set<string>,
		logEntry: (entry: object) => void,
	): Promise<number> {
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Msg = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Msg[] = [];
		let cursor: string | undefined;
		let pages = 0;

		do {
			const result = await this.web.conversations.history({
				channel: channelId,
				oldest: latestTs,
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) allMessages.push(...(result.messages as Msg[]));
			cursor = result.response_metadata?.next_cursor;
			pages++;
		} while (cursor && pages < 3);

		const relevant = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevant.reverse(); // chronological order

		for (const msg of relevant) {
			const isMom = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			logEntry({
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMom ? "bot" : msg.user!,
				userName: isMom ? undefined : user?.userName,
				displayName: isMom ? undefined : user?.displayName,
				text,
				attachments: [],
				isBot: isMom,
			});
		}

		return relevant.length;
	}

	async backfillThread(
		channelId: string,
		threadTs: string,
		existingTs: Set<string>,
		logEntry: (entry: object) => void,
	): Promise<number> {
		type Msg = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			thread_ts?: string;
			subtype?: string;
			files?: Array<{ name?: string }>;
		};

		const allMessages: Msg[] = [];
		let cursor: string | undefined;
		let pages = 0;

		do {
			const result = await this.web.conversations.replies({
				channel: channelId,
				ts: threadTs,
				limit: 1000,
				cursor,
			});
			if (result.messages) allMessages.push(...(result.messages as Msg[]));
			cursor = result.response_metadata?.next_cursor;
			pages++;
		} while (cursor && pages < 3);

		const relevant = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			if (msg.subtype !== undefined && msg.subtype !== "file_share" && msg.subtype !== "bot_message") return false;
			if (!msg.user && !msg.bot_id) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevant.sort((a, b) => Number.parseFloat(a.ts ?? "0") - Number.parseFloat(b.ts ?? "0"));

		for (const msg of relevant) {
			const isMom = msg.user === this.botUserId;
			const userId = isMom ? "bot" : (msg.user ?? msg.bot_id ?? "unknown");
			const user = msg.user ? this.users.get(msg.user) : undefined;
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			logEntry({
				date: new Date(Number.parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				...(msg.thread_ts && msg.ts !== msg.thread_ts && { threadTs: msg.thread_ts }),
				user: userId,
				userName: isMom ? undefined : user?.userName,
				displayName: isMom ? undefined : user?.displayName,
				text,
				attachments: [],
				isBot: isMom,
			});
		}

		return relevant.length;
	}

	// ==========================================================================
	// Private — fetch users/channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.web.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.web.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// DMs
		cursor = undefined;
		do {
			const result = await this.web.conversations.list({ types: "im", limit: 200, cursor });
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}

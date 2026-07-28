import makeWASocket, {
	type BaileysEventMap,
	DisconnectReason,
	fetchLatestBaileysVersion,
	useMultiFileAuthState,
} from "baileys";
import { Boom } from "@hapi/boom";
import { mkdirSync } from "fs";
import pino from "pino";
import QuickLRU from "quick-lru";
import * as log from "../log.js";
import type { WhatsAppEvent, WhatsAppUser } from "./types.js";

const RECONNECT_MAX_RETRIES = 10;
const RECONNECT_BASE_DELAY_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface WhatsAppClientConfig {
	authDir: string;
	allowFrom?: string[];
}

type WASocket = Awaited<ReturnType<typeof makeWASocket>>;

function normalizeJid(input: string): string {
	const cleaned = input.replace(/^\+/, "").replace(/[^0-9]/g, "");
	if (input.includes("@")) return input;
	return `${cleaned}@s.whatsapp.net`;
}

function sanitizeJidForPath(jid: string): string {
	return encodeURIComponent(jid).replace(/%/g, "_");
}

function unsanitizeJidFromPath(path: string): string {
	return decodeURIComponent(path.replace(/_/g, "%"));
}

export class WhatsAppClient {
	private sock: WASocket | null = null;
	private authDir: string;
	private allowFromJids: Set<string>;
	private reconnectAttempt = 0;
	private messageHandlers: ((event: WhatsAppEvent) => void)[] = [];
	private seenMessageIds = new QuickLRU<string, true>({ maxSize: 1000 });
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private isShuttingDown = false;

	constructor(config: WhatsAppClientConfig) {
		this.authDir = config.authDir;
		this.allowFromJids = new Set((config.allowFrom ?? []).map(normalizeJid));
		mkdirSync(this.authDir, { recursive: true });
	}

	async start(): Promise<void> {
		await this.connect();
	}

	private async connect(): Promise<void> {
		if (this.isShuttingDown) return;

		const { version } = await fetchLatestBaileysVersion();
		const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

		const logger = pino({ level: "warn" });

		this.sock = makeWASocket({
			version,
			auth: state,
			logger,
			printQRInTerminal: true,
			browser: ["pi-digby", "Chrome", "1.0.0"],
		});

		this.sock.ev.on("creds.update", saveCreds);
		this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
		this.sock.ev.on("messages.upsert", (upsert) => this.handleMessagesUpsert(upsert));

		this.startHeartbeat();
	}

	private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]>): void {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			log.info("[WhatsApp] QR code displayed — scan with your phone");
		}

		if (connection === "open") {
			log.info("[WhatsApp] Connected");
			this.reconnectAttempt = 0;
		}

		if (connection === "close") {
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
			const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

			if (shouldReconnect && !this.isShuttingDown) {
				this.scheduleReconnect();
			} else if (statusCode === DisconnectReason.loggedOut) {
				log.warn("[WhatsApp] Logged out — delete auth directory and restart to re-authenticate");
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectAttempt >= RECONNECT_MAX_RETRIES) {
			log.warn("[WhatsApp] Max reconnect attempts reached, giving up");
			return;
		}

		const delay = RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt;
		this.reconnectAttempt++;
		log.info(`[WhatsApp] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${RECONNECT_MAX_RETRIES})`);

		setTimeout(() => {
			this.connect().catch((err) => {
				log.warn("[WhatsApp] Reconnect error", err instanceof Error ? err.message : String(err));
				this.scheduleReconnect();
			});
		}, delay);
	}

	private handleMessagesUpsert(upsert: BaileysEventMap["messages.upsert"]): void {
		if (upsert.type !== "notify") return;

		for (const msg of upsert.messages) {
			if (!msg.message) continue;
			if (msg.key.fromMe) continue;

			const messageId = msg.key.id;
			if (!messageId || this.seenMessageIds.has(messageId)) continue;
			this.seenMessageIds.set(messageId, true);

			const jid = msg.key.remoteJid;
			if (!jid) continue;

			if (this.allowFromJids.size > 0 && !this.allowFromJids.has(jid)) {
				const senderJid = msg.key.participant;
				if (!senderJid || !this.allowFromJids.has(senderJid)) {
					continue;
				}
			}

			const text =
				msg.message.conversation ||
				msg.message.extendedTextMessage?.text ||
				msg.message.imageMessage?.caption ||
				msg.message.videoMessage?.caption ||
				"";

			if (!text) continue;

			const isGroup = jid.endsWith("@g.us");
			const senderJid = isGroup ? msg.key.participant : jid;
			const pushName = msg.pushName;
			const ts = msg.messageTimestamp;
			const timestamp = typeof ts === "number" ? ts : ts ? Number(ts.toString()) : Date.now() / 1000;

			const event: WhatsAppEvent = {
				type: isGroup ? "channel" : "dm",
				source: "whatsapp",
				channel: `whatsapp:${sanitizeJidForPath(jid)}`,
				ts: timestamp.toFixed(6),
				user: senderJid || jid,
				text,
				threadTs: undefined,
			};

			for (const handler of this.messageHandlers) {
				try {
					handler(event);
				} catch (err) {
					log.warn("[WhatsApp] Message handler error", err instanceof Error ? err.message : String(err));
				}
			}
		}
	}

	onMessage(handler: (event: WhatsAppEvent) => void): void {
		this.messageHandlers.push(handler);
	}

	async sendMessage(jid: string, text: string): Promise<void> {
		if (!this.sock) {
			log.warn("[WhatsApp] Cannot send message — not connected");
			return;
		}

		const normalizedJid = normalizeJid(jid);
		const waText = markdownToWhatsApp(text);

		const MAX_LENGTH = 4000;
		if (waText.length <= MAX_LENGTH) {
			await this.sock.sendMessage(normalizedJid, { text: waText });
		} else {
			const chunks = chunkText(waText, MAX_LENGTH);
			for (const chunk of chunks) {
				await this.sock.sendMessage(normalizedJid, { text: chunk });
			}
		}
	}

	async sendFile(jid: string, buffer: Buffer, filename: string, mimetype: string): Promise<void> {
		if (!this.sock) {
			log.warn("[WhatsApp] Cannot send file — not connected");
			return;
		}

		const normalizedJid = normalizeJid(jid);
		await this.sock.sendMessage(normalizedJid, {
			document: buffer,
			fileName: filename,
			mimetype,
		});
	}

	getUser(jid: string): WhatsAppUser | undefined {
		return { jid, name: undefined };
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.sock && !this.isShuttingDown) {
				log.info("[WhatsApp] Heartbeat — connection active");
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	async shutdown(): Promise<void> {
		this.isShuttingDown = true;
		this.stopHeartbeat();
		if (this.sock) {
			try {
				await this.sock.logout();
			} catch {
				// Ignore logout errors
			}
			this.sock = null;
		}
	}
}

function markdownToWhatsApp(text: string): string {
	return (
		text
			// Bold: **text** or __text__ -> *text*
			.replace(/\*\*([^*]+)\*\*/g, "*$1*")
			.replace(/__([^_]+)__/g, "*$1*")
			// Italic: *text* (single) or _text_ -> _text_
			.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_")
			// Strikethrough: ~~text~~ -> ~text~
			.replace(/~~([^~]+)~~/g, "~$1~")
			// Inline code stays the same: `code`
			// Code blocks: ```code``` stays the same
	);
}

function chunkText(text: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		let splitIdx = remaining.lastIndexOf("\n", maxLength);
		if (splitIdx === -1 || splitIdx < maxLength / 2) {
			splitIdx = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitIdx === -1 || splitIdx < maxLength / 2) {
			splitIdx = maxLength;
		}

		chunks.push(remaining.substring(0, splitIdx));
		remaining = remaining.substring(splitIdx).trimStart();
	}

	return chunks;
}

export function jidToChannelId(jid: string): string {
	return `whatsapp:${sanitizeJidForPath(jid)}`;
}

export function channelIdToJid(channelId: string): string {
	const path = channelId.replace(/^whatsapp:/, "");
	return unsanitizeJidFromPath(path);
}

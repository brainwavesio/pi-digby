import type { RunStats } from "../channel/run-stats.js";
import * as log from "../log.js";
import { channelIdToJid, type WhatsAppClient } from "../whatsapp/client.js";
import type { AgentSurface } from "./types.js";
import { THINKING_PLACEHOLDER } from "./types.js";

const MAX_MESSAGE_LENGTH = 4000;

function mdToWhatsApp(text: string): string {
	return (
		text
			// Bold: **text** or __text__ -> *text*
			.replace(/\*\*([^*]+)\*\*/g, "*$1*")
			.replace(/__([^_]+)__/g, "*$1*")
			// Italic: *text* (single asterisk) -> _text_
			.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_")
			// Strikethrough: ~~text~~ -> ~text~
			.replace(/~~([^~]+)~~/g, "~$1~")
	);
}

export class WhatsAppSurface implements AgentSurface {
	private client: WhatsAppClient;
	private channelId: string;
	private jid: string;
	private stats: RunStats;

	private accumulatedText = "";
	private streaming = true;
	private resolved = false;
	private suppressed = false;
	private updateChain: Promise<void> = Promise.resolve();

	constructor(client: WhatsAppClient, channelId: string, stats: RunStats) {
		this.client = client;
		this.channelId = channelId;
		this.jid = channelIdToJid(channelId);
		this.stats = stats;
	}

	private get footer(): string {
		if (this.stats.stepCount === 0 && this.stats.totalCost === 0) return "";
		const cost = this.streaming ? "streaming" : `$${this.stats.totalCost.toFixed(2)}`;
		return `\n\n_${this.stats.stepCount} steps | ${cost}_`;
	}

	private get displayText(): string {
		return (this.accumulatedText || "") + this.footer;
	}

	private truncate(text: string, limit: number): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit - 12)}\n_(truncated)_`;
	}

	private enqueue(fn: () => Promise<void>): void {
		this.updateChain = this.updateChain.then(fn).catch((err) => {
			log.warn("[whatsapp-surface] operation error", err instanceof Error ? err.message : String(err));
		});
	}

	emitThinking(): void {
		this.accumulatedText = THINKING_PLACEHOLDER;
	}

	emitProgress(text: string): void {
		const waText = mdToWhatsApp(text);
		if (this.accumulatedText === THINKING_PLACEHOLDER) {
			this.accumulatedText = waText;
		} else {
			this.accumulatedText = this.accumulatedText ? `${this.accumulatedText}\n${waText}` : waText;
		}
	}

	emitResponse(text: string): void {
		this.accumulatedText = mdToWhatsApp(text);
	}

	emitDetail(text: string): void {
		this.enqueue(async () => {
			try {
				const truncated = this.truncate(mdToWhatsApp(text), MAX_MESSAGE_LENGTH);
				await this.client.sendMessage(this.jid, `_${truncated}_`);
			} catch (err) {
				log.warn("[whatsapp-surface] emitDetail error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	emitReaction(_emoji: string, _messageId: string): void {
		// WhatsApp reactions require message key tracking; skip for now
	}

	emitFile(path: string, title?: string): void {
		this.enqueue(async () => {
			try {
				const { readFileSync } = await import("fs");
				const { basename } = await import("path");
				const buffer = readFileSync(path);
				const filename = title || basename(path);
				await this.client.sendFile(this.jid, buffer, filename, "application/octet-stream");
			} catch (err) {
				log.warn("[whatsapp-surface] emitFile error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	resolve(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;

		if (!this.suppressed && this.accumulatedText.trim() && this.accumulatedText !== THINKING_PLACEHOLDER) {
			this.enqueue(async () => {
				try {
					const display = this.truncate(this.displayText, MAX_MESSAGE_LENGTH);
					await this.client.sendMessage(this.jid, display);
				} catch (err) {
					log.warn("[whatsapp-surface] resolve send error", err instanceof Error ? err.message : String(err));
				}
			});
		}
	}

	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;

		if (this.accumulatedText === THINKING_PLACEHOLDER) {
			this.accumulatedText = "";
		}
		this.accumulatedText = this.accumulatedText
			? `${this.accumulatedText}\n\n_Error: ${error}_`
			: `_Error: ${error}_`;

		this.enqueue(async () => {
			try {
				const display = this.truncate(this.displayText, MAX_MESSAGE_LENGTH);
				await this.client.sendMessage(this.jid, display);
			} catch (err) {
				log.warn("[whatsapp-surface] reject send error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	suppress(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.suppressed = true;
	}

	async flush(): Promise<void> {
		await this.updateChain;
	}

	dispose(): void {
		if (!this.resolved) {
			this.reject("Run ended unexpectedly");
		}
	}

	get finalText(): string {
		return this.accumulatedText;
	}

	get finalMessageTs(): string | null {
		return null;
	}

	get wasDeleted(): boolean {
		return this.suppressed;
	}
}

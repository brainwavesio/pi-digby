import * as log from "../log.js";
import type { RunStats } from "./run-stats.js";

const MAX_MESSAGE_LENGTH = 35000;
const MAX_THREAD_MESSAGE_LENGTH = 20000;

export interface SlackClientLike {
	postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	addReaction(channel: string, ts: string, emoji: string): Promise<void>;
	uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void>;
}

/**
 * Owns the lifecycle of a single Slack message for one agent run.
 *
 * Guarantees:
 * - Every run ends with exactly one terminal op: resolve(), reject(), or deleteMessage()
 * - dispose() is the safety net — if no terminal op was called, it rejects
 * - The footer (steps/cost) is auto-computed from stats; callers never compose it
 * - All Slack operations are serialized through updateChain
 */
export class RunContext {
	private client: SlackClientLike;
	private channel: string;
	private replyThreadTs?: string;
	private stats: RunStats;

	private messageTs: string | null = null;
	private accumulatedText = "";
	private streaming = true;
	private resolved = false;
	private threadMessageTs: string[] = [];
	private updateChain: Promise<void> = Promise.resolve();

	constructor(client: SlackClientLike, channel: string, stats: RunStats, replyThreadTs?: string) {
		this.client = client;
		this.channel = channel;
		this.stats = stats;
		this.replyThreadTs = replyThreadTs;
	}

	// ==========================================================================
	// Display computation
	// ==========================================================================

	/** Auto-computed footer from stats + streaming state */
	private get footer(): string {
		if (this.stats.stepCount === 0 && this.stats.totalCost === 0) return "";
		const cost = this.streaming ? "streaming" : `$${this.stats.totalCost.toFixed(2)}`;
		return `    _\u00AB${this.stats.stepCount} steps \u00B7 ${cost}\u00BB_`;
	}

	/** Full display text: accumulated content + auto footer */
	private get displayText(): string {
		return (this.accumulatedText || "") + this.footer;
	}

	private truncate(text: string, limit: number): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit)}\n_(truncated)_`;
	}

	// ==========================================================================
	// Serialized Slack operations
	// ==========================================================================

	private enqueueUpdate(fn: () => Promise<void>): void {
		this.updateChain = this.updateChain.then(fn).catch((err) => {
			log.warn("[run-context] Slack update error", err instanceof Error ? err.message : String(err));
		});
	}

	private enqueuePostOrUpdate(display: string): void {
		this.enqueueUpdate(async () => {
			try {
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, display);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, display, this.replyThreadTs);
				}
			} catch (err) {
				log.warn("[run-context] post/update error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Public API — streaming operations (called by event handler / runner)
	// ==========================================================================

	static readonly THINKING_PLACEHOLDER = "\ud83e\udd14 _Thinking_";

	/** Post the initial "thinking" message. Call once at run start. */
	postThinking(): void {
		this.accumulatedText = RunContext.THINKING_PLACEHOLDER;
		this.enqueueUpdate(async () => {
			try {
				if (!this.messageTs) {
					this.messageTs = await this.client.postMessage(
						this.channel,
						RunContext.THINKING_PLACEHOLDER,
						this.replyThreadTs,
					);
				}
			} catch (err) {
				log.warn("[run-context] postThinking error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	/** Append text to the message. If still showing the thinking placeholder, replaces it. */
	respond(text: string): void {
		if (this.accumulatedText === RunContext.THINKING_PLACEHOLDER) {
			this.accumulatedText = text;
		} else {
			this.accumulatedText = this.accumulatedText ? `${this.accumulatedText}\n${text}` : text;
		}
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	/** Replace all accumulated text (for final response). */
	replaceMessage(text: string): void {
		this.accumulatedText = text;
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	/** Post a reply in the thread under the bot's main message. */
	respondInThread(text: string): void {
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const truncated = this.truncate(text, MAX_THREAD_MESSAGE_LENGTH);
				const ts = await this.client.postMessage(this.channel, truncated, this.messageTs);
				this.threadMessageTs.push(ts);
			} catch (err) {
				log.warn("[run-context] respondInThread error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	/** React to a specific message with an emoji. */
	addReaction(emoji: string, triggerTs: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.addReaction(this.channel, triggerTs, emoji);
			} catch (err) {
				log.warn("[run-context] addReaction error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	/** Upload a file to the channel. */
	uploadFile(filePath: string, title?: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.uploadFile(
					this.channel,
					filePath,
					title,
					this.replyThreadTs || this.messageTs || undefined,
				);
			} catch (err) {
				log.warn("[run-context] uploadFile error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Terminal operations — exactly one fires per run
	// ==========================================================================

	/** Mark run complete. Sets streaming=false so footer shows cost instead of "streaming". */
	resolve(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	/** Mark run failed. Appends error to message, sets streaming=false. */
	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.accumulatedText = this.accumulatedText
			? `${this.accumulatedText}\n\n_\u26a0 ${error}_`
			: `_\u26a0 ${error}_`;
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	/** Delete the message entirely (for [SILENT] responses). Terminal. */
	deleteMessage(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.enqueueUpdate(async () => {
			try {
				for (const ts of this.threadMessageTs) {
					await this.client.deleteMessage(this.channel, ts);
				}
				this.threadMessageTs = [];
				if (this.messageTs) {
					await this.client.deleteMessage(this.channel, this.messageTs);
					this.messageTs = null;
				}
			} catch (err) {
				log.warn("[run-context] deleteMessage error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	/** Wait for all queued Slack operations to complete. */
	async flush(): Promise<void> {
		await this.updateChain;
	}

	/** Safety net: if no terminal op was called, reject with a default message. */
	dispose(): void {
		if (!this.resolved) {
			this.reject("Run ended unexpectedly");
		}
	}
}

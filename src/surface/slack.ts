import type { RunStats } from "../channel/run-stats.js";
import * as log from "../log.js";
import type { AgentSurface } from "./types.js";
import { THINKING_PLACEHOLDER } from "./types.js";

const MAX_MESSAGE_LENGTH = 35000;
const MAX_THREAD_MESSAGE_LENGTH = 20000;

/**
 * Convert standard markdown to Slack mrkdwn:
 * - *italic* → _italic_ (skipping ** so bold isn't clobbered)
 * - **bold** → *bold*
 */
function mdToMrkdwn(text: string): string {
	return text
		.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_") // italic first, skip **
		.replace(/\*\*([^*]+)\*\*/g, "*$1*"); // then collapse ** to *
}

export interface MessageTransport {
	postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	addReaction(channel: string, ts: string, emoji: string): Promise<void>;
	uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void>;
}

/**
 * Slack implementation of AgentSurface.
 *
 * Owns the lifecycle of a single Slack message for one agent run.
 *
 * Guarantees:
 * - Every run ends with exactly one terminal op: resolve(), reject(), or suppress()
 * - dispose() is the safety net — if no terminal op was called, it rejects
 * - The footer (steps/cost) is auto-computed from stats; callers never compose it
 * - All Slack operations are serialized through updateChain
 */
export class SlackSurface implements AgentSurface {
	private client: MessageTransport;
	private channel: string;
	private replyThreadTs?: string;
	private stats: RunStats;

	private messageTs: string | null = null;
	private accumulatedText = "";
	private streaming = true;
	private resolved = false;
	private deleted = false;
	private threadMessageTs: string[] = [];
	private updateChain: Promise<void> = Promise.resolve();

	constructor(client: MessageTransport, channel: string, stats: RunStats, replyThreadTs?: string) {
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
			log.warn("[slack-surface] Slack update error", err instanceof Error ? err.message : String(err));
		});
	}

	private enqueuePostOrUpdate(display: string): void {
		this.enqueueUpdate(async () => {
			const doUpdate = async (text: string) => {
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, text);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, text, this.replyThreadTs);
				}
			};

			try {
				await doUpdate(display);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("msg_too_long")) {
					log.warn("[slack-surface] post/update error", msg);
					return;
				}
				try {
					await doUpdate(this.truncate(display, 30000));
				} catch {
					// Both update attempts failed — upload the full content as a file
					try {
						const ts = new Date().getTime();
						const filename = `response-${ts}.md`;
						await this.client.uploadContent(
							this.channel,
							this.accumulatedText || display,
							filename,
							"Response (too long for message)",
							this.replyThreadTs,
						);
						// Update the placeholder message to indicate the file was uploaded
						try {
							await doUpdate("_Response too long — uploaded as a file attachment above._");
						} catch {
							// ignore — placeholder update is best-effort
						}
					} catch (uploadErr) {
						log.warn(
							"[slack-surface] file upload fallback failed",
							uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
						);
					}
				}
			}
		});
	}

	// ==========================================================================
	// AgentSurface — streaming operations
	// ==========================================================================

	emitThinking(): void {
		this.accumulatedText = THINKING_PLACEHOLDER;
		this.enqueueUpdate(async () => {
			try {
				if (!this.messageTs) {
					this.messageTs = await this.client.postMessage(this.channel, THINKING_PLACEHOLDER, this.replyThreadTs);
				}
			} catch (err) {
				log.warn("[slack-surface] emitThinking error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	emitProgress(text: string): void {
		const mrkdwn = mdToMrkdwn(text);
		if (this.accumulatedText === THINKING_PLACEHOLDER) {
			this.accumulatedText = mrkdwn;
		} else {
			this.accumulatedText = this.accumulatedText ? `${this.accumulatedText}\n${mrkdwn}` : mrkdwn;
		}
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	emitResponse(text: string): void {
		this.accumulatedText = mdToMrkdwn(text);
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	emitDetail(text: string): void {
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const truncated = this.truncate(mdToMrkdwn(text), MAX_THREAD_MESSAGE_LENGTH);
				const ts = await this.client.postMessage(this.channel, truncated, this.messageTs);
				this.threadMessageTs.push(ts);
			} catch (err) {
				log.warn("[slack-surface] emitDetail error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	emitReaction(emoji: string, triggerTs: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.addReaction(this.channel, triggerTs, emoji);
			} catch (err) {
				log.warn("[slack-surface] emitReaction error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	emitFile(filePath: string, title?: string): void {
		this.enqueueUpdate(async () => {
			try {
				await this.client.uploadFile(
					this.channel,
					filePath,
					title,
					this.replyThreadTs || this.messageTs || undefined,
				);
			} catch (err) {
				log.warn("[slack-surface] emitFile error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Terminal operations — exactly one fires per run
	// ==========================================================================

	resolve(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		if (this.accumulatedText === THINKING_PLACEHOLDER) {
			this.accumulatedText = "";
		}
		this.accumulatedText = this.accumulatedText
			? `${this.accumulatedText}\n\n_\u26a0 ${error}_`
			: `_\u26a0 ${error}_`;
		this.enqueuePostOrUpdate(this.truncate(this.displayText, MAX_MESSAGE_LENGTH));
	}

	suppress(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.deleted = true;
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
				log.warn("[slack-surface] suppress error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async flush(): Promise<void> {
		await this.updateChain;
	}

	dispose(): void {
		if (!this.resolved) {
			this.reject("Run ended unexpectedly");
		}
	}

	// ==========================================================================
	// Readonly getters for post-run logging
	// ==========================================================================

	get finalMessageTs(): string | null {
		return this.messageTs;
	}

	get finalText(): string {
		return this.accumulatedText;
	}

	get wasDeleted(): boolean {
		return this.deleted;
	}
}

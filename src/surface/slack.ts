import type { KnownBlock } from "@slack/web-api";
import type { RunStats } from "../channel/run-stats.js";
import * as log from "../log.js";
import type { AgentSurface, MessagePayload, MessageTransport } from "./types.js";

export type { MessageTransport };

const MAX_SECTION_TEXT = 3000;
const MAX_THREAD_MESSAGE_LENGTH = 20000;
const MAX_VISIBLE_STEPS = 10;

const LOADING_MESSAGES = ["is reading the context...", "is thinking...", "is working on it...", "is almost done..."];

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

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}\n_(truncated)_`;
}

// =============================================================================
// TaskCard — tracks tool steps and renders Block Kit blocks
// =============================================================================

interface Step {
	toolCallId: string;
	toolName: string;
	label: string;
	state: "running" | "done" | "error";
	durationMs?: number;
}

function formatStep(step: Step): string {
	if (step.state === "done") {
		const dur = step.durationMs !== undefined ? (step.durationMs / 1000).toFixed(1) : "?";
		return `✓  \`${step.toolName}\` ${step.label}   _${dur}s_`;
	}
	if (step.state === "error") {
		return `✗  \`${step.toolName}\` ${step.label}   _error_`;
	}
	// running
	return `*→  \`${step.toolName}\` ${step.label}*`;
}

class TaskCard {
	private steps: Step[] = [];

	stepStart(toolCallId: string, toolName: string, label: string): void {
		this.steps.push({ toolCallId, toolName, label, state: "running" });
	}

	stepEnd(toolCallId: string, durationMs: number, isError: boolean): void {
		const step = this.steps.find((s) => s.toolCallId === toolCallId);
		if (step) {
			step.state = isError ? "error" : "done";
			step.durationMs = durationMs;
		}
	}

	toRunningBlocks(stats: RunStats, isStreaming: boolean): KnownBlock[] {
		const total = this.steps.length;
		const hidden = Math.max(0, total - MAX_VISIBLE_STEPS);
		const visible = this.steps.slice(hidden);

		const elements: Array<{ type: "mrkdwn"; text: string }> = visible.map((step) => ({
			type: "mrkdwn",
			text: formatStep(step),
		}));

		if (hidden > 0) {
			elements.unshift({ type: "mrkdwn", text: `_... and ${hidden} more_` });
		}

		const cost = isStreaming ? "streaming" : `$${stats.totalCost.toFixed(2)}`;
		const footerText = `_${stats.stepCount} steps · ${cost}_`;

		const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text: "🤔 *Working on it...*" } }];

		// Context block holds max 10 elements — split if needed
		for (let i = 0; i < elements.length; i += 10) {
			blocks.push({ type: "context", elements: elements.slice(i, i + 10) });
		}

		blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footerText }] });

		return blocks;
	}

	toResolvedBlocks(responseText: string, stats: RunStats, isStreaming: boolean): KnownBlock[] {
		const sectionText = truncateText(mdToMrkdwn(responseText), MAX_SECTION_TEXT);

		// Collapse steps to a summary: "read, bash (×2), linear"
		const counts = new Map<string, number>();
		for (const step of this.steps) {
			counts.set(step.toolName, (counts.get(step.toolName) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [name, count] of counts) {
			parts.push(count > 1 ? `${name} (×${count})` : name);
		}
		const toolSummary = parts.length > 0 ? parts.join(", ") : "no tools";

		const cost = isStreaming ? "streaming" : stats.totalCost > 0 ? `$${stats.totalCost.toFixed(2)}` : "—";
		const summary = `✓  ${toolSummary}   _${stats.stepCount} steps · ${cost}_`;

		return [
			{ type: "section", text: { type: "mrkdwn", text: sectionText } },
			{ type: "context", elements: [{ type: "mrkdwn", text: summary }] },
		];
	}

	toErrorBlocks(errorText: string, stats: RunStats): KnownBlock[] {
		const counts = new Map<string, number>();
		for (const step of this.steps) {
			counts.set(step.toolName, (counts.get(step.toolName) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [name, count] of counts) {
			parts.push(count > 1 ? `${name} (×${count})` : name);
		}
		const toolSummary = parts.length > 0 ? parts.join(", ") : "no tools";
		const summary = `_${stats.stepCount} steps · ${toolSummary}_`;

		return [
			{ type: "section", text: { type: "mrkdwn", text: `_⚠ ${errorText}_` } },
			{ type: "context", elements: [{ type: "mrkdwn", text: summary }] },
		];
	}
}

// =============================================================================
// SlackSurface
// =============================================================================

/**
 * Slack implementation of AgentSurface.
 *
 * Owns the lifecycle of a single Block Kit task card for one agent run.
 *
 * Guarantees:
 * - Every run ends with exactly one terminal op: resolve(), reject(), or suppress()
 * - dispose() is the safety net — if no terminal op was called, it rejects
 * - The task card updates in place through the whole lifecycle (never a fresh post)
 * - All Slack operations are serialized through updateChain
 */
export class SlackSurface implements AgentSurface {
	private client: MessageTransport;
	private channel: string;
	private replyThreadTs?: string;
	private stats: RunStats;
	private onFirstResponseFn?: () => void;

	private taskCard = new TaskCard();
	private messageTs: string | null = null;
	private responseText = "";
	private hasResponse = false;
	private streaming = true;
	private resolved = false;
	private deleted = false;
	private hasFallenBackToFile = false;
	private titleSet = false;
	private threadMessageTs: string[] = [];
	private updateChain: Promise<void> = Promise.resolve();

	constructor(
		client: MessageTransport,
		channel: string,
		stats: RunStats,
		replyThreadTs?: string,
		onFirstResponse?: () => void,
	) {
		this.client = client;
		this.channel = channel;
		this.stats = stats;
		this.replyThreadTs = replyThreadTs;
		this.onFirstResponseFn = onFirstResponse;
	}

	// ==========================================================================
	// Block Kit payload helpers
	// ==========================================================================

	private runningPayload(): MessagePayload {
		return {
			text: "Digby is working on it...",
			blocks: this.taskCard.toRunningBlocks(this.stats, this.streaming),
		};
	}

	private resolvedPayload(): MessagePayload {
		return {
			text: this.responseText || "Done.",
			blocks: this.taskCard.toResolvedBlocks(this.responseText, this.stats, this.streaming),
		};
	}

	private errorPayload(errorText: string): MessagePayload {
		return {
			text: `Error: ${errorText}`,
			blocks: this.taskCard.toErrorBlocks(errorText, this.stats),
		};
	}

	// ==========================================================================
	// Serialized Slack operations
	// ==========================================================================

	private enqueueUpdate(fn: () => Promise<void>): void {
		this.updateChain = this.updateChain.then(fn).catch((err) => {
			log.warn("[slack-surface] Slack update error", err instanceof Error ? err.message : String(err));
		});
	}

	private enqueuePostOrUpdate(payload: MessagePayload): void {
		this.enqueueUpdate(async () => {
			const doUpdate = async (p: MessagePayload) => {
				if (this.messageTs) {
					await this.client.updateMessage(this.channel, this.messageTs, p);
				} else {
					this.messageTs = await this.client.postMessage(this.channel, p, this.replyThreadTs);
				}
			};

			try {
				await doUpdate(payload);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("msg_too_long")) {
					log.warn("[slack-surface] post/update error", msg);
					return;
				}
				// Truncate the section text in blocks if it's a block payload
				const truncated: MessagePayload =
					typeof payload === "object" && payload.blocks
						? {
								text: truncateText(payload.text, 30000),
								blocks: payload.blocks.map((b: any) => {
									if (b.type === "section" && b.text?.text) {
										return { ...b, text: { ...b.text, text: truncateText(b.text.text, MAX_SECTION_TEXT) } };
									}
									return b;
								}),
							}
						: truncateText(payload as string, 30000);
				try {
					await doUpdate(truncated);
				} catch {
					if (!this.hasFallenBackToFile) {
						this.hasFallenBackToFile = true;
						try {
							const ts = Date.now();
							const filename = `response-${ts}.md`;
							await this.client.uploadContent(
								this.channel,
								this.responseText || (typeof payload === "string" ? payload : payload.text),
								filename,
								"Response (too long for message)",
								this.replyThreadTs,
							);
							try {
								await doUpdate("_Response too long — replying as a file attachment._");
							} catch {
								// best-effort placeholder update
							}
						} catch (uploadErr) {
							log.warn(
								"[slack-surface] file upload fallback failed",
								uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
							);
						}
					}
				}
			}
		});
	}

	// ==========================================================================
	// AgentSurface — streaming operations
	// ==========================================================================

	emitThinking(): void {
		this.enqueueUpdate(async () => {
			try {
				// setStatus requires an existing thread — skip for top-level channel posts
				if (this.replyThreadTs) {
					await this.client.setThreadStatus(this.channel, this.replyThreadTs, "is thinking...", LOADING_MESSAGES);
				}
				if (!this.messageTs) {
					this.messageTs = await this.client.postMessage(this.channel, this.runningPayload(), this.replyThreadTs);
				}
			} catch (err) {
				log.warn("[slack-surface] emitThinking error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	emitToolStart(toolCallId: string, toolName: string, label: string): void {
		this.taskCard.stepStart(toolCallId, toolName, label);
		this.enqueuePostOrUpdate(this.runningPayload());
	}

	emitToolEnd(toolCallId: string, durationMs: number, isError: boolean): void {
		this.taskCard.stepEnd(toolCallId, durationMs, isError);
		this.enqueuePostOrUpdate(this.runningPayload());
	}

	emitResponse(text: string): void {
		this.responseText = mdToMrkdwn(text);
		this.hasResponse = true;
		this.enqueuePostOrUpdate(this.resolvedPayload());
		// setTitle on first response (DM threads only)
		if (!this.titleSet && this.onFirstResponseFn) {
			this.titleSet = true;
			this.enqueueUpdate(async () => {
				try {
					this.onFirstResponseFn!();
				} catch (err) {
					log.warn("[slack-surface] setTitle error", err instanceof Error ? err.message : String(err));
				}
			});
		}
	}

	emitDetail(text: string): void {
		this.enqueueUpdate(async () => {
			if (!this.messageTs) return;
			try {
				const truncated = truncateText(mdToMrkdwn(text), MAX_THREAD_MESSAGE_LENGTH);
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
		const payload = this.hasResponse ? this.resolvedPayload() : this.runningPayload();
		this.enqueuePostOrUpdate(payload);
	}

	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.streaming = false;
		this.enqueuePostOrUpdate(this.errorPayload(error));
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
		return this.responseText;
	}

	get wasDeleted(): boolean {
		return this.deleted;
	}
}

import type { RunStats } from "../channel/run-stats.js";
import type { LinearClient } from "../linear/client.js";
import * as log from "../log.js";
import type { AgentSurface } from "./types.js";

/**
 * Linear implementation of AgentSurface.
 *
 * Differences from Slack:
 * - Activities are append-only (no edit-in-place, no delete)
 * - emitResponse() buffers text; final message posted at resolve()
 * - Tool progress emitted as ephemeral thoughts
 * - Reactions/files posted as thoughts rather than native features
 */
export class LinearSurface implements AgentSurface {
	private bufferedResponse = "";
	private resolved = false;
	private suppressed = false;
	private pendingOps: Promise<void> = Promise.resolve();

	constructor(
		private client: LinearClient,
		private sessionId: string,
		_stats: RunStats,
	) {}

	private enqueue(fn: () => Promise<void>): void {
		this.pendingOps = this.pendingOps.then(fn).catch((err) => {
			log.warn("[linear-surface] operation error", err instanceof Error ? err.message : String(err));
		});
	}

	emitThinking(): void {
		this.enqueue(() => this.client.emitThought(this.sessionId, "Picking up this issue..."));
	}

	emitToolStart(_toolCallId: string, _toolName: string, _label: string): void {
		// no-op: Linear surface doesn't show per-tool progress inline
	}

	emitToolEnd(_toolCallId: string, _durationMs: number, _isError: boolean): void {
		// no-op: Linear surface doesn't show per-tool progress inline
	}

	emitResponse(text: string): void {
		this.bufferedResponse = text;
	}

	emitDetail(text: string): void {
		this.enqueue(() => this.client.emitThought(this.sessionId, text, false));
	}

	emitReaction(emoji: string, _messageId: string): void {
		// Persistent: emoji reactions are infrequent and worth keeping.
		this.enqueue(() => this.client.emitThought(this.sessionId, emoji, false));
	}

	emitFile(path: string, title?: string): void {
		// Persistent: file references should be visible after the run completes.
		this.enqueue(() => this.client.emitThought(this.sessionId, `File: ${title || path}`, false));
	}

	resolve(): void {
		if (this.resolved) return;
		this.resolved = true;
		if (!this.suppressed && this.bufferedResponse.trim()) {
			this.enqueue(() => this.client.emitResponse(this.sessionId, this.bufferedResponse));
		}
	}

	reject(error: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.enqueue(() => this.client.emitError(this.sessionId, error));
	}

	suppress(): void {
		if (this.resolved) return;
		this.resolved = true;
		this.suppressed = true;
	}

	async flush(): Promise<void> {
		await this.pendingOps;
	}

	dispose(): void {
		if (!this.resolved) {
			this.reject("Run ended unexpectedly");
		}
	}

	get finalText(): string {
		return this.bufferedResponse;
	}

	get finalMessageTs(): string | null {
		return null;
	}

	get wasDeleted(): boolean {
		return this.suppressed;
	}
}

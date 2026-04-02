/**
 * Event subscriber — translates AgentSession events to Slack updates via RunContext.
 *
 * Ported from upstream agent.ts session.subscribe() handler.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { RunContext } from "../channel/run-context.js";
import { isDebugThreadingEnabled } from "../config.js";
import * as log from "../log.js";

export interface RunStats {
	stepCount: number;
	totalCost: number;
	stopReason: string;
	errorMessage?: string;
	lastStreamedText: string;
}

/**
 * Extract displayable text from a tool result (string or MCP-style content array).
 */
function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}
	return JSON.stringify(result);
}

/**
 * Format tool arguments for display in Slack thread.
 */
function formatToolArgsForSlack(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}
		if (key === "offset" || key === "limit") continue;
		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}
	return lines.join("\n");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

/**
 * Create an event handler that bridges AgentSession events to Slack via RunContext.
 *
 * @param ctx - The RunContext for Slack communication
 * @param channelId - Channel ID for logging
 * @returns Object with the handler function and a stats reference for post-run inspection
 */
export function createEventHandler(
	ctx: RunContext,
	channelId: string,
): { handler: (event: AgentSessionEvent) => void; stats: RunStats } {
	const stats: RunStats = {
		stepCount: 0,
		totalCost: 0,
		stopReason: "stop",
		errorMessage: undefined,
		lastStreamedText: "",
	};

	const pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();
	const debugThreading = isDebugThreadingEnabled();

	const handler = (event: AgentSessionEvent): void => {
		if (event.type === "tool_execution_start") {
			const e = event as any;
			const args = (e.args || {}) as Record<string, unknown>;
			const label = (args.label as string) || e.toolName;

			pendingTools.set(e.toolCallId, {
				toolName: e.toolName,
				args: e.args,
				startTime: Date.now(),
			});

			log.toolStart(channelId, e.toolName, label);
			ctx.respond(`_\u2192 ${label}_`, false);
		} else if (event.type === "tool_execution_end") {
			const e = event as any;
			const resultStr = extractToolResultText(e.result);
			const pending = pendingTools.get(e.toolCallId);
			pendingTools.delete(e.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;
			stats.stepCount++;

			log.toolEnd(channelId, e.toolName, durationMs, e.isError, resultStr);

			// Post detailed args + result to debug thread
			if (debugThreading) {
				const label = pending?.args ? ((pending.args as Record<string, unknown>).label as string) : undefined;
				const argsFormatted = pending
					? formatToolArgsForSlack(pending.args as Record<string, unknown>)
					: "(args not found)";
				const duration = (durationMs / 1000).toFixed(1);
				let threadMessage = `*${e.isError ? "\u2717" : "\u2713"} ${e.toolName}*`;
				if (label) threadMessage += `: ${label}`;
				threadMessage += ` (${duration}s)\n`;
				if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
				threadMessage += `*Result:*\n\`\`\`\n${truncate(resultStr, 3000)}\n\`\`\``;
				ctx.respondInThread(threadMessage);
			}

			if (e.isError) {
				ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false);
			}
		} else if (event.type === "message_end") {
			const e = event as any;
			if (e.message?.role === "assistant") {
				const assistantMsg = e.message;

				if (assistantMsg.stopReason) {
					stats.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					stats.errorMessage = assistantMsg.errorMessage;
				}

				// Accumulate usage/cost
				if (assistantMsg.usage?.cost) {
					stats.totalCost += assistantMsg.usage.cost.total || 0;
				}

				// Extract text and thinking from message content
				const content = e.message.content;
				if (Array.isArray(content)) {
					const thinkingParts: string[] = [];
					const textParts: string[] = [];
					for (const part of content) {
						if (part.type === "thinking") {
							thinkingParts.push(part.thinking);
						} else if (part.type === "text") {
							textParts.push(part.text);
						}
					}

					// Post thinking to thread only
					if (debugThreading) {
						for (const thinking of thinkingParts) {
							ctx.respondInThread(`_${thinking}_`);
						}
					}

					const text = textParts.join("\n");
					if (text.trim()) {
						stats.lastStreamedText = text;
						ctx.respond(text, true);
						if (debugThreading) {
							ctx.respondInThread(text);
						}
					}
				}
			}
		} else if (event.type === "compaction_start") {
			log.info(`[${channelId}] Compaction started (reason: ${event.reason})`);
			ctx.respond("_Compacting context..._", false);
		} else if (event.type === "compaction_end") {
			if (event.result) {
				log.info(`[${channelId}] Compaction complete: ${event.result.tokensBefore} tokens compacted`);
			} else if (event.aborted) {
				log.info(`[${channelId}] Compaction aborted`);
			}
		} else if (event.type === "auto_retry_start") {
			const e = event as any;
			log.warn(`[${channelId}] Retrying (${e.attempt}/${e.maxAttempts}): ${e.errorMessage}`);
			ctx.respond(`_Retrying (${e.attempt}/${e.maxAttempts})..._`, false);
		} else if (event.type === "auto_retry_end") {
			const e = event as any;
			if (!e.success) {
				log.warn(`[${channelId}] Retries exhausted: ${e.finalError}`);
				ctx.respond("_Retries exhausted_", false);
			}
		}
	};

	return { handler, stats };
}

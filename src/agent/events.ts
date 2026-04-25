/**
 * Event subscriber — translates AgentSession events to output via AgentSurface.
 *
 * Ported from upstream agent.ts session.subscribe() handler.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { RunStats } from "../channel/run-stats.js";
import { isDebugThreadingEnabled } from "../config.js";
import * as log from "../log.js";
import type { AgentSurface } from "../surface/types.js";

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
 * Format tool arguments for display in thread detail.
 */
function formatToolArgs(args: Record<string, unknown>): string {
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
 * Build a human-readable label for a tool call. The pi-mcp-adapter registers
 * a single gateway tool called "mcp" that proxies every MCP server call through
 * a `tool` arg, so without unwrapping it every MCP invocation looks identical
 * in the surface ("→ mcp"). Surface what the gateway is actually doing.
 */
function buildToolLabel(toolName: string, args: Record<string, unknown>): string {
	if (typeof args.label === "string" && args.label) return args.label;

	if (toolName === "mcp") {
		const tool = typeof args.tool === "string" ? args.tool : undefined;
		const server = typeof args.server === "string" ? args.server : undefined;
		if (tool) return server ? `mcp ${server}/${tool}` : `mcp ${tool}`;
		if (typeof args.search === "string") return `mcp search "${args.search}"`;
		if (typeof args.describe === "string") return `mcp describe ${args.describe}`;
		if (typeof args.connect === "string") return `mcp connect ${args.connect}`;
		if (server) return `mcp list ${server}`;
		if (typeof args.action === "string") return `mcp ${args.action}`;
		return "mcp status";
	}

	return toolName;
}

/**
 * Create an event handler that bridges AgentSession events to the AgentSurface.
 *
 * @param ctx - The AgentSurface for output
 * @param channelId - Channel ID for logging
 * @returns The event handler function
 */
export function createEventHandler(
	ctx: AgentSurface,
	channelId: string,
	stats: RunStats,
): (event: AgentSessionEvent) => void {
	const pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();
	const debugThreading = isDebugThreadingEnabled();

	const handler = (event: AgentSessionEvent): void => {
		if (event.type === "tool_execution_start") {
			const e = event as any;
			const args = (e.args || {}) as Record<string, unknown>;
			const label = buildToolLabel(e.toolName, args);

			pendingTools.set(e.toolCallId, {
				toolName: e.toolName,
				args: e.args,
				startTime: Date.now(),
			});

			stats.lastStepAt = Date.now(); // reset per-step timeout clock

			log.toolStart(channelId, e.toolName, label);
			ctx.emitProgress(`*\u2192 ${label}*`);
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
					? formatToolArgs(pending.args as Record<string, unknown>)
					: "(args not found)";
				const duration = (durationMs / 1000).toFixed(1);
				let threadMessage = `**${e.isError ? "\u2717" : "\u2713"} ${e.toolName}**`;
				if (label) threadMessage += `: ${label}`;
				threadMessage += ` (${duration}s)\n`;
				if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
				threadMessage += `**Result:**\n\`\`\`\n${truncate(resultStr, 3000)}\n\`\`\``;
				ctx.emitDetail(threadMessage);
			}

			if (e.isError) {
				ctx.emitProgress(`*Error: ${truncate(resultStr, 200)}*`);
			}
		} else if (event.type === "message_end") {
			const e = event as any;
			stats.lastStepAt = Date.now(); // model turn = activity, reset per-step clock
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
							ctx.emitDetail(`*${thinking}*`);
						}
					}

					const text = textParts.join("\n");
					if (text.trim()) {
						stats.lastStreamedText = text;
						ctx.emitResponse(text);
						if (debugThreading) {
							ctx.emitDetail(text);
						}
					}
				}
			}
		} else if (event.type === "compaction_start") {
			log.info(`[${channelId}] Compaction started (reason: ${event.reason})`);
			ctx.emitProgress("*Compacting context...*");
		} else if (event.type === "compaction_end") {
			if (event.result) {
				log.info(`[${channelId}] Compaction complete: ${event.result.tokensBefore} tokens compacted`);
			} else if (event.aborted) {
				log.info(`[${channelId}] Compaction aborted`);
			}
		} else if (event.type === "auto_retry_start") {
			const e = event as any;
			log.warn(`[${channelId}] Retrying (${e.attempt}/${e.maxAttempts}): ${e.errorMessage}`);
			ctx.emitProgress(`*Retrying (${e.attempt}/${e.maxAttempts})...*`);
		} else if (event.type === "auto_retry_end") {
			const e = event as any;
			if (!e.success) {
				log.warn(`[${channelId}] Retries exhausted: ${e.finalError}`);
				ctx.emitProgress("*Retries exhausted*");
			}
		}
	};

	return handler;
}

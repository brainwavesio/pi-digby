import type { KnownBlock } from "@slack/web-api";

export type MessagePayload = string | { text: string; blocks: KnownBlock[] };

export interface MessageTransport {
	postMessage(channel: string, payload: MessagePayload, threadTs?: string): Promise<string>;
	updateMessage(channel: string, ts: string, payload: MessagePayload): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	addReaction(channel: string, ts: string, emoji: string): Promise<void>;
	uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void>;
	uploadContent(channel: string, content: string, filename: string, title?: string, threadTs?: string): Promise<void>;
	setThreadStatus(channel: string, threadTs: string, status: string, loadingMessages?: string[]): Promise<void>;
	setTitle(channel: string, threadTs: string, title: string): Promise<void>;
}

/** Surface through which the agent communicates with the user. */
export interface AgentSurface {
	/** Agent is starting work. */
	emitThinking(): void;

	/** Tool call started. */
	emitToolStart(toolCallId: string, toolName: string, label: string): void;

	/** Tool call completed. */
	emitToolEnd(toolCallId: string, durationMs: number, isError: boolean): void;

	/** Final response text. */
	emitResponse(text: string): void;

	/** Supplementary detail (reasoning, debug info). Collapsed/threaded. */
	emitDetail(text: string): void;

	/** React to a user message. */
	emitReaction(emoji: string, messageId: string): void;

	/** Share a file. */
	emitFile(path: string, title?: string): void;

	/** Mark run complete. Terminal. */
	resolve(): void;

	/** Mark run failed. Terminal. */
	reject(error: string): void;

	/** Suppress all output (for [SILENT] responses). Terminal. */
	suppress(): void;

	/** Wait for all pending operations to complete. */
	flush(): Promise<void>;

	/** Safety net — rejects if no terminal op was called. */
	dispose(): void;

	readonly finalText: string;
	readonly finalMessageTs: string | null;
	readonly wasDeleted: boolean;
}

export const THINKING_PLACEHOLDER = "🤔 _Thinking_";

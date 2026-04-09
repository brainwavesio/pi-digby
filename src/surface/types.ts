/** Surface through which the agent communicates with the user. */
export interface AgentSurface {
	/** Agent is starting work. */
	emitThinking(): void;

	/** Tool/step progress (tool labels, retry notices). Appended to output stream. */
	emitProgress(text: string): void;

	/** Final response text. Replaces all prior progress. */
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

export const THINKING_PLACEHOLDER = "\ud83e\udd14 _Thinking_";

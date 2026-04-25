/**
 * Mutable stats object shared between the surface (for footer rendering)
 * and the event handler (which updates counts during the run).
 */
export interface RunStats {
	stepCount: number;
	totalCost: number;
	stopReason: string;
	errorMessage?: string;
	lastStreamedText: string;
	/** Timestamp of the last step activity (tool call start or model turn). Used for per-step timeout. */
	lastStepAt: number;
}

export function createRunStats(): RunStats {
	return {
		stepCount: 0,
		totalCost: 0,
		stopReason: "stop",
		errorMessage: undefined,
		lastStreamedText: "",
		lastStepAt: Date.now(),
	};
}

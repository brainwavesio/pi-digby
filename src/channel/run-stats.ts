/**
 * Mutable stats object shared between RunContext (for footer rendering)
 * and the event handler (which updates counts during the run).
 */
export interface RunStats {
	stepCount: number;
	totalCost: number;
	stopReason: string;
	errorMessage?: string;
	lastStreamedText: string;
}

export function createRunStats(): RunStats {
	return {
		stepCount: 0,
		totalCost: 0,
		stopReason: "stop",
		errorMessage: undefined,
		lastStreamedText: "",
	};
}

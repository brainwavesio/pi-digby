/** Structured logging — all console output goes through here. */

function ts(): string {
	return new Date().toISOString().slice(11, 19);
}

export function info(msg: string, ...args: string[]): void {
	console.log(`[${ts()}] ${msg}`, ...args);
}

export function warn(msg: string, ...args: string[]): void {
	console.warn(`[${ts()}] ⚠ ${msg}`, ...args);
}

export function error(msg: string, ...args: string[]): void {
	console.error(`[${ts()}] ✗ ${msg}`, ...args);
}

export function toolStart(channel: string, toolName: string, label: string): void {
	console.log(`[${ts()}] [${channel}] → ${toolName}: ${label}`);
}

export function toolEnd(channel: string, toolName: string, durationMs: number, isError: boolean, result: string): void {
	const status = isError ? "✗" : "✓";
	const dur = (durationMs / 1000).toFixed(1);
	const preview = result.length > 200 ? `${result.substring(0, 200)}...` : result;
	console.log(`[${ts()}] [${channel}] ${status} ${toolName} (${dur}s): ${preview}`);
}

export function usage(
	channel: string,
	steps: number,
	cost: number,
	contextTokens: number,
	contextWindow: number,
): void {
	const pct = ((contextTokens / contextWindow) * 100).toFixed(0);
	console.log(`[${ts()}] [${channel}] ${steps} steps · $${cost.toFixed(2)} · ${pct}% context`);
}

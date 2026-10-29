import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { RunStats } from "../channel/run-stats.js";

export interface ModelUsage {
	provider: string;
	model: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	estimatedCostUsd: number;
}
export interface RunUsage {
	models: ModelUsage[];
	missingCalls: number;
}
export interface RunIdentity {
	runId: string;
	source: string;
	channelId: string;
	jobId?: string;
	startedAt: number;
}
interface AssistantUsage {
	provider: string;
	model: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
}

export function recordAssistantUsage(stats: RunStats, message: AssistantUsage): void {
	stats.usage ??= { models: [], missingCalls: 0 };
	const usage = stats.usage;
	const tokens = message.usage;
	if (
		!tokens ||
		![tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.cost?.total].every(
			(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
		)
	) {
		usage.missingCalls++;
		return;
	}
	let model = usage.models.find((row) => row.provider === message.provider && row.model === message.model);
	if (!model) {
		model = {
			provider: message.provider,
			model: message.model,
			calls: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			estimatedCostUsd: 0,
		};
		usage.models.push(model);
	}
	model.calls++;
	model.input += tokens.input;
	model.output += tokens.output;
	model.cacheRead += tokens.cacheRead;
	model.cacheWrite += tokens.cacheWrite;
	model.estimatedCostUsd += tokens.cost.total;
}

export async function writeRunUsage(dir: string, run: RunIdentity, stats: RunStats, silent: boolean): Promise<string> {
	const endedAt = Date.now();
	const usageDir = join(dir, ".usage", new Date(run.startedAt).toISOString().slice(0, 10));
	await mkdir(usageDir, { recursive: true, mode: 0o700 });
	const path = join(usageDir, `${randomUUID()}.json`);
	const models = stats.usage?.models ?? [];
	const missingCalls = stats.usage?.missingCalls ?? 0;
	const record = {
		version: 1,
		runId: run.runId,
		source: run.source,
		channelId: run.channelId,
		jobId: run.jobId,
		startedAt: new Date(run.startedAt).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		durationMs: endedAt - run.startedAt,
		stopReason: stats.stopReason,
		silent,
		models,
		missingCalls,
		usageAvailable: models.length > 0,
		estimatedCostUsd: models.length > 0 ? models.reduce((sum, row) => sum + row.estimatedCostUsd, 0) : null,
		costBasis: "SDK assistant-message estimates; excludes compaction and external tools; not a billing total",
	};
	await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
	return path;
}

/**
 * Context management for mom.
 *
 * Mom uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - createMomSettingsManager: Creates a SettingsManager backed by workspace settings.json
 * - Re-exports syncLogToContext from log.ts
 */

import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type { LogContextScope } from "./log.js";
export { formatLogMessageForContext, syncLogToContext } from "./log.js";

// ============================================================================
// Settings manager for mom
// ============================================================================

type MomSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements MomSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			// Mom stores all settings in a single workspace file.
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

/**
 * Create a SettingsManager that persists to {workspaceDir}/settings.json.
 */
export function createMomSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}

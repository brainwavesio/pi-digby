/**
 * SKILL.md loading — loads skills from workspace and channel directories.
 */

import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import * as log from "../log.js";

/**
 * Load skills from workspace-level and channel-specific skill directories.
 * Channel skills override workspace skills on name collision.
 *
 * @param channelDir - Path to the channel directory
 * @param workspacePath - Workspace root path (parent of channel dirs)
 * @returns Merged array of skills
 */
export function loadSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const _hostWorkspacePath = `${channelDir}/..`;

	// Load workspace-level skills (global)
	const workspaceSkillsDir = `${workspacePath}/skills`;
	const workspaceResult = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" });
	for (const d of workspaceResult.diagnostics) {
		if (d.type === "error") log.warn(`Skill load error (workspace): ${d.message}`);
	}
	for (const skill of workspaceResult.skills) {
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = `${channelDir}/skills`;
	const channelResult = loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" });
	for (const d of channelResult.diagnostics) {
		if (d.type === "error") log.warn(`Skill load error (channel): ${d.message}`);
	}
	for (const skill of channelResult.skills) {
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

export { formatSkillsForPrompt };
export type { Skill };

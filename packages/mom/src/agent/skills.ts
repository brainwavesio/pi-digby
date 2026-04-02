/**
 * SKILL.md loading — loads skills from workspace and channel directories.
 */

import {
    loadSkillsFromDir,
    formatSkillsForPrompt,
    type Skill,
} from "@mariozechner/pi-coding-agent";

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
    const hostWorkspacePath = `${channelDir}/..`;

    // Load workspace-level skills (global)
    const workspaceSkillsDir = `${workspacePath}/skills`;
    for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
        skillMap.set(skill.name, skill);
    }

    // Load channel-specific skills (override workspace skills on collision)
    const channelSkillsDir = `${channelDir}/skills`;
    for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
        skillMap.set(skill.name, skill);
    }

    return Array.from(skillMap.values());
}

export { formatSkillsForPrompt };
export type { Skill };

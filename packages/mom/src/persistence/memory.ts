/**
 * MEMORY.md loading — reads global and channel-specific memory files.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";

/**
 * Load memory from workspace-level and channel-specific MEMORY.md files.
 *
 * @param channelDir - Path to the channel directory (parent is workspace)
 * @returns Combined memory text, or "(no working memory yet)" if empty
 */
export function loadMemory(channelDir: string): string {
    const parts: string[] = [];

    // Read workspace-level memory (shared across all channels)
    const workspaceMemory = join(channelDir, "..", "MEMORY.md");
    if (existsSync(workspaceMemory)) {
        try {
            const content = readFileSync(workspaceMemory, "utf-8").trim();
            if (content) parts.push(`### Global Workspace Memory\n${content}`);
        } catch (error) {
            log.warn(`Failed to read workspace memory: ${workspaceMemory}: ${error}`);
        }
    }

    // Read channel-specific memory
    const channelMemory = join(channelDir, "MEMORY.md");
    if (existsSync(channelMemory)) {
        try {
            const content = readFileSync(channelMemory, "utf-8").trim();
            if (content) parts.push(`### Channel-Specific Memory\n${content}`);
        } catch (error) {
            log.warn(`Failed to read channel memory: ${channelMemory}: ${error}`);
        }
    }

    return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
}

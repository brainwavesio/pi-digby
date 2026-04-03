import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "fs";

export function createEditTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		path: Type.String({ description: "Absolute path to the file" }),
		old_text: Type.String({ description: "Exact text to find and replace" }),
		new_text: Type.String({ description: "Replacement text" }),
	});

	return {
		name: "edit",
		label: "edit",
		description: "Replace exact text in a file. The old_text must appear exactly once.",
		parameters: schema,
		execute: async (_toolCallId, { path, old_text, new_text }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			const content = readFileSync(path, "utf-8");
			const occurrences = content.split(old_text).length - 1;

			if (occurrences === 0) {
				throw new Error(`Text not found in ${path}`);
			}
			if (occurrences > 1) {
				throw new Error(`Text found ${occurrences} times in ${path} — must be unique`);
			}

			const newContent = content.replace(old_text, new_text);
			writeFileSync(path, newContent);

			return { content: [{ type: "text" as const, text: `Edited ${path}` }], details: undefined };
		},
	};
}

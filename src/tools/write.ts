import type { AgentTool } from "@mariozechner/pi-agent-core";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Type } from "typebox";

const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	path: Type.String({ description: "Absolute path to the file" }),
	content: Type.String({ description: "File content to write" }),
});

export function createWriteTool(): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description: "Create or overwrite a file. Creates parent directories if needed.",
		parameters: writeSchema,
		execute: async (_toolCallId, { path, content }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);

			const lines = content.split("\n").length;
			return { content: [{ type: "text" as const, text: `Wrote ${lines} lines to ${path}` }], details: undefined };
		},
	};
}

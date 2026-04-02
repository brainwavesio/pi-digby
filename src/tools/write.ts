import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

export function createWriteTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		path: Type.String({ description: "Absolute path to the file" }),
		content: Type.String({ description: "File content to write" }),
	});

	return {
		name: "write",
		label: "write",
		description: "Create or overwrite a file. Creates parent directories if needed.",
		parameters: schema,
		execute: async (_toolCallId, { path, content }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);

			const lines = content.split("\n").length;
			return { content: [{ type: "text" as const, text: `Wrote ${lines} lines to ${path}` }], details: undefined };
		},
	};
}

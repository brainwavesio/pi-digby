import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";

const DEFAULT_LIMIT = 2000;

export function createReadTool(): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		path: Type.String({ description: "Absolute path to the file" }),
		offset: Type.Optional(Type.Number({ description: "Line offset (0-based)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
	});

	return {
		name: "read",
		label: "read",
		description: "Read file contents with line numbers. Default limit: 2000 lines. Use offset/limit for large files.",
		parameters: schema,
		execute: async (_toolCallId, { path, offset, limit }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			const content = readFileSync(path, "utf-8");
			const lines = content.split("\n");
			const start = offset ?? 0;
			const end = start + (limit ?? DEFAULT_LIMIT);
			const slice = lines.slice(start, end);

			const numbered = slice.map((line, i) => `${(start + i + 1).toString().padStart(6)} | ${line}`).join("\n");
			const result =
				slice.length < lines.length
					? `${numbered}\n[${lines.length} total lines, showing ${start + 1}-${Math.min(end, lines.length)}]`
					: numbered;

			return { content: [{ type: "text" as const, text: result }], details: undefined };
		},
	};
}

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { basename, resolve as resolvePath } from "path";
import { Type } from "typebox";

export interface AttachContext {
	uploadFn: ((filePath: string, title?: string) => Promise<void>) | null;
}

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file" })),
});

export function createAttachTool(ctx: AttachContext): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description: "Attach a file to your response. Only files from /data/ can be attached.",
		parameters: attachSchema,
		execute: async (_toolCallId, { path, title }, signal, _onUpdate?) => {
			if (!ctx.uploadFn) throw new Error("Upload function not configured");
			if (signal?.aborted) throw new Error("Aborted");

			const absPath = resolvePath(path);
			const fileName = title || basename(absPath);
			await ctx.uploadFn(absPath, fileName);

			return { content: [{ type: "text" as const, text: `Attached file: ${fileName}` }], details: undefined };
		},
	};
}

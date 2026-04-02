import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";

export interface AttachContext {
    uploadFn: ((filePath: string, title?: string) => Promise<void>) | null;
}

export function createAttachTool(ctx: AttachContext): AgentTool<any> {
    const schema = Type.Object({
        label: Type.String({ description: "Brief description (shown to user)" }),
        path: Type.String({ description: "Path to the file to attach" }),
        title: Type.Optional(Type.String({ description: "Title for the file" })),
    });

    return {
        name: "attach",
        label: "attach",
        description: "Attach a file to your response. Only files from /data/ can be attached.",
        parameters: schema,
        execute: async (_toolCallId, { path, title }, signal) => {
            if (!ctx.uploadFn) throw new Error("Upload function not configured");
            if (signal?.aborted) throw new Error("Aborted");

            const absPath = resolvePath(path);
            const fileName = title || basename(absPath);
            await ctx.uploadFn(absPath, fileName);

            return { content: [{ type: "text" as const, text: `Attached file: ${fileName}` }] };
        },
    };
}

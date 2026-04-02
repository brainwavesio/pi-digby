import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface ReactContext {
    reactionFn: ((emoji: string) => Promise<void>) | null;
}

export function createReactTool(ctx: ReactContext): AgentTool<any> {
    const schema = Type.Object({
        label: Type.String({ description: "Brief description (shown to user)" }),
        emoji: Type.String({ description: "Emoji name without colons, e.g. 'eyes', 'white_check_mark'" }),
    });

    return {
        name: "react",
        label: "react",
        description: "React to the message with an emoji. If you react, respond with [SILENT] so no message is posted.",
        parameters: schema,
        execute: async (_toolCallId, { emoji }, signal) => {
            if (!ctx.reactionFn) throw new Error("Reaction function not configured");
            if (signal?.aborted) throw new Error("Aborted");

            await ctx.reactionFn(emoji);

            return { content: [{ type: "text" as const, text: "[SILENT]" }] };
        },
    };
}

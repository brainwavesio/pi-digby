import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface ReactContext {
	reactionFn: ((emoji: string) => Promise<void>) | null;
}

const reactSchema = Type.Object({
	label: Type.String({ description: "Brief description (shown to user)" }),
	emoji: Type.String({ description: "Emoji name without colons, e.g. 'eyes', 'white_check_mark'" }),
});

export function createReactTool(ctx: ReactContext): AgentTool<typeof reactSchema> {
	return {
		name: "react",
		label: "react",
		description: "React to the message with an emoji. If you react, respond with [SILENT] so no message is posted.",
		parameters: reactSchema,
		execute: async (_toolCallId, { emoji }, signal, _onUpdate?) => {
			if (!ctx.reactionFn) throw new Error("Reaction function not configured");
			if (signal?.aborted) throw new Error("Aborted");

			await ctx.reactionFn(emoji);

			return { content: [{ type: "text" as const, text: "[SILENT]" }], details: undefined };
		},
	};
}

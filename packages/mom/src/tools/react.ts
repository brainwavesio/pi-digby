import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface ReactContext {
	reactionFn: ((emoji: string) => Promise<void>) | null;
}

const reactSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're reacting (shown to user)" }),
	emoji: Type.String({
		description: "Emoji name without colons, e.g. 'eyes', 'white_check_mark', 'tada', 'thinking_face'",
	}),
});

export function createReactTool(ctx: ReactContext): AgentTool<typeof reactSchema> {
	return {
		name: "react",
		label: "react",
		description:
			"Add an emoji reaction to the message you're responding to. Use instead of a text reply when a reaction is sufficient acknowledgement — e.g. 👀 for 'noted', ✅ for 'done', 🎉 for good news. Reactions are silent (no message posted).",
		parameters: reactSchema,
		execute: async (_toolCallId: string, { emoji }: { label: string; emoji: string }, signal?: AbortSignal) => {
			if (!ctx.reactionFn) {
				throw new Error("Reaction function not configured");
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			await ctx.reactionFn(emoji);

			return {
				content: [{ type: "text" as const, text: `[SILENT]` }],
				details: undefined,
			};
		},
	};
}

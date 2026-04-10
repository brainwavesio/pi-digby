import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export function createLoadResourceTool(resources: Map<string, () => string>): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description (shown to user)" }),
		resource_id: Type.String({ description: "Identifier of the resource to load" }),
	});

	return {
		name: "load_resource",
		label: "load_resource",
		description: "Load a skill, prompt, or reference doc by resource ID.",
		parameters: schema,
		execute: async (_toolCallId, { resource_id }, signal, _onUpdate?) => {
			if (signal?.aborted) throw new Error("Aborted");

			const loader = resources.get(resource_id);
			if (!loader) {
				const available = Array.from(resources.keys()).join(", ") || "(none)";
				return {
					content: [
						{
							type: "text" as const,
							text: `Resource "${resource_id}" not found. Available: ${available}`,
						},
					],
					details: undefined,
				};
			}

			const content = loader();
			return {
				content: [{ type: "text" as const, text: content }],
				details: undefined,
			};
		},
	};
}

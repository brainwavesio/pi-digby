import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AttachContext, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReactTool, type ReactContext } from "./react.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export type { AttachContext } from "./attach.js";
export type { ReactContext } from "./react.js";

export interface ToolContexts {
	attach: AttachContext;
	react: ReactContext;
}

export function createTools(): { tools: AgentTool<any>[]; contexts: ToolContexts } {
	const attachCtx: AttachContext = { uploadFn: null };
	const reactCtx: ReactContext = { reactionFn: null };

	const tools = [
		createBashTool(),
		createReadTool(),
		createWriteTool(),
		createEditTool(),
		createAttachTool(attachCtx),
		createReactTool(reactCtx),
	];

	return { tools, contexts: { attach: attachCtx, react: reactCtx } };
}

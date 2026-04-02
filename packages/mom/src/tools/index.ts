import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { type AttachContext, createAttachTool } from "./attach.js";
import { type ReactContext, createReactTool } from "./react.js";

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

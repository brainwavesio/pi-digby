import { AgentActivityType, LinearClient as SDKClient } from "@linear/sdk";
import * as log from "../log.js";

export class LinearClient {
	private sdk: SDKClient;

	constructor(apiKey: string) {
		this.sdk = new SDKClient({ apiKey });
	}

	/** Emit a thought activity (ephemeral by default). */
	async emitThought(sessionId: string, body: string, ephemeral = true): Promise<void> {
		try {
			await this.sdk.createAgentActivity({
				agentSessionId: sessionId,
				content: { type: AgentActivityType.Thought, body },
				ephemeral,
			});
		} catch (err) {
			log.warn("[linear] emitThought error", err instanceof Error ? err.message : String(err));
		}
	}

	/** Emit a response activity (final message). */
	async emitResponse(sessionId: string, body: string): Promise<void> {
		try {
			await this.sdk.createAgentActivity({
				agentSessionId: sessionId,
				content: { type: AgentActivityType.Response, body },
			});
		} catch (err) {
			log.warn("[linear] emitResponse error", err instanceof Error ? err.message : String(err));
		}
	}

	/** Emit an error activity. */
	async emitError(sessionId: string, body: string): Promise<void> {
		try {
			await this.sdk.createAgentActivity({
				agentSessionId: sessionId,
				content: { type: AgentActivityType.Error, body },
			});
		} catch (err) {
			log.warn("[linear] emitError error", err instanceof Error ? err.message : String(err));
		}
	}

	/** Emit an action (tool call) activity. */
	async emitAction(sessionId: string, action: string, parameter: string, result?: string): Promise<void> {
		try {
			await this.sdk.createAgentActivity({
				agentSessionId: sessionId,
				content: { type: AgentActivityType.Action, action, parameter, result },
				ephemeral: true,
			});
		} catch (err) {
			log.warn("[linear] emitAction error", err instanceof Error ? err.message : String(err));
		}
	}
}

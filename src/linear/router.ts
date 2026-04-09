import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import type { BotEvent } from "../types.js";

export interface LinearRouterHandler {
	handleEvent(event: BotEvent): Promise<void>;
	handleStop(channelId: string): Promise<void>;
}

/**
 * Creates a Node.js HTTP handler for Linear webhooks using the SDK's
 * LinearWebhookClient which handles signature verification internally.
 *
 * Returns a function compatible with Node's http.createServer handler
 * for the /webhooks/linear route.
 */
export function createLinearWebhookHandler(
	webhookSecret: string,
	handler: LinearRouterHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const webhookClient = new LinearWebhookClient(webhookSecret);
	const webhookHandler = webhookClient.createHandler();

	// Register handler for agent session events
	webhookHandler.on("AgentSessionEvent", (payload) => {
		const session = payload.agentSession;
		if (!session) {
			log.warn("[linear] AgentSessionEvent missing agentSession");
			return;
		}

		const sessionId = session.id;
		const channelId = `linear:${sessionId}`;
		const action = payload.action;

		log.info(`[linear] AgentSessionEvent action=${action} session=${sessionId}`);

		if (action === "created") {
			// New agent session — extract prompt context
			const text = payload.promptContext || session.issue?.title || "No context provided";

			const event: BotEvent = {
				type: "agent_session",
				source: "linear",
				channel: channelId,
				ts: String(Date.now() / 1000),
				user: session.creatorId || "linear",
				text,
			};

			handler.handleEvent(event).catch((err) => {
				log.warn(`[linear] handler error: ${err instanceof Error ? err.message : String(err)}`);
			});
		} else if (action === "prompted") {
			// Follow-up prompt from user or stop signal
			const activity = payload.agentActivity;
			if (!activity) return;

			// Check for stop signal
			if (activity.signal === "stop") {
				handler.handleStop(channelId).catch((err) => {
					log.warn(`[linear] stop error: ${err instanceof Error ? err.message : String(err)}`);
				});
				return;
			}

			// User prompt — content is the activity content object
			const content = activity.content as Record<string, unknown> | undefined;
			const text = (content?.body as string) || "";
			if (!text.trim()) return;

			const event: BotEvent = {
				type: "agent_session",
				source: "linear",
				channel: channelId,
				ts: String(Date.now() / 1000),
				user: activity.userId || "linear",
				text,
			};

			handler.handleEvent(event).catch((err) => {
				log.warn(`[linear] handler error: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
	});

	return async (req: IncomingMessage, res: ServerResponse) => {
		await webhookHandler(req, res);
	};
}

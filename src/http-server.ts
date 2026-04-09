import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as log from "./log.js";

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * HTTP server for health checks and webhook endpoints.
 *
 * Routes:
 * - POST /webhooks/* → registered webhook handlers
 * - GET /health → 200 "ok"
 * - * → 200 "ok" (backward compat for ECS health check on any path)
 */
export class HttpServer {
	private webhooks = new Map<string, WebhookHandler>();

	registerWebhook(path: string, handler: WebhookHandler): void {
		this.webhooks.set(path, handler);
		log.info(`Registered webhook handler: ${path}`);
	}

	start(port = 8080): void {
		const server = createServer(async (req, res) => {
			const path = req.url?.split("?")[0] || "/";

			// Webhook routes
			if (req.method === "POST") {
				const handler = this.webhooks.get(path);
				if (handler) {
					try {
						await handler(req, res);
					} catch (err) {
						log.warn(`[http] Webhook error on ${path}`, err instanceof Error ? err.message : String(err));
						if (!res.headersSent) {
							res.writeHead(500, { "Content-Type": "text/plain" });
							res.end("Internal server error");
						}
					}
					return;
				}
			}

			// Health check / default
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});

		server.listen(port, () => {
			log.info(`HTTP server listening on :${port}`);
		});

		server.on("error", (err) => {
			log.warn("HTTP server error", err.message);
		});
	}
}

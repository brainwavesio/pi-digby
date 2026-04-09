import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as log from "./log.js";

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * HTTP server for health checks and webhook endpoints.
 *
 * Routes:
 * - POST /webhooks/<name> → registered handler, or 404 if none registered
 * - GET / and GET /health → 200 "ok" (ECS health check)
 * - everything else → 404
 *
 * The 404 on unregistered POSTs matters: a silent 200 "ok" looks like a
 * successful delivery to upstream webhook senders (e.g. Linear) even when
 * the handler was never wired up due to a missing secret. Fail loud instead.
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
			if (path.startsWith("/webhooks/")) {
				if (req.method !== "POST") {
					res.writeHead(405, { "Content-Type": "text/plain", Allow: "POST" });
					res.end("Method not allowed");
					return;
				}
				const handler = this.webhooks.get(path);
				if (!handler) {
					log.warn(`[http] No handler registered for ${path} — returning 404`);
					res.writeHead(404, { "Content-Type": "text/plain" });
					res.end("Not found");
					return;
				}
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

			// Health check (ECS hits "/" by default)
			if (req.method === "GET" && (path === "/" || path === "/health")) {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
				return;
			}

			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		});

		server.listen(port, () => {
			log.info(`HTTP server listening on :${port}`);
		});

		server.on("error", (err) => {
			log.warn("HTTP server error", err.message);
		});
	}
}

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as log from "./log.js";

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type GetHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * HTTP server for health checks, webhook endpoints, and (optionally) the wiki.
 *
 * Routes, in order:
 * - POST /webhooks/<name>          → exact-match webhook handler, 404 if none
 * - GET  <registered-prefix>...    → first prefix handler that matches (wiki)
 * - GET  / and /health             → 200 "ok" (ECS health check)
 * - everything else                → 404
 *
 * Webhook 404s matter: a silent 200 looks like a successful delivery to
 * upstream senders even when the handler was never wired up due to a
 * missing secret. Fail loud instead.
 */
export class HttpServer {
	private webhooks = new Map<string, WebhookHandler>();
	private getPrefixes: { prefix: string; handler: GetHandler }[] = [];

	registerWebhook(path: string, handler: WebhookHandler): void {
		this.webhooks.set(path, handler);
		log.info(`Registered webhook handler: ${path}`);
	}

	/**
	 * Register a GET handler for any URL whose path begins with `prefix`.
	 * Prefixes are checked in registration order — register more specific
	 * prefixes first if they overlap.
	 */
	registerGetPrefix(prefix: string, handler: GetHandler): void {
		this.getPrefixes.push({ prefix, handler });
		log.info(`Registered GET prefix handler: ${prefix}`);
	}

	start(port = 8080): void {
		const server = createServer(async (req, res) => {
			const path = req.url?.split("?")[0] || "/";

			// Defence in depth: security + anti-crawl headers on every response,
			// set before any handler runs so nothing slips through.
			res.setHeader("X-Robots-Tag", "noindex, nofollow");
			// Prevent MIME-sniffing attacks (browsers must respect Content-Type).
			res.setHeader("X-Content-Type-Options", "nosniff");
			// Deny framing entirely — no reason any Digby page should be embedded.
			res.setHeader("X-Frame-Options", "DENY");
			// Don't leak URL paths in Referer headers to external resources.
			res.setHeader("Referrer-Policy", "no-referrer");

			// Explicit robots.txt for crawlers that don't read headers.
			if (req.method === "GET" && path === "/robots.txt") {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("User-agent: *\nDisallow: /\n");
				return;
			}

			// Webhook routes (exact match, POST only)
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

			// Registered GET prefix handlers (wiki, auth, public assets)
			if (req.method === "GET") {
				for (const { prefix, handler } of this.getPrefixes) {
					if (path.startsWith(prefix)) {
						try {
							await handler(req, res);
						} catch (err) {
							log.warn(`[http] GET handler error on ${path}`, err instanceof Error ? err.message : String(err));
							if (!res.headersSent) {
								res.writeHead(500, { "Content-Type": "text/plain" });
								res.end("Internal server error");
							}
						}
						return;
					}
				}
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

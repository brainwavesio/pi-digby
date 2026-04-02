import { createServer } from "http";
import * as log from "./log.js";

/**
 * Minimal HTTP health check server for ECS container health checks.
 * Returns 200 OK on any request.
 */
export function startHealthServer(port = 8080): void {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});

	server.listen(port, () => {
		log.info(`Health check server listening on :${port}`);
	});

	server.on("error", (err) => {
		log.warn("Health check server error", err.message);
	});
}

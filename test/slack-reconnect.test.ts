import { SocketModeClient } from "@slack/socket-mode";
import { WebAPIPlatformError } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchConnection } from "../src/slack/client.js";

const DEADLINE_MS = 5 * 60 * 1000;

/** A real Socket Mode client whose `apps.connections.open` call is stubbed. */
function socketWithOpen(open: () => Promise<unknown>): SocketModeClient {
	const socket = new SocketModeClient({ appToken: "xapp-test" });
	(socket as unknown as { webClient: { apps: { connections: { open: unknown } } } }).webClient.apps.connections.open =
		open;
	return socket;
}

describe("Slack connection watchdog", () => {
	const swallow = () => {};

	beforeEach(() => {
		vi.useFakeTimers();
		// main.ts swallows unhandled rejections; do the same so the library's dropped one does not fail the run.
		process.on("unhandledRejection", swallow);
	});
	afterEach(() => {
		process.off("unhandledRejection", swallow);
		vi.useRealTimers();
	});

	it("reports the connection lost when Slack refuses a reconnect with invalid_auth", async () => {
		const open = vi.fn().mockRejectedValue(new WebAPIPlatformError({ ok: false, error: "invalid_auth" }));
		const socket = socketWithOpen(open);
		const onLost = vi.fn();
		watchConnection(socket, onLost);

		socket.emit("close");
		await vi.advanceTimersByTimeAsync(DEADLINE_MS);

		expect(open).toHaveBeenCalledTimes(1);
		expect(onLost).toHaveBeenCalledTimes(1);
	});

	it("stays quiet when the socket reconnects", async () => {
		const socket = socketWithOpen(() => new Promise(() => {}));
		const onLost = vi.fn();
		watchConnection(socket, onLost);

		socket.emit("close");
		socket.emit("connected");
		await vi.advanceTimersByTimeAsync(DEADLINE_MS);

		expect(onLost).not.toHaveBeenCalled();
	});
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupRouter, type RouterHandler } from "../src/slack/router.js";
import type { SlackClient } from "../src/slack/client.js";
import type { SlackEvent } from "../src/slack/types.js";

// Mock config — default: no always-on channels
vi.mock("../src/config.js", () => ({
	shouldProcessAllMessages: vi.fn(() => false),
}));

import { shouldProcessAllMessages } from "../src/config.js";
const mockShouldProcess = vi.mocked(shouldProcessAllMessages);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SlackClient mock — captures registered callbacks */
const BOT_USER_ID = "UBOT123";

function createMockClient() {
	let mentionHandler: ((event: Record<string, any>) => void) | null = null;
	let messageHandler: ((event: Record<string, any>) => void) | null = null;
	const calls: Array<{ method: string; args: any[] }> = [];

	const client = {
		getBotUserId: () => BOT_USER_ID,
		onAppMention: (handler: (event: Record<string, any>) => void) => {
			mentionHandler = handler;
		},
		onMessage: (handler: (event: Record<string, any>) => void) => {
			messageHandler = handler;
		},
		isBotThread: vi.fn(async () => true),
		postMessage: vi.fn(async (...args: any[]) => {
			calls.push({ method: "postMessage", args });
			return "msg_ts";
		}),
	} as unknown as SlackClient;

	return {
		client,
		calls,
		simulateMention: (event: Record<string, any>) => mentionHandler?.(event),
		simulateMessage: (event: Record<string, any>) => messageHandler?.(event),
		mockIsBotThread: (client as any).isBotThread as ReturnType<typeof vi.fn>,
	};
}

function createMockHandler() {
	const logged: SlackEvent[] = [];
	const handled: SlackEvent[] = [];
	let isBusy = false;

	const handler: RouterHandler = {
		isBusy: vi.fn(() => isBusy),
		handleEvent: vi.fn(async (event: SlackEvent) => {
			handled.push(event);
		}),
		handleStop: vi.fn(async () => {}),
		logMessage: vi.fn((event: SlackEvent) => {
			logged.push(event);
		}),
	};

	return { handler, logged, handled, setBusy: (v: boolean) => (isBusy = v) };
}

const STARTUP_TS = "1700000000.000000";
const AFTER_STARTUP = "1700000001.000000";
const BEFORE_STARTUP = "1699999999.000000";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Router", () => {
	let mock: ReturnType<typeof createMockClient>;
	let h: ReturnType<typeof createMockHandler>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockShouldProcess.mockReturnValue(false);
		mock = createMockClient();
		h = createMockHandler();
		setupRouter(mock.client, h.handler, STARTUP_TS);
	});

	// ==========================================================================
	// Message event — DMs
	// ==========================================================================

	describe("DMs", () => {
		it("triggers a run for DM messages", async () => {
			mock.simulateMessage({
				text: "hello",
				channel: "D123",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			});
			// Let async settle
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.handled[0].type).toBe("dm");
			expect(h.handled[0].text).toBe("hello");
		});

		it("drops replayed DM messages with the same channel and ts", async () => {
			const event = {
				text: "hello",
				channel: "D_DEDUP",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			};

			mock.simulateMessage(event);
			mock.simulateMessage(event);

			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.handler.handleEvent).toHaveBeenCalledTimes(1);
		});

		it("skips DM from the bot itself", () => {
			mock.simulateMessage({
				text: "hello",
				channel: "D123",
				user: BOT_USER_ID,
				ts: AFTER_STARTUP,
				channel_type: "im",
			});
			expect(h.handled).toHaveLength(0);
			expect(h.logged).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Message event — bot messages from other bots
	// ==========================================================================

	describe("other bot messages", () => {
		it("logs bot messages without triggering a run", () => {
			mock.simulateMessage({
				text: "Issue moved to In Progress",
				channel: "C_ENG",
				user: "U_LINEAR",
				ts: AFTER_STARTUP,
				bot_id: "B_LINEAR",
			});
			expect(h.logged).toHaveLength(1);
			expect(h.logged[0].user).toBe("U_LINEAR");
			expect(h.logged[0].text).toBe("Issue moved to In Progress");
			expect(h.handled).toHaveLength(0);
		});

		it("logs bot_message subtype from other bots", () => {
			mock.simulateMessage({
				text: "Deploy succeeded",
				channel: "C_OPS",
				user: "U_DEPLOY",
				ts: AFTER_STARTUP,
				bot_id: "B_DEPLOY",
				subtype: "bot_message",
			});
			expect(h.logged).toHaveLength(1);
			expect(h.handled).toHaveLength(0);
		});

		it("skips bot messages with no text and no files", () => {
			mock.simulateMessage({
				channel: "C_ENG",
				user: "U_LINEAR",
				ts: AFTER_STARTUP,
				bot_id: "B_LINEAR",
			});
			expect(h.logged).toHaveLength(0);
		});

		it("skips messages from our own bot", () => {
			mock.simulateMessage({
				text: "I'm thinking...",
				channel: "C_ENG",
				user: BOT_USER_ID,
				ts: AFTER_STARTUP,
				bot_id: "B_SELF",
			});
			expect(h.logged).toHaveLength(0);
			expect(h.handled).toHaveLength(0);
		});

		it("logs bot messages that have bot_id but no user", () => {
			mock.simulateMessage({
				text: "Webhook notification",
				channel: "C_ENG",
				ts: AFTER_STARTUP,
				bot_id: "B_WEBHOOK",
			});
			expect(h.logged).toHaveLength(1);
			expect(h.logged[0].user).toBe("B_WEBHOOK");
			expect(h.handled).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Message event — channel messages (non-DM, non-thread)
	// ==========================================================================

	describe("channel messages", () => {
		it("logs non-triggering channel messages", () => {
			mock.simulateMessage({
				text: "just chatting",
				channel: "C_GENERAL",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			expect(h.logged).toHaveLength(1);
			expect(h.handled).toHaveLength(0);
		});

		it("triggers in always-on channels", async () => {
			mockShouldProcess.mockReturnValue(true);
			mock.simulateMessage({
				text: "do something",
				channel: "C_ALWAYS",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
		});

		it("skips old messages in always-on channels", () => {
			mockShouldProcess.mockReturnValue(true);
			mock.simulateMessage({
				text: "old message",
				channel: "C_ALWAYS",
				user: "U_USER",
				ts: BEFORE_STARTUP,
			});
			expect(h.handled).toHaveLength(0);
		});

		it("skips messages with no user and no bot_id", () => {
			mock.simulateMessage({
				text: "ghost message",
				channel: "C_GENERAL",
				ts: AFTER_STARTUP,
			});
			expect(h.logged).toHaveLength(0);
			expect(h.handled).toHaveLength(0);
		});

		it("skips non-standard subtypes", () => {
			mock.simulateMessage({
				text: "edited",
				channel: "C_GENERAL",
				user: "U_USER",
				ts: AFTER_STARTUP,
				subtype: "message_changed",
			});
			expect(h.logged).toHaveLength(0);
			expect(h.handled).toHaveLength(0);
		});

		it("allows file_share subtype", () => {
			mock.simulateMessage({
				channel: "C_GENERAL",
				user: "U_USER",
				ts: AFTER_STARTUP,
				subtype: "file_share",
				files: [{ name: "screenshot.png" }],
			});
			expect(h.logged).toHaveLength(1);
		});
	});

	// ==========================================================================
	// Message event — thread replies
	// ==========================================================================

	describe("thread replies", () => {
		it("triggers in bot-owned threads", async () => {
			mock.mockIsBotThread.mockResolvedValue(true);
			mock.simulateMessage({
				text: "follow up",
				channel: "C_ENG",
				user: "U_USER",
				ts: AFTER_STARTUP,
				thread_ts: "1700000000.500000",
			});
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
		});

		it("logs in non-bot threads", async () => {
			mock.mockIsBotThread.mockResolvedValue(false);
			mock.simulateMessage({
				text: "not for us",
				channel: "C_ENG",
				user: "U_USER",
				ts: AFTER_STARTUP,
				thread_ts: "1700000000.500000",
			});
			await vi.waitFor(() => expect(h.logged).toHaveLength(1));
			expect(h.handled).toHaveLength(0);
		});

		it("logs when another user is mentioned (not bot)", () => {
			mock.simulateMessage({
				text: "hey <@UOTHER99> what do you think",
				channel: "C_ENG",
				user: "U_USER",
				ts: AFTER_STARTUP,
				thread_ts: "1700000000.500000",
			});
			expect(h.logged).toHaveLength(1);
			expect(h.handled).toHaveLength(0);
			// isBotThread should not even be called
			expect(mock.mockIsBotThread).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// App mention
	// ==========================================================================

	describe("app_mention", () => {
		it("triggers a run on mention", async () => {
			mock.simulateMention({
				text: "<@UBOT123> do the thing",
				channel: "C_ENG",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.handled[0].type).toBe("mention");
			expect(h.handled[0].text).toBe("do the thing");
		});

		it("skips mentions in DM channels", () => {
			mock.simulateMention({
				text: "<@UBOT123> hi",
				channel: "D123",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			expect(h.handled).toHaveLength(0);
		});

		it("skips old mentions", () => {
			mock.simulateMention({
				text: "<@UBOT123> old",
				channel: "C_ENG",
				user: "U_USER",
				ts: BEFORE_STARTUP,
			});
			// Logged via info, but not handled
			expect(h.handled).toHaveLength(0);
		});

		it("skips mentions in always-on channels", () => {
			mockShouldProcess.mockReturnValue(true);
			mock.simulateMention({
				text: "<@UBOT123> hello",
				channel: "C_ALWAYS",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			// message handler picks these up instead
			expect(h.handled).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Busy / stop
	// ==========================================================================

	describe("busy and stop", () => {
		it("queues message and posts acknowledgement when running", async () => {
			h.setBusy(true);
			mock.simulateMessage({
				text: "hello",
				channel: "C_DM",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			});
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.logged).toHaveLength(0);
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0].args[1]).toContain("Queued");
		});

		it("does not post duplicate queued acknowledgements for replayed events", async () => {
			h.setBusy(true);
			const event = {
				text: "hello",
				channel: "C_BUSY_DEDUP",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			};

			mock.simulateMessage(event);
			mock.simulateMessage(event);

			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.logged).toHaveLength(0);
			expect(h.handler.handleEvent).toHaveBeenCalledTimes(1);
			expect(mock.calls).toHaveLength(1);
		});

		it("handles stop when running", async () => {
			h.setBusy(true);
			mock.simulateMessage({
				text: "stop",
				channel: "C_DM",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			});
			expect(h.logged).toHaveLength(1);
			expect(h.handler.handleStop).toHaveBeenCalledWith(
				expect.objectContaining({ channel: "C_DM", text: "stop", threadTs: undefined }),
			);
		});

		it("delegates stop to handler when idle", () => {
			h.setBusy(false);
			mock.simulateMessage({
				text: "stop",
				channel: "C_DM",
				user: "U_USER",
				ts: AFTER_STARTUP,
				channel_type: "im",
			});
			expect(h.handler.handleStop).toHaveBeenCalledWith(
				expect.objectContaining({ channel: "C_DM", text: "stop", threadTs: undefined }),
			);
			expect(mock.calls).toHaveLength(0);
		});
	});

	// ==========================================================================
	// Mention stripping
	// ==========================================================================

	describe("mention stripping", () => {
		it("strips @mentions from message text", async () => {
			mockShouldProcess.mockReturnValue(true);
			mock.simulateMessage({
				text: "hey <@UBOT123> do this <@UOTHER99>",
				channel: "C_ALWAYS",
				user: "U_USER",
				ts: AFTER_STARTUP,
			});
			await vi.waitFor(() => expect(h.handled).toHaveLength(1));
			expect(h.handled[0].text).toBe("hey  do this");
		});
	});
});

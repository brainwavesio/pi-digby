import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, statSync } from "fs";
import { initConfig, getReplyBehaviour, shouldProcessAllMessages, shouldReplyInThread } from "../src/config.js";

vi.mock("fs", () => ({
	readFileSync: vi.fn(),
	statSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockStatSync = vi.mocked(statSync);

function mockConfig(config: object, mtime = 1000) {
	mockStatSync.mockReturnValue({ mtimeMs: mtime } as ReturnType<typeof statSync>);
	mockReadFileSync.mockReturnValue(JSON.stringify(config));
}

describe("getReplyBehaviour", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		initConfig("/fake/dir");
	});

	it("returns 'mention' for unknown channels", () => {
		mockConfig({ slack: { replyBehaviour: {} } });
		expect(getReplyBehaviour("C_UNKNOWN")).toBe("mention");
	});

	it("returns 'mention' when replyBehaviour is absent", () => {
		mockConfig({});
		expect(getReplyBehaviour("C_ANY")).toBe("mention");
	});

	it("returns 'channel' for a channel mapped to channel", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "channel" } } });
		expect(getReplyBehaviour("C_ONE")).toBe("channel");
	});

	it("returns 'thread' for a channel mapped to thread", () => {
		mockConfig({ slack: { replyBehaviour: { C_TWO: "thread" } } });
		expect(getReplyBehaviour("C_TWO")).toBe("thread");
	});

	it("returns 'mention' for a channel mapped to mention", () => {
		mockConfig({ slack: { replyBehaviour: { C_THREE: "mention" } } });
		expect(getReplyBehaviour("C_THREE")).toBe("mention");
	});
});

describe("shouldProcessAllMessages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		initConfig("/fake/dir");
	});

	it("returns false for unknown channels", () => {
		mockConfig({});
		expect(shouldProcessAllMessages("C_UNKNOWN")).toBe(false);
	});

	it("returns false for 'mention' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "mention" } } });
		expect(shouldProcessAllMessages("C_ONE")).toBe(false);
	});

	it("returns true for 'channel' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "channel" } } });
		expect(shouldProcessAllMessages("C_ONE")).toBe(true);
	});

	it("returns true for 'thread' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "thread" } } });
		expect(shouldProcessAllMessages("C_ONE")).toBe(true);
	});
});

describe("shouldReplyInThread", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		initConfig("/fake/dir");
	});

	it("returns false for unknown channels", () => {
		mockConfig({});
		expect(shouldReplyInThread("C_UNKNOWN")).toBe(false);
	});

	it("returns false for 'mention' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "mention" } } });
		expect(shouldReplyInThread("C_ONE")).toBe(false);
	});

	it("returns false for 'channel' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "channel" } } });
		expect(shouldReplyInThread("C_ONE")).toBe(false);
	});

	it("returns true for 'thread' channels", () => {
		mockConfig({ slack: { replyBehaviour: { C_ONE: "thread" } } });
		expect(shouldReplyInThread("C_ONE")).toBe(true);
	});
});

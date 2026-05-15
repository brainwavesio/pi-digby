import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	selectLogMessagesForContext,
	syncLogToContext,
	type LogContextScope,
	type LogMessage,
} from "../src/persistence/log.js";

function msg(opts: {
	ts: string;
	text: string;
	user?: string;
	userName?: string;
	threadTs?: string;
	isBot?: boolean;
}): LogMessage {
	return {
		date: new Date(Number.parseFloat(opts.ts) * 1000).toISOString(),
		ts: opts.ts,
		user: opts.user ?? "U_USER",
		userName: opts.userName,
		text: opts.text,
		isBot: opts.isBot ?? false,
		...(opts.threadTs && { threadTs: opts.threadTs }),
	};
}

function idsFor(scope: LogContextScope, currentTs: string, messages: LogMessage[]): string[] {
	return selectLogMessagesForContext(messages, { currentTs, scope }).map((m) => m.id);
}

describe("selectLogMessagesForContext", () => {
	it("builds Slack thread context from pre-root channel messages plus same-thread replies only", () => {
		const messages = [
			msg({ ts: "90.000000", text: "before root", userName: "amy" }),
			msg({ ts: "100.000000", text: "thread root", userName: "tom" }),
			msg({ ts: "110.000000", text: "top-level after root", userName: "sam" }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "same thread reply", userName: "zoe" }),
			msg({ ts: "125.000000", threadTs: "105.000000", text: "other thread reply", userName: "ivy" }),
			msg({ ts: "130.000000", threadTs: "100.000000", text: "current trigger", userName: "tom" }),
			msg({ ts: "140.000000", threadTs: "100.000000", text: "future reply", userName: "zoe" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "130.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});

		expect(selected.map((m) => m.id)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:120.000000",
		]);
		expect(selected.map((m) => m.text).join("\n")).toContain("same thread reply");
		expect(selected.map((m) => m.text).join("\n")).not.toContain("top-level after root");
		expect(selected.map((m) => m.text).join("\n")).not.toContain("other thread reply");
		expect(selected.map((m) => m.text).join("\n")).not.toContain("current trigger");
		expect(selected.map((m) => m.text).join("\n")).not.toContain("future reply");
	});

	it("shows earlier human replies when Digby is first mentioned halfway through a thread", () => {
		const messages = [
			msg({ ts: "90.000000", text: "channel setup", userName: "amy" }),
			msg({ ts: "100.000000", text: "human thread root", userName: "tom" }),
			msg({ ts: "110.000000", threadTs: "100.000000", text: "first human reply", userName: "amy" }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "second human reply", userName: "sam" }),
			msg({ ts: "130.000000", threadTs: "100.000000", text: "@digby what do you think?", userName: "tom" }),
			msg({ ts: "140.000000", threadTs: "100.000000", text: "after trigger", userName: "amy" }),
		];

		expect(idsFor({ source: "slack", kind: "thread", rootTs: "100.000000" }, "130.000000", messages)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:110.000000",
			"slack:120.000000",
		]);
	});

	it("inserts a Slack thread boundary before the current root when starting a new thread", () => {
		const messages = [
			msg({ ts: "90.000000", text: "before root", userName: "amy" }),
			msg({ ts: "100.000000", text: "current root", userName: "tom" }),
			msg({ ts: "110.000000", text: "future top-level", userName: "sam" }),
		];

		expect(idsFor({ source: "slack", kind: "thread", rootTs: "100.000000" }, "100.000000", messages)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
		]);
	});

	it("keeps the Slack thread boundary after all pre-root channel messages", () => {
		const messages = [
			msg({ ts: "99.999999", text: "immediately before root", userName: "amy" }),
			msg({ ts: "100.000000", text: "thread root", userName: "tom" }),
			msg({ ts: "110.000000", threadTs: "100.000000", text: "current trigger", userName: "tom" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "110.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});

		expect(selected.map((m) => m.id)).toEqual([
			"slack:99.999999",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
		]);
		expect(selected[1].timestamp).toBeGreaterThan(selected[0].timestamp);
		expect(selected[1].timestamp).toBeLessThan(selected[2].timestamp);
	});

	it("keeps Slack top-level context to prior non-thread messages", () => {
		const messages = [
			msg({ ts: "90.000000", text: "top-level one", userName: "amy" }),
			msg({ ts: "100.000000", threadTs: "90.000000", text: "hidden thread reply", userName: "tom" }),
			msg({ ts: "110.000000", text: "top-level two", userName: "sam" }),
			msg({ ts: "120.000000", text: "current trigger", userName: "zoe" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual([
			"slack:90.000000",
			"slack:110.000000",
		]);
	});

	it("keeps top-level bot event responses in channel context for event follow-ups", () => {
		const messages = [
			msg({ ts: "100.000000", text: "[EVENT:ingest.json:periodic:* * * * *] first ingest", user: "system" }),
			msg({ ts: "110.000000", text: "Found three new insights.", user: "bot", isBot: true }),
			msg({ ts: "120.000000", text: "[EVENT:ingest.json:periodic:* * * * *] second ingest", user: "system" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual([
			"slack:100.000000",
			"slack:110.000000",
		]);
	});

	it("keeps thread-targeted event responses scoped to their Slack thread", () => {
		const messages = [
			msg({ ts: "100.000000", text: "thread root", userName: "tom" }),
			msg({
				ts: "110.000000",
				threadTs: "100.000000",
				text: "[EVENT:follow-up.json:one-shot:2026-05-13T00:00:00Z] thread event",
				user: "system",
			}),
			msg({ ts: "111.000000", threadTs: "100.000000", text: "Thread event handled.", user: "bot", isBot: true }),
			msg({ ts: "120.000000", text: "current channel prompt", userName: "zoe" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual(["slack:100.000000"]);
		expect(idsFor({ source: "slack", kind: "thread", rootTs: "100.000000" }, "120.000000", messages)).toEqual([
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:110.000000",
			"slack:111.000000",
		]);
	});

	it("keeps concurrent Slack threads isolated from each other", () => {
		const messages = [
			msg({ ts: "90.000000", text: "channel setup", userName: "amy" }),
			msg({ ts: "100.000000", text: "thread one root", userName: "tom" }),
			msg({ ts: "101.000000", text: "thread two root", userName: "sam" }),
			msg({ ts: "110.000000", threadTs: "100.000000", text: "thread one user", userName: "tom" }),
			msg({ ts: "111.000000", threadTs: "101.000000", text: "thread two user", userName: "sam" }),
			msg({ ts: "112.000000", threadTs: "100.000000", text: "thread one bot", user: "bot", isBot: true }),
			msg({ ts: "113.000000", threadTs: "101.000000", text: "thread two bot", user: "bot", isBot: true }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "thread one current", userName: "tom" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});

		expect(selected.map((m) => m.id)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:110.000000",
			"slack:112.000000",
		]);
		expect(selected.map((m) => m.text).join("\n")).not.toContain("thread two user");
		expect(selected.map((m) => m.text).join("\n")).not.toContain("thread two bot");
	});

	it("treats Slack root records with threadTs equal to ts as top-level roots", () => {
		const messages = [
			msg({ ts: "100.000000", threadTs: "100.000000", text: "self-thread root", userName: "tom" }),
			msg({ ts: "120.000000", text: "current trigger", userName: "zoe" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual(["slack:100.000000"]);
	});

	it("prefers corrected threaded duplicate log records over stale top-level records", () => {
		const messages = [
			msg({ ts: "90.000000", text: "top-level before root", userName: "amy" }),
			msg({ ts: "100.000000", text: "thread root", userName: "tom" }),
			msg({ ts: "120.000000", text: "stale reply without thread metadata", userName: "sam" }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "corrected threaded reply", userName: "sam" }),
			msg({ ts: "130.000000", text: "current trigger", userName: "zoe" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "130.000000", messages)).toEqual([
			"slack:90.000000",
			"slack:100.000000",
		]);

		const threadSelected = selectLogMessagesForContext(messages, {
			currentTs: "130.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});
		expect(threadSelected.map((m) => m.id)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:120.000000",
		]);
		expect(threadSelected.map((m) => m.text).join("\n")).toContain("corrected threaded reply");
		expect(threadSelected.map((m) => m.text).join("\n")).not.toContain("stale reply without thread metadata");
	});

	it("includes a bot-authored Slack root when a user replies to a bot-owned thread", () => {
		const messages = [
			msg({ ts: "90.000000", text: "before root", userName: "amy" }),
			msg({ ts: "100.000000", text: "bot started thread", user: "bot", isBot: true }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "user reply", userName: "tom" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "130.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});

		expect(selected.map((m) => m.id)).toEqual([
			"slack:90.000000",
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:120.000000",
		]);
		expect(selected[2].text).toContain("[digby]");
	});

	it("includes bot-authored Slack thread replies in the visible transcript selector", () => {
		const messages = [
			msg({ ts: "100.000000", text: "thread root", userName: "tom" }),
			msg({ ts: "110.000000", threadTs: "100.000000", text: "bot reply", user: "bot", isBot: true }),
			msg({ ts: "120.000000", threadTs: "100.000000", text: "current", userName: "tom" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "thread", rootTs: "100.000000" },
		});

		expect(selected.map((m) => m.id)).toEqual([
			"slack-thread-boundary:100.000000",
			"slack:100.000000",
			"slack:110.000000",
		]);
		expect(selected[2].text).toContain("[digby]");
	});

	it("keeps Linear context chronological and excludes future/bot messages", () => {
		const messages = [
			msg({ ts: "90.000000", text: "first", userName: "amy" }),
			msg({ ts: "100.000000", text: "bot response", user: "bot", isBot: true }),
			msg({ ts: "110.000000", text: "second", userName: "tom" }),
			msg({ ts: "120.000000", text: "current", userName: "tom" }),
		];

		expect(idsFor({ source: "linear", kind: "chronological" }, "120.000000", messages)).toEqual([
			"linear:90.000000",
			"linear:110.000000",
		]);
	});

	it("does not collapse Linear messages that share a timestamp", () => {
		const messages = [
			msg({ ts: "100.000000", text: "first same-timestamp prompt", userName: "amy" }),
			msg({ ts: "100.000000", text: "second same-timestamp prompt", userName: "tom" }),
			msg({ ts: "120.000000", text: "current", userName: "tom" }),
		];

		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "linear", kind: "chronological" },
		});

		expect(selected.map((m) => m.text).join("\n")).toContain("first same-timestamp prompt");
		expect(selected.map((m) => m.text).join("\n")).toContain("second same-timestamp prompt");
	});

	it("does not duplicate old untagged session messages when syncing tagged log messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "digby-log-context-"));
		try {
			writeFileSync(
				join(dir, "log.jsonl"),
				[
					JSON.stringify(msg({ ts: "90.000000", text: "already present", userName: "amy" })),
					JSON.stringify(msg({ ts: "110.000000", text: "new message", userName: "tom" })),
				].join("\n"),
			);

			const sessionManager = SessionManager.inMemory(dir);
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "[2026-01-01 00:00:00+00:00] [amy]: already present" }],
				timestamp: 90_000,
			});

			const synced = syncLogToContext(sessionManager, dir, "120.000000", { source: "slack", kind: "channel" });

			expect(synced).toBe(1);
			expect(sessionManager.buildSessionContext().messages).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps distinct Slack messages with identical text when syncing by timestamp", () => {
		const dir = mkdtempSync(join(tmpdir(), "digby-log-context-"));
		try {
			writeFileSync(
				join(dir, "log.jsonl"),
				[
					JSON.stringify(msg({ ts: "90.000000", text: "same", userName: "amy" })),
					JSON.stringify(msg({ ts: "91.000000", text: "same", userName: "amy" })),
				].join("\n"),
			);

			const sessionManager = SessionManager.inMemory(dir);
			const synced = syncLogToContext(sessionManager, dir, "120.000000", { source: "slack", kind: "channel" });

			expect(synced).toBe(2);
			expect(sessionManager.buildSessionContext().messages).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips logged bot replies when a thread session already has assistant history", () => {
		const dir = mkdtempSync(join(tmpdir(), "digby-log-context-"));
		try {
			writeFileSync(
				join(dir, "log.jsonl"),
				[
					JSON.stringify(msg({ ts: "100.000000", text: "thread root", userName: "tom" })),
					JSON.stringify(
						msg({ ts: "110.000000", threadTs: "100.000000", text: "persisted assistant", user: "bot", isBot: true }),
					),
				].join("\n"),
			);

			const sessionManager = SessionManager.inMemory(dir);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "persisted assistant" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 110_000,
			});

			const synced = syncLogToContext(sessionManager, dir, "120.000000", {
				source: "slack",
				kind: "thread",
				rootTs: "100.000000",
			});

			expect(synced).toBe(2);
			const text = JSON.stringify(sessionManager.buildSessionContext().messages);
			expect(text).toContain("thread root");
			expect(text).toContain("Slack thread boundary");
			expect(text.match(/persisted assistant/g)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

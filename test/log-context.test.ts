import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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

	it("keeps Slack top-level context to prior non-thread messages, with a thread-activity marker", () => {
		// The marker is the channel-scope counterpart to the thread boundary:
		// it tells Digby that a previous top-level message had thread activity
		// so he doesn't treat it as still-pending alongside the current ask.
		const messages = [
			msg({ ts: "90.000000", text: "top-level one", userName: "amy" }),
			msg({ ts: "100.000000", threadTs: "90.000000", text: "hidden thread reply", userName: "tom" }),
			msg({ ts: "110.000000", text: "top-level two", userName: "sam" }),
			msg({ ts: "120.000000", text: "current trigger", userName: "zoe" }),
		];

		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual([
			"slack:90.000000",
			"slack-thread-summary:90.000000",
			"slack:110.000000",
		]);
	});

	it("marks the prior @-mention as already handled when Digby replied in its thread", () => {
		// Reproduces the 'handling both in parallel' footgun: without the
		// marker, the channel session sees Jamie's @mention at 90 with no
		// trace of Digby's thread reply, and conflates it with Tom's new ask.
		const messages = [
			msg({ ts: "90.000000", text: "@digby look at this", userName: "jamie" }),
			msg({ ts: "95.000000", threadTs: "90.000000", text: "on it", user: "bot", isBot: true }),
			msg({ ts: "120.000000", text: "current trigger", userName: "tom" }),
		];
		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "channel" },
		});
		expect(selected.map((m) => m.id)).toEqual(["slack:90.000000", "slack-thread-summary:90.000000"]);
		const marker = selected.find((m) => m.id === "slack-thread-summary:90.000000");
		expect(marker?.text).toContain('digby_replied="true"');
		expect(marker?.text).toContain("Treat that ask as handled");
	});

	it("emits a digby_replied=false marker when a thread exists but Digby never replied", () => {
		// Tom: "and it could show threads which digby didn't reply in too."
		// Useful so Digby knows there's an ongoing human conversation he isn't
		// part of, instead of picking up the root message as unaddressed.
		const messages = [
			msg({ ts: "90.000000", text: "fyi team", userName: "amy" }),
			msg({ ts: "95.000000", threadTs: "90.000000", text: "ack", userName: "sam" }),
			msg({ ts: "120.000000", text: "current trigger", userName: "tom" }),
		];
		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "channel" },
		});
		const marker = selected.find((m) => m.id === "slack-thread-summary:90.000000");
		expect(marker).toBeDefined();
		expect(marker?.text).toContain('digby_replied="false"');
		expect(marker?.text).toContain("continued without him");
	});

	it("does not include a reply count in the marker (prompt-cache stability)", () => {
		// Including a reply count would invalidate the channel's cached prefix
		// every time a new thread reply landed. The binary `digby_replied`
		// signal is enough to drive the model's behaviour.
		const messages = [
			msg({ ts: "90.000000", text: "thread root", userName: "amy" }),
			msg({ ts: "91.000000", threadTs: "90.000000", text: "r1", userName: "sam" }),
			msg({ ts: "92.000000", threadTs: "90.000000", text: "r2", userName: "kim" }),
			msg({ ts: "93.000000", threadTs: "90.000000", text: "r3", userName: "lee" }),
			msg({ ts: "120.000000", text: "trigger", userName: "tom" }),
		];
		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "channel" },
		});
		const marker = selected.find((m) => m.id === "slack-thread-summary:90.000000");
		expect(marker?.text).not.toMatch(/\b3\b/);
		expect(marker?.text).not.toMatch(/replies/i);
	});

	it("does not leak future thread activity into the marker", () => {
		// Thread replies after the current trigger ts must not influence the
		// marker — they don't exist yet from Digby's perspective. A future
		// reply by Digby on an unaddressed mention shouldn't make the marker
		// claim it was handled.
		const messages = [
			msg({ ts: "90.000000", text: "@digby pls", userName: "jamie" }),
			msg({ ts: "200.000000", threadTs: "90.000000", text: "future reply", user: "bot", isBot: true }),
			msg({ ts: "120.000000", text: "current trigger", userName: "tom" }),
		];
		const selected = selectLogMessagesForContext(messages, {
			currentTs: "120.000000",
			scope: { source: "slack", kind: "channel" },
		});
		// No replies before the trigger → no marker at all.
		expect(selected.find((m) => m.id === "slack-thread-summary:90.000000")).toBeUndefined();
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

		// Thread root 100 has bot activity inside its thread (111 isBot=true),
		// so the channel scope gets a digby_replied=true marker.
		expect(idsFor({ source: "slack", kind: "channel" }, "120.000000", messages)).toEqual([
			"slack:100.000000",
			"slack-thread-summary:100.000000",
		]);
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

		// Root 100 has a corrected threaded reply at 120 → marker emitted.
		expect(idsFor({ source: "slack", kind: "channel" }, "130.000000", messages)).toEqual([
			"slack:90.000000",
			"slack:100.000000",
			"slack-thread-summary:100.000000",
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

	it("syncs thread session context from the channel log, not a thread-local log", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "digby-log-context-"));
		const threadSessionDir = join(channelDir, "threads", "100.000000");
		try {
			mkdirSync(threadSessionDir, { recursive: true });
			writeFileSync(
				join(channelDir, "log.jsonl"),
				[
					JSON.stringify(msg({ ts: "90.000000", text: "channel setup", userName: "amy" })),
					JSON.stringify(msg({ ts: "100.000000", text: "thread root", userName: "tom" })),
					JSON.stringify(msg({ ts: "110.000000", threadTs: "100.000000", text: "thread reply", userName: "sam" })),
				].join("\n"),
			);
			writeFileSync(
				join(threadSessionDir, "log.jsonl"),
				JSON.stringify(msg({ ts: "105.000000", text: "thread-local decoy", userName: "ivy" })),
			);

			const sessionManager = SessionManager.open(join(threadSessionDir, "context.jsonl"), threadSessionDir);
			const synced = syncLogToContext(sessionManager, channelDir, "120.000000", {
				source: "slack",
				kind: "thread",
				rootTs: "100.000000",
			});

			expect(synced).toBe(4);
			const text = JSON.stringify(sessionManager.buildSessionContext().messages);
			expect(text).toContain("channel setup");
			expect(text).toContain("thread root");
			expect(text).toContain("thread reply");
			expect(text).not.toContain("thread-local decoy");
		} finally {
			rmSync(channelDir, { recursive: true, force: true });
		}
	});
});

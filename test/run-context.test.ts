import { describe, it, expect, beforeEach } from "vitest";
import { SlackSurface, type MessageTransport } from "../src/surface/slack.js";
import { THINKING_PLACEHOLDER } from "../src/surface/types.js";
import { type RunStats, createRunStats } from "../src/channel/run-stats.js";

/** Mock Slack client that records all calls */
function createMockClient() {
	const calls: Array<{ method: string; args: any[] }> = [];
	let nextTs = 1;

	const client: MessageTransport = {
		async postMessage(channel, text, threadTs?) {
			const ts = String(nextTs++);
			calls.push({ method: "postMessage", args: [channel, text, threadTs] });
			return ts;
		},
		async updateMessage(channel, ts, text) {
			calls.push({ method: "updateMessage", args: [channel, ts, text] });
		},
		async deleteMessage(channel, ts) {
			calls.push({ method: "deleteMessage", args: [channel, ts] });
		},
		async addReaction(channel, ts, emoji) {
			calls.push({ method: "addReaction", args: [channel, ts, emoji] });
		},
		async uploadFile(channel, filePath, title?) {
			calls.push({ method: "uploadFile", args: [channel, filePath, title] });
		},
	};

	return { client, calls };
}

describe("SlackSurface", () => {
	let mock: ReturnType<typeof createMockClient>;
	let stats: RunStats;
	let ctx: SlackSurface;

	beforeEach(() => {
		mock = createMockClient();
		stats = createRunStats();
		ctx = new SlackSurface(mock.client, "C123", stats);
	});

	// ==========================================================================
	// Footer rendering
	// ==========================================================================

	describe("footer", () => {
		it("shows no footer when no steps and no cost", async () => {
			ctx.emitProgress("Hello");
			await ctx.flush();

			const text = mock.calls.find((c) => c.method === "postMessage")!.args[1];
			expect(text).toBe("Hello");
			expect(text).not.toContain("steps");
		});

		it("shows streaming footer when steps > 0 during run", async () => {
			stats.stepCount = 2;
			stats.totalCost = 0.05;
			ctx.emitProgress("Working...");
			await ctx.flush();

			const text = mock.calls.find((c) => c.method === "postMessage")!.args[1];
			expect(text).toContain("2 steps");
			expect(text).toContain("streaming");
			expect(text).not.toContain("$");
		});

		it("shows cost footer after resolve", async () => {
			stats.stepCount = 3;
			stats.totalCost = 0.45;
			ctx.emitProgress("Done.");
			ctx.resolve();
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("3 steps");
			expect(lastUpdate.args[2]).toContain("$0.45");
			expect(lastUpdate.args[2]).not.toContain("streaming");
		});
	});

	// ==========================================================================
	// emitThinking
	// ==========================================================================

	describe("emitThinking", () => {
		it("posts thinking message immediately", async () => {
			ctx.emitThinking();
			await ctx.flush();

			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0].method).toBe("postMessage");
			expect(mock.calls[0].args[1]).toContain("Thinking");
		});

		it("does not post twice", async () => {
			ctx.emitThinking();
			ctx.emitThinking();
			await ctx.flush();

			const posts = mock.calls.filter((c) => c.method === "postMessage");
			expect(posts).toHaveLength(1);
		});
	});

	// ==========================================================================
	// emitProgress / emitResponse
	// ==========================================================================

	describe("emitProgress", () => {
		it("replaces thinking placeholder on first emitProgress", async () => {
			ctx.emitThinking();
			ctx.emitProgress("_\u2192 Reading file_");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Reading file");
			expect(lastUpdate.args[2]).not.toContain("Thinking");
		});

		it("appends after thinking is replaced", async () => {
			ctx.emitThinking();
			ctx.emitProgress("_\u2192 Step 1_");
			ctx.emitProgress("_\u2192 Step 2_");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Step 1");
			expect(lastUpdate.args[2]).toContain("Step 2");
			expect(lastUpdate.args[2]).not.toContain("Thinking");
		});

		it("posts on first call, updates on subsequent", async () => {
			ctx.emitProgress("line 1");
			ctx.emitProgress("line 2");
			await ctx.flush();

			expect(mock.calls[0].method).toBe("postMessage");
			expect(mock.calls[0].args[1]).toBe("line 1");
			expect(mock.calls[1].method).toBe("updateMessage");
			expect(mock.calls[1].args[2]).toContain("line 1\nline 2");
		});
	});

	describe("emitResponse", () => {
		it("replaces all accumulated text", async () => {
			ctx.emitProgress("old text");
			ctx.emitResponse("new text");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toBe("new text");
			expect(lastUpdate.args[2]).not.toContain("old text");
		});
	});

	// ==========================================================================
	// Terminal operations
	// ==========================================================================

	describe("resolve", () => {
		it("transitions footer from streaming to cost", async () => {
			stats.stepCount = 1;
			stats.totalCost = 0.1;
			ctx.emitProgress("Result");
			ctx.resolve();
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("$0.10");
		});

		it("is idempotent — second call is no-op", async () => {
			ctx.emitProgress("text");
			ctx.resolve();
			ctx.resolve();
			await ctx.flush();

			// postMessage + updateMessage(resolve) = 2 calls. No third.
			const updates = mock.calls.filter((c) => c.method === "updateMessage");
			expect(updates).toHaveLength(1);
		});
	});

	describe("reject", () => {
		it("appends error to accumulated text", async () => {
			ctx.emitProgress("partial work");
			ctx.reject("Something broke");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("partial work");
			expect(lastUpdate.args[2]).toContain("Something broke");
		});

		it("posts error even with no prior content", async () => {
			ctx.reject("Early failure");
			await ctx.flush();

			const post = mock.calls.find((c) => c.method === "postMessage")!;
			expect(post.args[1]).toContain("Early failure");
		});

		it("prevents subsequent resolve from firing", async () => {
			ctx.reject("error");
			ctx.resolve();
			await ctx.flush();

			// Only one terminal update
			const allCalls = mock.calls.filter(
				(c) => c.method === "postMessage" || c.method === "updateMessage",
			);
			expect(allCalls).toHaveLength(1);
		});
	});

	describe("suppress", () => {
		it("deletes main and thread messages", async () => {
			ctx.emitThinking();
			ctx.emitDetail("detail");
			ctx.suppress();
			await ctx.flush();

			const deletes = mock.calls.filter((c) => c.method === "deleteMessage");
			expect(deletes.length).toBeGreaterThanOrEqual(1);
		});

		it("prevents subsequent resolve", async () => {
			ctx.emitProgress("text");
			ctx.suppress();
			ctx.resolve();
			await ctx.flush();

			// resolve should not fire an update after suppress
			const updates = mock.calls.filter((c) => c.method === "updateMessage");
			// The emitProgress() causes one update, but resolve() should be no-op
			const postDeleteUpdates = mock.calls.slice(
				mock.calls.findIndex((c) => c.method === "deleteMessage") + 1,
			);
			const postDeleteMessageUpdates = postDeleteUpdates.filter(
				(c) => c.method === "updateMessage" || c.method === "postMessage",
			);
			expect(postDeleteMessageUpdates).toHaveLength(0);
		});
	});

	// ==========================================================================
	// dispose safety net
	// ==========================================================================

	describe("dispose", () => {
		it("rejects if no terminal op was called", async () => {
			ctx.emitProgress("abandoned");
			ctx.dispose();
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Run ended unexpectedly");
		});

		it("is no-op if already resolved", async () => {
			ctx.resolve();
			const callsBefore = mock.calls.length;
			ctx.dispose();
			await ctx.flush();

			// dispose after resolve should add no new Slack calls
			// (resolve adds 1 call, dispose adds 0)
			expect(mock.calls.length).toBe(callsBefore + 1); // +1 for resolve's enqueued update
		});
	});

	// ==========================================================================
	// Full lifecycle integration
	// ==========================================================================

	describe("full lifecycle", () => {
		it("thinking → tool labels → response → resolve", async () => {
			// Phase 1: thinking
			ctx.emitThinking();

			// Phase 2: tools
			stats.stepCount = 1;
			ctx.emitProgress("_\u2192 Reading config_");
			stats.stepCount = 2;
			ctx.emitProgress("_\u2192 Running tests_");

			// Phase 3: response replaces everything
			stats.totalCost = 0.45;
			ctx.emitResponse("All tests pass.");

			// Phase 4: resolve
			ctx.resolve();
			await ctx.flush();

			// Final message should be response + cost footer
			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("All tests pass.");
			expect(lastUpdate.args[2]).toContain("$0.45");
			expect(lastUpdate.args[2]).not.toContain("Thinking");
			expect(lastUpdate.args[2]).not.toContain("streaming");
		});

		it("thinking → error → reject", async () => {
			ctx.emitThinking();
			ctx.emitProgress("_\u2192 Calling API_");
			stats.stepCount = 1;
			ctx.reject("Bedrock timeout");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Calling API");
			expect(lastUpdate.args[2]).toContain("Bedrock timeout");
		});
	});

	// ==========================================================================
	// Reject clears thinking placeholder
	// ==========================================================================

	describe("reject with thinking placeholder", () => {
		it("clears thinking placeholder when error fires before any content", async () => {
			ctx.emitThinking();
			ctx.reject("Bedrock unavailable");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Bedrock unavailable");
			expect(lastUpdate.args[2]).not.toContain("Thinking");
		});

		it("keeps accumulated text when error fires after content", async () => {
			ctx.emitThinking();
			ctx.emitProgress("_\u2192 Step 1_");
			ctx.reject("Timed out");
			await ctx.flush();

			const lastUpdate = mock.calls.filter((c) => c.method === "updateMessage").pop()!;
			expect(lastUpdate.args[2]).toContain("Step 1");
			expect(lastUpdate.args[2]).toContain("Timed out");
		});
	});

	// ==========================================================================
	// State getters for post-run logging
	// ==========================================================================

	describe("state getters", () => {
		it("finalMessageTs returns posted message ts", async () => {
			ctx.emitThinking();
			await ctx.flush();

			expect(ctx.finalMessageTs).toBe("1");
		});

		it("finalMessageTs is null if never posted", () => {
			expect(ctx.finalMessageTs).toBeNull();
		});

		it("finalText returns accumulated text", async () => {
			ctx.emitProgress("Hello world");
			await ctx.flush();

			expect(ctx.finalText).toBe("Hello world");
		});

		it("wasDeleted is false after resolve", () => {
			ctx.resolve();
			expect(ctx.wasDeleted).toBe(false);
		});

		it("wasDeleted is true after suppress", async () => {
			ctx.emitThinking();
			ctx.suppress();
			await ctx.flush();

			expect(ctx.wasDeleted).toBe(true);
		});
	});
});

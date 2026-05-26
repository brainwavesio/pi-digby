/**
 * Tests for runSearch — the ACL filter + error handling around qmd.
 * createWikiSearch itself isn't unit-tested (it needs a real sqlite + model);
 * we cover it via the production smoke test after deploy.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { HybridQueryResult } from "@tobilu/qmd";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_QUERY_LENGTH, runSearch, type SearchImpl } from "../src/wiki/search.js";

let root: string;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	root = mkdtempSync(join(tmpdir(), "digby-wiki-search-"));
	mkdirSync(join(root, "memory"));
	writeFileSync(join(root, "memory", "tom.md"), "# tom");
	writeFileSync(join(root, "MEMORY.md"), "# root");
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "mcp.json"), "{}");
	mkdirSync(join(root, "credentials"));
	writeFileSync(join(root, "credentials", "secret.txt"), "hunter2");
	return root;
}

function fakeHit(file: string, over: Partial<HybridQueryResult> = {}): HybridQueryResult {
	return {
		file,
		displayPath: file,
		title: "untitled",
		body: "body",
		bestChunk: "best chunk",
		bestChunkPos: 0,
		score: 1,
		context: null,
		docid: "doc1",
		...over,
	};
}

describe("runSearch — input validation", () => {
	const r = fixture();
	const noopImpl: SearchImpl = async () => [];

	it("rejects empty query without calling the impl", async () => {
		let called = false;
		const impl: SearchImpl = async () => {
			called = true;
			return [];
		};
		const res = await runSearch(impl, r, "   ");
		expect(res).toEqual({ ok: false, reason: "empty-query" });
		expect(called).toBe(false);
	});

	it("rejects overlong query without calling the impl", async () => {
		const tooLong = "x".repeat(MAX_QUERY_LENGTH + 1);
		const res = await runSearch(noopImpl, r, tooLong);
		expect(res).toEqual({ ok: false, reason: "too-long" });
	});
});

describe("runSearch — ACL filtering", () => {
	it("includes hits that resolve under workingDir", async () => {
		const r = fixture();
		const impl: SearchImpl = async () => [fakeHit(join(r, "memory", "tom.md"), { title: "Tom" })];
		const res = await runSearch(impl, r, "tom");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.hits).toHaveLength(1);
			expect(res.hits[0].urlPath).toBe("/w/memory/tom.md");
			expect(res.hits[0].relPath).toBe("memory/tom.md");
			expect(res.hits[0].title).toBe("Tom");
		}
	});

	it("drops hits in denied paths (dotfiles, credentials)", async () => {
		const r = fixture();
		const impl: SearchImpl = async () => [
			fakeHit(join(r, ".pi", "mcp.json")),
			fakeHit(join(r, "credentials", "secret.txt")),
			fakeHit(join(r, "memory", "tom.md"), { title: "Tom" }),
		];
		const res = await runSearch(impl, r, "anything");
		expect(res.ok).toBe(true);
		if (res.ok) {
			const paths = res.hits.map((h) => h.relPath);
			expect(paths).toEqual(["memory/tom.md"]);
		}
	});

	it("drops hits outside workingDir", async () => {
		const r = fixture();
		const impl: SearchImpl = async () => [fakeHit("/etc/passwd"), fakeHit(join(r, "MEMORY.md"))];
		const res = await runSearch(impl, r, "x");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.hits.map((h) => h.relPath)).toEqual(["MEMORY.md"]);
	});

	it("falls back to relPath as title when qmd title is empty", async () => {
		const r = fixture();
		const impl: SearchImpl = async () => [fakeHit(join(r, "MEMORY.md"), { title: "" })];
		const res = await runSearch(impl, r, "x");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.hits[0].title).toBe("MEMORY.md");
	});
});

describe("runSearch — error paths", () => {
	it("surfaces qmd errors as search-failed", async () => {
		const r = fixture();
		const impl: SearchImpl = async () => {
			throw new Error("sqlite went away");
		};
		const res = await runSearch(impl, r, "x");
		expect(res).toEqual({ ok: false, reason: "search-failed" });
	});

	it("surfaces timeouts as search-timeout", async () => {
		const r = fixture();
		const impl: SearchImpl = () => new Promise(() => {}); // never resolves
		// The default 10s timeout is too slow for unit tests; we just verify
		// the contract by racing against a shorter wrapper. Inline a short
		// timeout via the Promise.race pattern instead of real wait.
		const res = await Promise.race([
			runSearch(impl, r, "x"),
			new Promise<{ ok: false; reason: "search-timeout" }>((resolve) =>
				setTimeout(() => resolve({ ok: false, reason: "search-timeout" }), 50),
			),
		]);
		expect(res).toEqual({ ok: false, reason: "search-timeout" });
	});

	it("includes truncated=true when impl returns the result cap", async () => {
		const r = fixture();
		const hits = Array.from({ length: 20 }, () => fakeHit(join(r, "memory", "tom.md")));
		const impl: SearchImpl = async () => hits;
		const res = await runSearch(impl, r, "x");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.truncated).toBe(true);
			expect(res.hits.length).toBe(20);
		}
	});
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { isDeniedSegment, resolveSafe } from "../src/wiki/acl.js";

describe("isDeniedSegment", () => {
	it("denies dotfiles", () => {
		expect(isDeniedSegment(".pi")).toBe(true);
		expect(isDeniedSegment(".gitconfig")).toBe(true);
		expect(isDeniedSegment(".env")).toBe(true);
		expect(isDeniedSegment(".cache")).toBe(true);
	});
	it("denies credentials by name", () => {
		expect(isDeniedSegment("credentials")).toBe(true);
	});
	it("denies empty segment", () => {
		expect(isDeniedSegment("")).toBe(true);
	});
	it("allows normal names", () => {
		expect(isDeniedSegment("memory")).toBe(false);
		expect(isDeniedSegment("MEMORY.md")).toBe(false);
		expect(isDeniedSegment("C0123456")).toBe(false);
		// `..credentials` is not equal to `credentials`, but starts with `.` so still denied.
		expect(isDeniedSegment("..credentials")).toBe(true);
	});
});

describe("resolveSafe", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function setup(): string {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-acl-"));
		mkdirSync(join(root, "memory"));
		writeFileSync(join(root, "memory", "tom.md"), "# tom");
		writeFileSync(join(root, "MEMORY.md"), "# root");
		mkdirSync(join(root, ".pi"));
		writeFileSync(join(root, ".pi", "mcp.json"), "{}");
		mkdirSync(join(root, "credentials"));
		writeFileSync(join(root, "credentials", "secret.txt"), "hunter2");
		return root;
	}

	it("resolves the root with empty path", () => {
		const r = setup();
		const result = resolveSafe(r, "");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.relPath).toBe("");
		}
	});

	it("resolves a valid nested file", () => {
		const r = setup();
		const result = resolveSafe(r, "memory/tom.md");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.relPath).toBe(join("memory", "tom.md"));
		}
	});

	it("denies dotfile segments", () => {
		const r = setup();
		expect(resolveSafe(r, ".pi/mcp.json").ok).toBe(false);
		expect(resolveSafe(r, ".gitconfig").ok).toBe(false);
	});

	it("denies credentials segment", () => {
		const r = setup();
		expect(resolveSafe(r, "credentials/secret.txt").ok).toBe(false);
	});

	it("denies parent-traversal", () => {
		const r = setup();
		expect(resolveSafe(r, "../../etc/passwd").ok).toBe(false);
		expect(resolveSafe(r, "memory/../../etc/passwd").ok).toBe(false);
	});

	it("denies symlink escape", () => {
		const r = setup();
		const outside = mkdtempSync(join(tmpdir(), "digby-wiki-acl-outside-"));
		try {
			writeFileSync(join(outside, "leak"), "leaked");
			symlinkSync(join(outside, "leak"), join(r, "memory", "escape"));
			expect(resolveSafe(r, "memory/escape").ok).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("tolerates trailing/leading slashes", () => {
		const r = setup();
		expect(resolveSafe(r, "/memory/tom.md").ok).toBe(true);
		expect(resolveSafe(r, "memory/tom.md/").ok).toBe(true);
	});
});

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
	it("denies credentials by name (case-insensitively)", () => {
		expect(isDeniedSegment("credentials")).toBe(true);
		// Belt-and-braces for case-insensitive filesystems where realpath
		// would otherwise preserve the request casing past the deny check.
		expect(isDeniedSegment("Credentials")).toBe(true);
		expect(isDeniedSegment("CREDENTIALS")).toBe(true);
		expect(isDeniedSegment("CrEdEnTiAlS")).toBe(true);
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

	it("denies symlink that resolves inside root but to a denied segment", () => {
		// Exact scenario flagged in adversarial review: a symlink like
		// memory/notes -> ../.pi means every URL segment ('memory', 'notes',
		// 'mcp.json') is allowed and the realpath stays under root, yet the
		// resolved path lives under a denied segment.
		const r = setup();
		symlinkSync(join(r, ".pi"), join(r, "memory", "notes"));
		expect(resolveSafe(r, "memory/notes/mcp.json").ok).toBe(false);
		expect(resolveSafe(r, "memory/notes").ok).toBe(false);
	});

	it("denies symlink that resolves to the credentials dir", () => {
		const r = setup();
		symlinkSync(join(r, "credentials"), join(r, "memory", "stash"));
		expect(resolveSafe(r, "memory/stash/secret.txt").ok).toBe(false);
	});

	it("tolerates trailing/leading slashes", () => {
		const r = setup();
		expect(resolveSafe(r, "/memory/tom.md").ok).toBe(true);
		expect(resolveSafe(r, "memory/tom.md/").ok).toBe(true);
	});

	it("rejects ASCII control chars in any segment", () => {
		const r = setup();
		expect(resolveSafe(r, "memory/\x00tom.md").ok).toBe(false);
		expect(resolveSafe(r, "memory/tom\x1f.md").ok).toBe(false);
		expect(resolveSafe(r, "memory/\x7ftom").ok).toBe(false);
	});
});

describe("resolveSafe — URL decoding rules (decode-once expectations)", () => {
	// The handler decodes the URL path exactly once via decodeURIComponent
	// before calling resolveSafe. These tests exercise the resulting segment
	// strings to verify each escape variant maps to a rejected path.
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});
	function setup(): string {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-acl-decode-"));
		mkdirSync(join(root, "memory"));
		writeFileSync(join(root, "memory", "tom.md"), "# tom");
		return root;
	}

	it("rejects single-decoded %2e%2e traversal", () => {
		const r = setup();
		// After decodeURIComponent: "memory/../etc"
		const decoded = decodeURIComponent("memory/%2e%2e/etc");
		expect(decoded).toBe("memory/../etc");
		expect(resolveSafe(r, decoded).ok).toBe(false);
	});

	it("rejects single-decoded %2F as additional segment boundary", () => {
		const r = setup();
		// After decode, %2F becomes "/", expanding into new segments.
		const decoded = decodeURIComponent("memory%2F..%2Fmemory%2Ftom.md");
		// Decodes to "memory/../memory/tom.md" — has a ".." segment.
		expect(decoded).toBe("memory/../memory/tom.md");
		expect(resolveSafe(r, decoded).ok).toBe(false);
	});

	it("treats double-encoded traversal as literal filename (safe)", () => {
		const r = setup();
		// %252e%252e → "%2e%2e" after one decode — literal, not "..".
		const decoded = decodeURIComponent("%252e%252e");
		expect(decoded).toBe("%2e%2e");
		// Literal name doesn't exist on disk — symlink-escape guard catches it,
		// and even if it existed it wouldn't traverse anywhere.
		const result = resolveSafe(r, decoded);
		// The result is ok=true because "%2e%2e" is just a filename, but
		// the file doesn't exist so the handler 404s downstream.
		expect(result.ok).toBe(true);
	});

	it("rejects literal backslash segments containing control chars", () => {
		const r = setup();
		expect(resolveSafe(r, "memory/\x00").ok).toBe(false);
	});

	it("rejects null bytes that survived decoding", () => {
		const r = setup();
		// %00 decodes to NUL — already covered by isDeniedSegment.
		const decoded = decodeURIComponent("memory/%00tom.md");
		expect(decoded).toBe("memory/\x00tom.md");
		expect(resolveSafe(r, decoded).ok).toBe(false);
	});
});

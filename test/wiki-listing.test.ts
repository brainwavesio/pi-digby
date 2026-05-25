import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { listDirectory, renderListingBody } from "../src/wiki/listing.js";

describe("listDirectory", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("hides denied entries and sorts dirs first then alpha", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		mkdirSync(join(root, "memory"));
		mkdirSync(join(root, ".pi"));
		mkdirSync(join(root, "C0123ABCD"));
		writeFileSync(join(root, "MEMORY.md"), "hello");
		writeFileSync(join(root, ".gitconfig"), "x");
		mkdirSync(join(root, "credentials"));

		const entries = listDirectory(root, root, "", (id) => (id === "C0123ABCD" ? "general" : undefined));
		const names = entries.map((e) => e.name);

		expect(names).not.toContain(".pi");
		expect(names).not.toContain(".gitconfig");
		expect(names).not.toContain("credentials");
		// Two dirs, then the file.
		expect(entries[0].isDir).toBe(true);
		expect(entries[1].isDir).toBe(true);
		expect(entries[2].isDir).toBe(false);
		expect(entries[2].name).toBe("MEMORY.md");

		// Channel id resolved.
		const channel = entries.find((e) => e.name === "C0123ABCD");
		expect(channel?.displayLabel).toBe("#general");
	});

	it("encodes hrefs and appends trailing slash for dirs", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		mkdirSync(join(root, "memory"));
		mkdirSync(join(root, "memory", "weird name"));
		writeFileSync(join(root, "memory", "tom.md"), "x");

		const entries = listDirectory(root, join(root, "memory"), "memory/", undefined);
		const dir = entries.find((e) => e.name === "weird name");
		const file = entries.find((e) => e.name === "tom.md");
		expect(dir?.href).toBe("/w/memory/weird%20name/");
		expect(file?.href).toBe("/w/memory/tom.md");
	});

	it("excludes symlink-escapes from listings", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		writeFileSync(join(root, "ok.md"), "ok");
		const outside = mkdtempSync(join(tmpdir(), "digby-listing-outside-"));
		try {
			writeFileSync(join(outside, "leak"), "secret");
			symlinkSync(join(outside, "leak"), join(root, "leak"));

			const entries = listDirectory(root, root, "", undefined);
			const names = entries.map((e) => e.name);
			expect(names).toContain("ok.md");
			// Even though `leak` exists as a symlink in the dir, it points
			// outside the wiki root and must not appear.
			expect(names).not.toContain("leak");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("renderListingBody", () => {
	it("renders empty state", () => {
		expect(renderListingBody([])).toContain("Empty");
	});
	it("renders a row per entry", () => {
		const html = renderListingBody([
			{
				name: "memory",
				displayLabel: "memory",
				href: "/w/memory/",
				isDir: true,
				size: 0,
				mtimeMs: Date.UTC(2026, 0, 1),
			},
		]);
		expect(html).toContain("/w/memory/");
		expect(html).toContain('class="dir"');
		expect(html).toContain("2026-01-01");
	});
});

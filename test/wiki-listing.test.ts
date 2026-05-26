import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ListingEntry,
	listDirectory,
	partitionRootEntries,
	renderListingBody,
	renderRootListing,
} from "../src/wiki/listing.js";

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

describe("formatChannelLabel (via listDirectory)", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("renders channels as #name and DMs as DM:name (not #DM:name)", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		mkdirSync(join(root, "C0123ABCD"));
		mkdirSync(join(root, "D0456EFGH"));
		const lookup = (id: string) => {
			if (id === "C0123ABCD") return "general";
			if (id === "D0456EFGH") return "DM:tom";
			return undefined;
		};
		const entries = listDirectory(root, root, "", lookup);
		const channel = entries.find((e) => e.name === "C0123ABCD");
		const dm = entries.find((e) => e.name === "D0456EFGH");
		expect(channel?.displayLabel).toBe("#general");
		expect(dm?.displayLabel).toBe("DM:tom");
	});

	it("flags unresolved channel-shaped IDs as archived (raw label preserved)", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		mkdirSync(join(root, "C0123ABCD"));
		const entries = listDirectory(root, root, "", () => undefined);
		const e = entries[0];
		expect(e.archived).toBe(true);
		expect(e.displayLabel).toBe("C0123ABCD");
	});

	it("does not mark non-channel-shaped dirs as archived", () => {
		root = mkdtempSync(join(tmpdir(), "digby-wiki-listing-"));
		mkdirSync(join(root, "memory"));
		mkdirSync(join(root, "linear:abcd-1234"));
		const entries = listDirectory(root, root, "", () => undefined);
		for (const e of entries) expect(e.archived).toBeUndefined();
	});
});

describe("partitionRootEntries", () => {
	const dir = (name: string, displayLabel = name): ListingEntry => ({
		name,
		displayLabel,
		href: `/w/${name}/`,
		isDir: true,
		size: 0,
		mtimeMs: 0,
	});
	const file = (name: string): ListingEntry => ({
		name,
		displayLabel: name,
		href: `/w/${name}`,
		isDir: false,
		size: 100,
		mtimeMs: 0,
	});

	it("buckets channels, linear, and notes correctly", () => {
		const entries = [
			dir("memory"),
			dir("repos"),
			dir("compliance"), // looks like... compliance, NOT a channel
			dir("C0123ABCD", "#general"),
			dir("D0456EFGH", "DM:tom"),
			dir("G0789IJKL", "#group-dm"),
			dir("linear:abc-123"),
			dir("linear:def-456"),
			file("MEMORY.md"),
			file("README.md"),
		];
		const { notes, channels, linear } = partitionRootEntries(entries);
		expect(notes.map((e) => e.name)).toEqual(["memory", "repos", "compliance", "MEMORY.md", "README.md"]);
		expect(channels.map((e) => e.name)).toEqual(["C0123ABCD", "D0456EFGH", "G0789IJKL"]);
		expect(linear.map((e) => e.name)).toEqual(["linear:abc-123", "linear:def-456"]);
	});

	it("does not misclassify 'compliance/' as a channel", () => {
		const { notes, channels } = partitionRootEntries([dir("compliance")]);
		expect(notes.map((e) => e.name)).toEqual(["compliance"]);
		expect(channels).toEqual([]);
	});

	it("treats files in the root as notes regardless of name", () => {
		// A file (not dir) named C0123ABCD wouldn't ever be created by Slack,
		// but we shouldn't misclassify it if it appears.
		const { notes, channels } = partitionRootEntries([file("C0123ABCD")]);
		expect(notes.map((e) => e.name)).toEqual(["C0123ABCD"]);
		expect(channels).toEqual([]);
	});
});

describe("renderRootListing", () => {
	const dir = (name: string, archived = false): ListingEntry => ({
		name,
		displayLabel: name.startsWith("C") || name.startsWith("D") || name.startsWith("G") ? `#${name}` : name,
		href: `/w/${name}/`,
		isDir: true,
		size: 0,
		mtimeMs: 0,
		archived: archived || undefined,
	});

	it("renders three sections when all three buckets have content", () => {
		const html = renderRootListing([
			dir("memory"),
			dir("C0123ABCD"),
			dir("linear:abc-123"),
		]);
		expect(html).toContain(">Notes<");
		expect(html).toContain(">Channels<");
		expect(html).toContain(">Linear<");
		// Section order — notes appears before channels appears before linear.
		expect(html.indexOf(">Notes<")).toBeLessThan(html.indexOf(">Channels<"));
		expect(html.indexOf(">Channels<")).toBeLessThan(html.indexOf(">Linear<"));
	});

	it("omits empty sections", () => {
		const html = renderRootListing([dir("memory")]);
		expect(html).toContain(">Notes<");
		expect(html).not.toContain(">Channels<");
		expect(html).not.toContain(">Linear<");
	});

	it("renders archived rows with the archived class + (archived) tag", () => {
		const html = renderRootListing([dir("C0DEADBEEF", true)]);
		expect(html).toContain('tr class="archived"');
		expect(html).toContain("(archived)");
	});

	it("falls back to empty state when there are no entries", () => {
		expect(renderRootListing([])).toContain("Empty");
	});
});

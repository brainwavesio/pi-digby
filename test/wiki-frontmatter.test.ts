import { describe, expect, it } from "vitest";
import { extractFrontmatter, renderFrontmatter } from "../src/wiki/frontmatter.js";

describe("extractFrontmatter", () => {
	it("returns no frontmatter when content doesn't start with ---", () => {
		const r = extractFrontmatter("# heading\n\nbody");
		expect(r.frontmatter).toBeNull();
		expect(r.body).toBe("# heading\n\nbody");
	});

	it("parses a typical Brainwaves note", () => {
		const r = extractFrontmatter(
			"---\ntype: topic\ncreated: 2026-03-18\ntags: jtbd, pain-point, briefing\n---\n# Topic title\n\nBody.\n",
		);
		expect(r.frontmatter).toEqual({
			type: "topic",
			created: "2026-03-18",
			tags: ["jtbd", "pain-point", "briefing"],
		});
		expect(r.body).toBe("# Topic title\n\nBody.\n");
	});

	it("handles inline array syntax for tags", () => {
		const r = extractFrontmatter("---\ntags: [a, b, c]\n---\nbody");
		expect(r.frontmatter).toEqual({ tags: ["a", "b", "c"] });
	});

	it("strips quotes from string values", () => {
		const r = extractFrontmatter(`---\ntitle: "hello world"\nauthor: 'tom'\n---\nbody`);
		expect(r.frontmatter).toEqual({ title: "hello world", author: "tom" });
	});

	it("ignores comments and blank lines inside the block", () => {
		const r = extractFrontmatter("---\n# this is a comment\n\nkey: value\n---\nbody");
		expect(r.frontmatter).toEqual({ key: "value" });
	});

	it("doesn't strip a stray --- mid-document (no closing within bound)", () => {
		const content = "no frontmatter here\n---\nbut this dash is just an hr\n";
		const r = extractFrontmatter(content);
		expect(r.frontmatter).toBeNull();
		expect(r.body).toBe(content);
	});

	it("doesn't run away searching for closing --- if none exists soon", () => {
		// 100 lines of dashes-look-alikes with no real closing --- → not frontmatter.
		const lines = ["---", ...Array.from({ length: 100 }, (_, i) => `key${i}: value${i}`)];
		const r = extractFrontmatter(lines.join("\n"));
		expect(r.frontmatter).toBeNull();
	});

	it("preserves body whitespace structure after lifting", () => {
		const r = extractFrontmatter("---\nk: v\n---\n\n\n# heading\n");
		// Leading blanks after frontmatter are collapsed; rest preserved.
		expect(r.body).toBe("# heading\n");
	});

	it("ignores keys we can't parse (no colon) without dropping the block", () => {
		const r = extractFrontmatter("---\ngood: yes\nthis-line-has-no-colon\nalso: ok\n---\nbody");
		expect(r.frontmatter).toEqual({ good: "yes", also: "ok" });
	});
});

describe("renderFrontmatter", () => {
	it("renders an aside with key/val rows", () => {
		const html = renderFrontmatter({ type: "topic", created: "2026-03-18" });
		expect(html).toContain('<aside class="wiki-frontmatter">');
		expect(html).toContain('<span class="wiki-fm-key">type</span>');
		expect(html).toContain('<span class="wiki-fm-val">topic</span>');
	});

	it("renders array values as chips", () => {
		const html = renderFrontmatter({ tags: ["jtbd", "pain-point"] });
		expect(html).toContain('<span class="wiki-tag">jtbd</span>');
		expect(html).toContain('<span class="wiki-tag">pain-point</span>');
	});

	it("escapes HTML in values + keys", () => {
		const html = renderFrontmatter({ "<key>": "<script>alert(1)</script>" });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;key&gt;");
	});

	it("returns empty string for empty map", () => {
		expect(renderFrontmatter({})).toBe("");
	});
});

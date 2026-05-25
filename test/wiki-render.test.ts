import { beforeAll, describe, expect, it } from "vitest";
import {
	chooseFence,
	createRenderer,
	HIGHLIGHT_MAX_BYTES,
	inferLang,
	type Renderer,
	wikilinkHref,
} from "../src/wiki/render.js";

describe("wikilinkHref", () => {
	it("appends .md when target has no extension", () => {
		expect(wikilinkHref("memory/tom")).toBe("/w/memory/tom.md");
		expect(wikilinkHref("tom")).toBe("/w/tom.md");
	});
	it("preserves explicit extensions", () => {
		expect(wikilinkHref("diagram.png")).toBe("/w/diagram.png");
		expect(wikilinkHref("memory/log.jsonl")).toBe("/w/memory/log.jsonl");
	});
	it("strips leading slashes", () => {
		expect(wikilinkHref("/memory/tom")).toBe("/w/memory/tom.md");
	});
	it("treats the last segment's dot as the extension marker", () => {
		// `notes.v2/index` has no extension on the last segment.
		expect(wikilinkHref("notes.v2/index")).toBe("/w/notes.v2/index.md");
	});
	it("collapses an empty / root target to /w/", () => {
		expect(wikilinkHref("/")).toBe("/w/");
		expect(wikilinkHref("///")).toBe("/w/");
	});
});

describe("inferLang", () => {
	it("maps common extensions", () => {
		expect(inferLang("foo.yml")).toBe("yaml");
		expect(inferLang("foo.ts")).toBe("ts");
		expect(inferLang("foo.JSON")).toBe("json");
		expect(inferLang("foo.unknown")).toBe("text");
		expect(inferLang("Makefile")).toBe("text");
	});
});

describe("chooseFence", () => {
	it("uses three backticks when content has none", () => {
		expect(chooseFence("hello")).toBe("```");
	});
	it("uses one more than the longest run", () => {
		expect(chooseFence("a ``` b")).toBe("````");
		expect(chooseFence("a `````` b")).toBe("```````");
	});
});

describe("renderer", () => {
	let r: Renderer;
	beforeAll(async () => {
		r = await createRenderer();
	});

	it("expands a plain wikilink", () => {
		const html = r.renderMarkdown("see [[memory/tom]] for context");
		expect(html).toContain('href="/w/memory/tom.md"');
		expect(html).toContain(">memory/tom<");
		expect(html).toContain('class="wiki-link"');
	});

	it("expands a piped wikilink with custom label", () => {
		const html = r.renderMarkdown("[[memory/tom|Tom]]");
		expect(html).toContain('href="/w/memory/tom.md"');
		expect(html).toContain(">Tom<");
	});

	it("marks missing targets as broken", () => {
		const html = r.renderMarkdown("[[ghost]]", {
			linkExists: () => false,
		});
		expect(html).toContain("wiki-broken");
	});

	it("highlights fenced code blocks via shiki", async () => {
		const html = r.renderMarkdown("```ts\nconst x: number = 1\n```");
		// Shiki emits inline-styled spans inside a <pre class="shiki ...">.
		expect(html).toContain("shiki");
		expect(html).toContain("<span");
	});

	it("wraps a text file as code via renderTextAsCode", () => {
		const html = r.renderTextAsCode("a: 1\nb: 2\n", "config.yml");
		expect(html).toContain("shiki");
		expect(html).toContain("language-yaml");
		// Shiki splits content into styled spans; check the values landed.
		expect(html).toMatch(/>a</);
		expect(html).toMatch(/>b</);
	});

	it("skips shiki above HIGHLIGHT_MAX_BYTES and emits a plain pre", () => {
		const big = "x".repeat(HIGHLIGHT_MAX_BYTES + 100);
		const html = r.renderTextAsCode(big, "huge.log");
		// No shiki markup at this size.
		expect(html).not.toContain("shiki");
		expect(html).toContain("<pre><code>");
		// Content survives intact.
		expect(html).toContain("xxxx");
	});

	it("skips shiki on .md files above HIGHLIGHT_MAX_BYTES too", () => {
		// Fenced code blocks in a large markdown would otherwise stream
		// through shiki and tokenise every character. Verify the gate
		// applies uniformly.
		const code = "x".repeat(HIGHLIGHT_MAX_BYTES + 100);
		const md = `# big\n\n\`\`\`python\n${code}\n\`\`\`\n`;
		const html = r.renderMarkdown(md);
		expect(html).not.toContain("shiki");
		// Markdown still renders (heading, plain pre).
		expect(html).toContain("<h1>");
		expect(html).toContain("<pre>");
	});

	it("still highlights .md files under the cap", () => {
		const md = "# small\n\n```ts\nconst x: number = 1;\n```\n";
		const html = r.renderMarkdown(md);
		expect(html).toContain("shiki");
	});

	it("escapes HTML in the plain-pre fallback", () => {
		const big = `<script>${"a".repeat(HIGHLIGHT_MAX_BYTES + 100)}</script>`;
		const html = r.renderTextAsCode(big, "huge.log");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("survives content that contains triple backticks", () => {
		const ts = "const s = `\\`\\`\\`hi\\`\\`\\``";
		const html = r.renderTextAsCode(`example\n\`\`\`\n${ts}\n\`\`\`\nend`, "snippet.txt");
		// The body must appear somewhere — i.e. the outer fence wasn't closed early.
		expect(html).toContain("end");
	});
});

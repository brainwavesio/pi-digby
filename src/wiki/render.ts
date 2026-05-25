/**
 * Wiki renderer — markdown-it + shiki + custom [[wikilink]] rule.
 *
 * Single render pipeline for both `.md` files and standalone text/code files
 * (the latter are wrapped in a fenced block with the inferred language and
 * fed through the same pipeline, so the chrome and code-block frame stay
 * consistent).
 */

import Shiki from "@shikijs/markdown-it";
import MarkdownIt from "markdown-it";

const EXT_TO_LANG: Record<string, string> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "jsx",
	".json": "json",
	".jsonl": "json",
	".yml": "yaml",
	".yaml": "yaml",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".sql": "sql",
	".toml": "toml",
	".html": "html",
	".css": "css",
	".env": "bash",
	".log": "log",
	".txt": "text",
	".csv": "text",
	".md": "markdown",
};

export type RendererOptions = {
	/**
	 * Predicate to flag broken wikilinks. Called with the resolved URL-path
	 * the wikilink points to (with `.md` already appended if implied). Return
	 * false to mark the link as broken (renders with class="wiki-broken").
	 * Optional — when absent, no broken-link styling is applied.
	 */
	linkExists?: (urlPath: string) => boolean;
};

export type Renderer = {
	renderMarkdown(content: string, opts?: RendererOptions): string;
	/**
	 * Render a text/code file. Above `HIGHLIGHT_MAX_BYTES` the content is
	 * served as a plain pre-block (no shiki) to avoid burning seconds of
	 * CPU on a 5 MB log file.
	 */
	renderTextAsCode(content: string, filename: string, opts?: RendererOptions): string;
};

/**
 * Above this content size, syntax-highlighting is skipped — shiki tokenises
 * every character and a 5 MB document of code would take seconds and tens
 * of MB of allocation. Applied uniformly to both `.md` files (whose fenced
 * code blocks otherwise go through shiki on every byte) and standalone
 * text/code files. The plain-pre fallback still renders in the wiki
 * template.
 */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024; // 256 KB

/**
 * Build a renderer with shiki highlighting attached. Returns a promise
 * because shiki initialises asynchronously (downloads/loads themes).
 *
 * Two markdown-it instances are wired up:
 *   - mdHighlighted: with @shikijs/markdown-it
 *   - mdPlain:       no shiki; fenced code becomes a plain <pre>
 *
 * Both share the same `[[wikilink]]` rule. The renderer picks based on
 * total content byte length — anything over HIGHLIGHT_MAX_BYTES skips
 * shiki regardless of file type, so a 4 MB `.md` with one giant fence
 * can't pin the event loop.
 */
export async function createRenderer(): Promise<Renderer> {
	const mdHighlighted = MarkdownIt({ html: false, linkify: true, breaks: false });
	mdHighlighted.use(
		await Shiki({
			themes: { light: "github-light", dark: "github-dark" },
		}),
	);
	installWikilinkRule(mdHighlighted);

	const mdPlain = MarkdownIt({ html: false, linkify: true, breaks: false });
	installWikilinkRule(mdPlain);

	function pick(content: string): MarkdownIt {
		return Buffer.byteLength(content, "utf8") > HIGHLIGHT_MAX_BYTES ? mdPlain : mdHighlighted;
	}

	return {
		renderMarkdown(content, opts) {
			return pick(content).render(content, { wikiLinkExists: opts?.linkExists });
		},
		renderTextAsCode(content, filename, opts) {
			// Above the cap, skip the markdown pipeline entirely — feeding a
			// 5 MB log through markdown-it just to render a single <pre> is
			// pointless allocation. Use a hand-built escaped pre.
			if (Buffer.byteLength(content, "utf8") > HIGHLIGHT_MAX_BYTES) {
				return `<pre><code>${escapePreCode(content)}</code></pre>`;
			}
			const lang = inferLang(filename);
			const fence = chooseFence(content);
			const body = `${fence}${lang}\n${content}\n${fence}\n`;
			return mdHighlighted.render(body, { wikiLinkExists: opts?.linkExists });
		},
	};
}

/** Minimal HTML-escape for content going into a `<pre><code>` block. */
function escapePreCode(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Extension → shiki language id. Falls back to `text`. */
export function inferLang(filename: string): string {
	const lower = filename.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot < 0) return "text";
	return EXT_TO_LANG[lower.slice(dot)] ?? "text";
}

/**
 * Pick a fence that doesn't appear in the body. Counts the longest run of
 * backticks; uses that + 1 (minimum 3). Avoids the edge case where pasted
 * code contains a ``` fence that would otherwise close ours.
 */
export function chooseFence(content: string): string {
	let max = 2;
	const matches = content.match(/`+/g);
	if (matches) {
		for (const m of matches) if (m.length > max) max = m.length;
	}
	return "`".repeat(max + 1);
}

// ---------------------------------------------------------------------------
// [[wikilink]] rule
// ---------------------------------------------------------------------------
//
// Syntax:
//   [[memory/tom]]           → <a href="/w/memory/tom.md">memory/tom</a>
//   [[memory/tom|Tom McK]]   → <a href="/w/memory/tom.md">Tom McK</a>
//   [[diagram.png]]          → <a href="/w/diagram.png">diagram.png</a>
//   (target with a dot keeps its extension; otherwise .md is appended.)

function installWikilinkRule(md: MarkdownIt): void {
	md.inline.ruler.before("link", "wikilink", (state, silent) => {
		const src = state.src;
		const start = state.pos;
		if (src.charCodeAt(start) !== 0x5b /* [ */) return false;
		if (src.charCodeAt(start + 1) !== 0x5b) return false;
		const end = src.indexOf("]]", start + 2);
		if (end < 0) return false;
		const inner = src.slice(start + 2, end);
		if (inner.length === 0 || inner.includes("\n") || inner.includes("[[")) return false;

		const pipe = inner.indexOf("|");
		const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
		const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
		if (!target) return false;

		if (!silent) {
			const urlPath = wikilinkHref(target);
			const env = state.env as { wikiLinkExists?: (p: string) => boolean } | undefined;
			const exists = env?.wikiLinkExists ? env.wikiLinkExists(urlPath) : true;

			const open = state.push("link_open", "a", 1);
			open.attrs = [
				["href", urlPath],
				["class", exists ? "wiki-link" : "wiki-link wiki-broken"],
			];
			const text = state.push("text", "", 0);
			text.content = label;
			state.push("link_close", "a", -1);
		}
		state.pos = end + 2;
		return true;
	});
}

/** Build the `/w/...` href for a wikilink target. Exported for tests. */
export function wikilinkHref(target: string): string {
	const clean = target.replace(/^\/+/, "").replace(/\/+$/, "");
	if (clean === "") return "/w/";
	const lastSeg = clean.slice(clean.lastIndexOf("/") + 1);
	const hasExt = lastSeg.includes(".");
	return `/w/${hasExt ? clean : `${clean}.md`}`;
}

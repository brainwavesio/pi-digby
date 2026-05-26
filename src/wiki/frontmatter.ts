/**
 * YAML frontmatter extraction + rendering for the wiki.
 *
 * Markdown-it has no native frontmatter support, so a `---`-delimited
 * block at the top of a file otherwise renders as a setext H2 (the
 * trailing `---` underlines the YAML lines as one big heading). We
 * detect, parse, and lift it into its own masthead block.
 *
 * We deliberately do NOT pull in a full YAML library — agent-written
 * notes use the same small subset every time:
 *
 *   key: value                  → string
 *   key: "quoted value"         → string (quotes stripped)
 *   key: [a, b, c]              → array
 *   key: a, b, c                → array (any value containing ", " is
 *                                 split on it — pragmatic, matches how
 *                                 Tom writes `tags: jtbd, pain-point`)
 *   # comment                   → ignored
 *   blank line                  → ignored
 *
 * Anything we can't parse (multiline scalars, nested maps, anchors, etc.)
 * is preserved as a raw string value so we never silently lose data.
 */
import { escapeHtml } from "./template.js";

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export type FrontmatterResult = {
	frontmatter: Frontmatter | null;
	body: string;
};

/**
 * If `content` starts with a YAML frontmatter block (`---\n...\n---\n`),
 * return the parsed map and the remaining body. Otherwise return
 * `{ frontmatter: null, body: content }` unchanged.
 *
 * The opening `---` must be on the very first line. The closing `---`
 * must be on its own line. If no closing line is found within the first
 * ~50 lines, we treat the content as non-frontmatter so a stray `---`
 * (e.g. an mdash typo) doesn't blow the whole file away.
 */
export function extractFrontmatter(content: string): FrontmatterResult {
	if (!content.startsWith("---\n") && content !== "---") {
		return { frontmatter: null, body: content };
	}
	const lines = content.split("\n");
	// lines[0] is "---". Find the next "---" line within a sane bound.
	let end = -1;
	for (let i = 1; i < Math.min(lines.length, 50); i++) {
		if (lines[i] === "---") {
			end = i;
			break;
		}
	}
	if (end < 0) return { frontmatter: null, body: content };

	const fm = parseFrontmatterBody(lines.slice(1, end));
	const body = lines
		.slice(end + 1)
		.join("\n")
		.replace(/^\n+/, "");
	return { frontmatter: fm, body };
}

function parseFrontmatterBody(lines: string[]): Frontmatter {
	const out: Frontmatter = {};
	for (const raw of lines) {
		const line = raw.replace(/\s+$/, ""); // strip trailing ws
		if (line.length === 0 || line.trimStart().startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		if (key.length === 0) continue;
		const raw_val = line.slice(colon + 1).trim();
		out[key] = parseValue(raw_val);
	}
	return out;
}

function parseValue(raw: string): FrontmatterValue {
	if (raw.length === 0) return "";
	// Inline array: [a, b, c]
	if (raw.startsWith("[") && raw.endsWith("]")) {
		return raw
			.slice(1, -1)
			.split(",")
			.map((s) => stripQuotes(s.trim()))
			.filter((s) => s.length > 0);
	}
	// Comma-separated values (pragmatic — `tags: jtbd, pain-point`).
	if (raw.includes(", ")) {
		return raw.split(", ").map((s) => stripQuotes(s.trim()));
	}
	return stripQuotes(raw);
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Render a parsed frontmatter map as an HTML block to sit between the
 * page title and the body. Editorial masthead — mono, muted, key/value
 * grid; array values become inline chips.
 */
export function renderFrontmatter(fm: Frontmatter): string {
	const keys = Object.keys(fm);
	if (keys.length === 0) return "";
	const rows = keys
		.map((k) => {
			const v = fm[k];
			const rendered = Array.isArray(v)
				? v.map((t) => `<span class="wiki-tag">${escapeHtml(t)}</span>`).join("")
				: escapeHtml(v);
			return `<div class="wiki-fm-row"><span class="wiki-fm-key">${escapeHtml(k)}</span><span class="wiki-fm-val">${rendered}</span></div>`;
		})
		.join("\n");
	return `<aside class="wiki-frontmatter">\n${rows}\n</aside>`;
}

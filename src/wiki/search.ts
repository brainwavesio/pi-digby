/**
 * Wiki search — backed by the @tobilu/qmd SDK against the same sqlite index
 * the qmd CLI maintains in the container.
 *
 * entrypoint.sh runs `(qmd update && qmd embed) &` at every boot, so the
 * index at /data/.cache/qmd/index.sqlite is the source of truth. We open
 * it with `createStore({ dbPath })` only — no config duplication. Collection
 * definitions live in /data/.config/qmd/index.yml (also seeded by
 * entrypoint.sh) and were baked into the DB at indexing time.
 *
 * The same store powers Digby's own recall via MCP, so wiki search results
 * match what the bot itself surfaces.
 *
 * Lifecycle: createWikiSearch() initialises once when the handler boots and
 * returns null if the DB or model isn't ready (first-boot races, dev without
 * an index). The route degrades gracefully — "search unavailable" page —
 * rather than failing the whole wiki.
 */
import { createStore, type HybridQueryResult, type QMDStore } from "@tobilu/qmd";
import * as log from "../log.js";
import { resolveSafe } from "./acl.js";

export const MAX_QUERY_LENGTH = 256;
export const SEARCH_TIMEOUT_MS = 10_000;
export const DEFAULT_RESULT_COUNT = 20;

/** A search hit safe to render. */
export type SearchHit = {
	urlPath: string;
	relPath: string;
	title: string;
	snippet: string;
	score: number;
};

export type SearchResult =
	| { ok: true; hits: SearchHit[]; truncated: boolean }
	| { ok: false; reason: "empty-query" | "too-long" | "search-failed" | "search-timeout" | "unavailable" };

export type WikiSearch = {
	search(query: string): Promise<SearchResult>;
	close(): Promise<void>;
};

/**
 * Open the qmd store and return a search wrapper. Returns null if the
 * store can't open (missing DB, missing model, init error) so the caller
 * can degrade the wiki gracefully.
 */
/** The single store operation runSearch needs. Mockable in tests. */
export type SearchImpl = (query: string, limit: number) => Promise<HybridQueryResult[]>;

export async function createWikiSearch(opts: { workingDir: string; dbPath: string }): Promise<WikiSearch | null> {
	let store: QMDStore;
	try {
		store = await createStore({ dbPath: opts.dbPath });
	} catch (err) {
		log.warn(`[wiki] qmd store init failed at ${opts.dbPath}`, err instanceof Error ? err.message : String(err));
		return null;
	}
	log.info(`[wiki] qmd store opened: ${opts.dbPath}`);
	const impl: SearchImpl = (query, limit) => store.search({ query, limit });
	return {
		search: (q) => runSearch(impl, opts.workingDir, q),
		close: () => store.close(),
	};
}

/**
 * Run a search through `impl` and return ACL-filtered hits.
 * Exported so tests can drive it without spinning up a real qmd store.
 */
export async function runSearch(impl: SearchImpl, workingDir: string, query: string): Promise<SearchResult> {
	const trimmed = query.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty-query" };
	if (trimmed.length > MAX_QUERY_LENGTH) return { ok: false, reason: "too-long" };

	let raw: HybridQueryResult[];
	try {
		raw = await withTimeout(impl(trimmed, DEFAULT_RESULT_COUNT), SEARCH_TIMEOUT_MS);
	} catch (err) {
		if (err instanceof TimeoutError) return { ok: false, reason: "search-timeout" };
		log.warn(`[wiki] qmd search failed`, err instanceof Error ? err.message : String(err));
		return { ok: false, reason: "search-failed" };
	}

	const hits: SearchHit[] = [];
	for (const r of raw) {
		const hit = toHit(r, workingDir);
		if (hit) hits.push(hit);
	}
	return { ok: true, hits, truncated: raw.length >= DEFAULT_RESULT_COUNT };
}

/**
 * Convert a qmd HybridQueryResult into a wiki-safe hit, or null if the file
 * lies outside workingDir / is denied by the ACL. We never want a search
 * result to surface a path the user couldn't otherwise browse to.
 */
function toHit(r: HybridQueryResult, workingDir: string): SearchHit | null {
	if (typeof r.file !== "string" || r.file.length === 0) return null;
	// qmd's `file` is the absolute path on disk; convert to a relative URL
	// path under workingDir, then run it through the same ACL the rest of
	// the wiki uses.
	if (!r.file.startsWith(`${workingDir}/`)) return null;
	const relCandidate = r.file.slice(workingDir.length + 1);
	const safe = resolveSafe(workingDir, relCandidate);
	if (!safe.ok) return null;

	return {
		urlPath: `/w/${safe.relPath.split("/").map(encodeURIComponent).join("/")}`,
		relPath: safe.relPath,
		title: typeof r.title === "string" && r.title.length > 0 ? r.title : safe.relPath,
		snippet: typeof r.bestChunk === "string" ? r.bestChunk : "",
		score: typeof r.score === "number" ? r.score : 0,
	};
}

// ---------------------------------------------------------------------------
// Timeout helper — qmd LLM ops can hang; we never want a query to wedge the
// route. Promise.race with a sentinel; the underlying SDK call is not killed
// (no cooperative cancellation), but we let the route return so the user
// sees an error instead of a spinner.
// ---------------------------------------------------------------------------

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new TimeoutError(`qmd search exceeded ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

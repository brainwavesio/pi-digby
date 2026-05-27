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
 * Search mode: BM25 (`searchLex`). We deliberately do NOT use hybrid
 * (`search`) or even hybrid-no-rerank: on the CPU-only Fargate task,
 * the LLM query-expansion phase takes 4+ minutes per query. Verified by
 * timing `qmd query 'tom' --no-rerank` inside the running container —
 * it killed after 4m30s without returning. BM25 via the SDK against the
 * already-open store completes in <1s and is what the bot's MCP-via-qmd
 * recall uses in practice (the bot, too, can't afford multi-minute LLM
 * calls in a chat loop).
 *
 * If we ever move to a GPU task, the swap back to `store.search()` is a
 * one-line change.
 *
 * Lifecycle: createWikiSearch() initialises once when the handler boots and
 * returns null if the DB isn't ready (first-boot races, dev without an
 * index). The route degrades gracefully — "search unavailable" page —
 * rather than failing the whole wiki.
 */
import { createStore, extractSnippet, type QMDStore, type SearchResult as QmdHit } from "@tobilu/qmd";
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
export type SearchImpl = (query: string, limit: number) => Promise<QmdHit[]>;

/**
 * Resolve a qmd SearchResult's filepath to an absolute filesystem path.
 * qmd v2.5+ returns virtual paths (`qmd://<collection>/<rel>`); the wiki ACL
 * needs the real on-disk path to root-jail against workingDir. Pass null to
 * drop a hit (e.g. unknown collection). Defaults to identity when omitted,
 * which is what the unit tests rely on (they feed absolute paths directly).
 */
export type ResolveAbsolute = (filepath: string) => string | null;

export async function createWikiSearch(opts: { workingDir: string; dbPath: string }): Promise<WikiSearch | null> {
	let store: QMDStore;
	try {
		store = await createStore({ dbPath: opts.dbPath });
	} catch (err) {
		log.warn(`[wiki] qmd store init failed at ${opts.dbPath}`, err instanceof Error ? err.message : String(err));
		return null;
	}
	log.info(`[wiki] qmd store opened (BM25 mode): ${opts.dbPath}`);
	const impl: SearchImpl = (query, limit) => store.searchLex(query, { limit });
	// store.internal exposes resolveVirtualPath bound to the open DB. This
	// turns `qmd://memory/people/tom.md` into `/data/memory/people/tom.md`
	// using the collection paths stored in store_collections.
	const resolveAbsolute: ResolveAbsolute = (fp) => store.internal.resolveVirtualPath(fp);
	return {
		search: (q) => runSearch(impl, opts.workingDir, q, resolveAbsolute),
		close: () => store.close(),
	};
}

/**
 * Run a search through `impl` and return ACL-filtered hits.
 * Exported so tests can drive it without spinning up a real qmd store.
 */
export async function runSearch(
	impl: SearchImpl,
	workingDir: string,
	query: string,
	resolveAbsolute: ResolveAbsolute = (fp) => fp,
): Promise<SearchResult> {
	const trimmed = query.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty-query" };
	if (trimmed.length > MAX_QUERY_LENGTH) return { ok: false, reason: "too-long" };

	let raw: QmdHit[];
	try {
		raw = await withTimeout(impl(trimmed, DEFAULT_RESULT_COUNT), SEARCH_TIMEOUT_MS);
	} catch (err) {
		if (err instanceof TimeoutError) return { ok: false, reason: "search-timeout" };
		log.warn(`[wiki] qmd search failed`, err instanceof Error ? err.message : String(err));
		return { ok: false, reason: "search-failed" };
	}

	const hits: SearchHit[] = [];
	for (const r of raw) {
		const hit = toHit(r, trimmed, workingDir, resolveAbsolute);
		if (hit) hits.push(hit);
	}
	return { ok: true, hits, truncated: raw.length >= DEFAULT_RESULT_COUNT };
}

/**
 * Convert a qmd SearchResult into a wiki-safe hit, or null if the file
 * lies outside workingDir / is denied by the ACL. We never want a search
 * result to surface a path the user couldn't otherwise browse to.
 *
 * Snippet is derived via the SDK's extractSnippet helper when body is
 * present (qmd's searchLex returns body alongside metadata). Falls back
 * to the empty string otherwise — title + path are enough to click.
 */
function toHit(r: QmdHit, query: string, workingDir: string, resolveAbsolute: ResolveAbsolute): SearchHit | null {
	if (typeof r.filepath !== "string" || r.filepath.length === 0) return null;
	// qmd v2.5+ returns `qmd://<collection>/<rel>` virtual paths. Resolve to
	// the on-disk path the collection's `path:` config points at; only then
	// can we root-jail against workingDir.
	const absolute = resolveAbsolute(r.filepath);
	if (!absolute) return null;
	if (!absolute.startsWith(`${workingDir}/`)) return null;
	const relCandidate = absolute.slice(workingDir.length + 1);
	const safe = resolveSafe(workingDir, relCandidate);
	if (!safe.ok) return null;

	let snippet = "";
	if (typeof r.body === "string" && r.body.length > 0) {
		try {
			// extractSnippet returns a SnippetResult — the matched window lives
			// on `.snippet`. Originally read `.text` (cubic caught it), which
			// would silently empty every result.
			snippet = extractSnippet(r.body, query, 240, r.chunkPos).snippet;
		} catch {
			snippet = r.body.slice(0, 240);
		}
	}

	return {
		urlPath: `/w/${safe.relPath.split("/").map(encodeURIComponent).join("/")}`,
		relPath: safe.relPath,
		title: typeof r.title === "string" && r.title.length > 0 ? r.title : safe.relPath,
		snippet,
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

/**
 * Wiki HTTP handler — dispatches /w/*, /auth/slack/*, /auth/logout, /public/*.
 *
 * One handler, registered against the HttpServer via three prefix
 * registrations. Owns auth middleware, ACL, rendering, and asset serving.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { extname, join } from "path";
import QuickLRU from "quick-lru";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import * as log from "../log.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";
import { resolveSafe } from "./acl.js";
import {
	authorizeUrl,
	clearCookieHeader,
	exchangeCode,
	mintCookieHeader,
	readCookie,
	signState,
	verifyCookie,
	verifyState,
} from "./auth.js";
import { listDirectory, renderListingBody } from "./listing.js";
import { createRenderer, inferLang, type Renderer } from "./render.js";
import { buildCrumbs, renderLoginPage, renderMissingBody, renderShell } from "./template.js";

const RENDER_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on rendered text
const RAW_MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap on raw bytes (images)

/**
 * Wikilink existence cache — keyed by URL path (already includes any
 * `.md` suffix the renderer appended). Each entry is a {exists, expiresAt}
 * record. The TTL keeps the cache fresh enough that files written by the
 * bot show up as no-longer-broken within a minute; the LRU cap bounds
 * memory even if a page references thousands of unique targets.
 *
 * Cross-render reuse matters: most wikilinks within a page (and across
 * pages in a session) point at a small set of canonical targets, so
 * repeat lookups never hit disk.
 */
const LINK_EXISTS_TTL_MS = 60 * 1000;
const linkExistsCache = new QuickLRU<string, { exists: boolean; expiresAt: number }>({
	maxSize: 4096,
});

function cachedLinkExists(workingDir: string, urlPath: string, now = Date.now()): boolean {
	// Key by workingDir + URL path so two handlers with different roots
	// can't poison each other's broken-link styling. In practice we run
	// one handler per process, but the cache is module-global so this is
	// belt-and-braces.
	const key = `${workingDir}\0${urlPath}`;
	const cached = linkExistsCache.get(key);
	if (cached && cached.expiresAt > now) return cached.exists;

	const rel = urlPath.startsWith("/w/") ? urlPath.slice("/w/".length) : urlPath;
	const decoded = safeDecode(rel);
	const r = decoded === null ? null : resolveSafe(workingDir, decoded);
	const exists = !!r?.ok && existsSync(r.absPath);

	linkExistsCache.set(key, { exists, expiresAt: now + LINK_EXISTS_TTL_MS });
	return exists;
}

/** Test helper — clear the wikilink existence cache between tests. */
export function __clearLinkExistsCache(): void {
	linkExistsCache.clear();
}

// Public CSS lives next to this file at compile time. Resolve once.
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

export type WikiHandlerOptions = {
	workingDir: string;
	cookieSecret: string;
	slack: {
		clientId: string;
		clientSecret: string;
		teamId: string;
		redirectUri: string;
	};
	/** Resolve a Slack channel id to its name (no leading #). */
	lookupChannel?: (channelId: string) => string | undefined;
};

export async function createWikiHandler(
	opts: WikiHandlerOptions,
): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
	const renderer = await createRenderer();

	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		// Asset serving — no auth.
		if (path.startsWith("/public/")) {
			return servePublic(path, res);
		}
		if (path === "/auth/slack/start") {
			return handleAuthStart(opts, url, res);
		}
		if (path === "/auth/slack/callback") {
			return handleAuthCallback(opts, url, req, res);
		}
		if (path === "/auth/logout") {
			return handleLogout(res);
		}
		if (path === "/w" || path === "/w/" || path.startsWith("/w/")) {
			return handleWiki(opts, renderer, url, req, res);
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	};
}

// ---------------------------------------------------------------------------
// /public/*
// ---------------------------------------------------------------------------

async function servePublic(urlPath: string, res: ServerResponse): Promise<void> {
	const rel = urlPath.slice("/public/".length);
	// Disallow traversal & dotfiles in /public.
	if (rel.split("/").some((s) => s === ".." || s === "" || s.startsWith("."))) {
		notFound(res);
		return;
	}
	const abs = join(PUBLIC_DIR, rel);
	if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs)) {
		notFound(res);
		return;
	}
	const ct = contentTypeFor(extname(abs).toLowerCase());
	res.writeHead(200, {
		"Content-Type": ct,
		"Cache-Control": "public, max-age=3600",
		"X-Robots-Tag": "noindex, nofollow",
	});
	await streamFile(abs, res);
}

/**
 * Stream a file into the response, swallowing source-stream errors so a
 * TOCTOU race or EFS hiccup doesn't crash the whole bot via an unhandled
 * 'error' event on the readable. Uses stream/promises.pipeline so both
 * sides get cleaned up.
 *
 * `res.writeHead` MUST have been called before — once we're streaming,
 * there's no way to signal a 5xx, so on error we just close the partial
 * response and log.
 */
async function streamFile(abs: string, res: ServerResponse): Promise<void> {
	try {
		await pipeline(createReadStream(abs), res);
	} catch (err) {
		log.warn(`[wiki] stream error on ${abs}`, err instanceof Error ? err.message : String(err));
		if (!res.writableEnded) res.end();
	}
}

function contentTypeFor(ext: string): string {
	switch (ext) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "application/javascript; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

// ---------------------------------------------------------------------------
// /auth/*
// ---------------------------------------------------------------------------

function handleAuthStart(opts: WikiHandlerOptions, url: URL, res: ServerResponse): void {
	const returnTo = sanitizeReturnTo(url.searchParams.get("r"));
	const { state, nonce } = signStateWithNonce(returnTo, opts.cookieSecret);
	const href = authorizeUrl({
		clientId: opts.slack.clientId,
		redirectUri: opts.slack.redirectUri,
		state,
		nonce,
	});
	log.info(`[wiki] auth-start → ${returnTo}`);
	res.writeHead(302, {
		Location: href,
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

/**
 * Sign the OAuth state and return both the encoded token and its embedded
 * nonce. The nonce is sent in the authorize URL and later compared against
 * id_token.nonce in exchangeCode.
 */
function signStateWithNonce(returnTo: string, secret: string): { state: string; nonce: string } {
	const state = signState(returnTo, secret);
	const verified = verifyState(state, secret);
	if (!verified.ok) throw new Error("just-signed state failed to verify");
	return { state, nonce: verified.nonce };
}

async function handleAuthCallback(
	opts: WikiHandlerOptions,
	url: URL,
	_req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		log.warn("[wiki] auth-callback missing code/state");
		return loginPage(opts, "/w/", res, 400);
	}
	const verified = verifyState(state, opts.cookieSecret);
	if (!verified.ok) {
		log.warn("[wiki] auth-callback bad state");
		return loginPage(opts, "/w/", res, 400);
	}
	const identity = await exchangeCode(code, {
		clientId: opts.slack.clientId,
		clientSecret: opts.slack.clientSecret,
		redirectUri: opts.slack.redirectUri,
		expectedNonce: verified.nonce,
	});
	if (!identity) {
		log.warn("[wiki] auth-callback exchange failed");
		return loginPage(opts, verified.returnTo, res, 401);
	}
	if (identity.teamId !== opts.slack.teamId) {
		log.warn(`[wiki] auth-callback wrong team: ${identity.teamId} != ${opts.slack.teamId}`);
		return loginPage(opts, verified.returnTo, res, 403);
	}
	log.info(`[wiki] auth-callback ok user=${identity.userId} → ${verified.returnTo}`);
	res.writeHead(302, {
		Location: verified.returnTo,
		"Set-Cookie": mintCookieHeader(identity.userId, identity.teamId, opts.cookieSecret),
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

function handleLogout(res: ServerResponse): void {
	log.info("[wiki] logout");
	res.writeHead(302, {
		Location: "/w/",
		"Set-Cookie": clearCookieHeader(),
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

function loginPage(opts: WikiHandlerOptions, returnTo: string, res: ServerResponse, status = 200): void {
	const { state, nonce } = signStateWithNonce(sanitizeReturnTo(returnTo), opts.cookieSecret);
	const href = authorizeUrl({
		clientId: opts.slack.clientId,
		redirectUri: opts.slack.redirectUri,
		state,
		nonce,
	});
	const html = renderLoginPage(href);
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end(html);
}

// ---------------------------------------------------------------------------
// /w/*
// ---------------------------------------------------------------------------

async function handleWiki(
	opts: WikiHandlerOptions,
	renderer: Renderer,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	// Auth gate. Existing valid cookies are *never* demoted.
	const cookieVal = readCookie(req.headers.cookie);
	const auth = cookieVal ? verifyCookie(cookieVal, opts.cookieSecret) : null;
	const ok = auth?.ok === true;

	const requestedPath = url.pathname.startsWith("/w/") ? url.pathname.slice("/w/".length) : "";
	const decodedPath = safeDecode(requestedPath);

	log.info(`[wiki] GET ${url.pathname} user=${ok ? auth!.payload.sub : "-"} status=${ok ? "auth" : "redirect"}`);

	if (!ok) {
		const returnTo = url.pathname + (url.search || "");
		const startUrl = `/auth/slack/start?r=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
		const headers: Record<string, string> = {
			Location: startUrl,
			"X-Robots-Tag": "noindex, nofollow",
		};
		if (cookieVal) headers["Set-Cookie"] = clearCookieHeader();
		res.writeHead(302, headers);
		res.end();
		return;
	}

	// Slide the cookie forward.
	const slide = mintCookieHeader(auth!.payload.sub, auth!.payload.team, opts.cookieSecret);

	if (decodedPath === null) {
		return wikiNotFound(opts, slide, requestedPath, res);
	}

	const resolved = resolveSafe(opts.workingDir, decodedPath);
	if (!resolved.ok) {
		return wikiNotFound(opts, slide, decodedPath, res);
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(resolved.absPath);
	} catch {
		return wikiNotFound(opts, slide, decodedPath, res);
	}

	if (stat.isDirectory()) {
		// Canonicalise: directories always have a trailing slash.
		if (!url.pathname.endsWith("/")) {
			res.writeHead(302, { Location: `${url.pathname}/`, "Set-Cookie": slide });
			res.end();
			return;
		}
		return serveDirectory(opts, renderer, resolved.absPath, decodedPath, slide, res);
	}

	if (!stat.isFile()) {
		return wikiNotFound(opts, slide, decodedPath, res);
	}

	// Images → raw bytes with correct mime.
	const imageMime = await detectImageMimeSafely(resolved.absPath);
	if (imageMime) {
		if (stat.size > RAW_MAX_BYTES) return wikiNotFound(opts, slide, decodedPath, res);
		res.writeHead(200, {
			"Content-Type": imageMime,
			"Content-Length": stat.size,
			"Cache-Control": "private, max-age=60",
			"Set-Cookie": slide,
			"X-Robots-Tag": "noindex, nofollow",
		});
		await streamFile(resolved.absPath, res);
		return;
	}

	// Text / markdown — render through the wiki template. Files larger than
	// RENDER_MAX_BYTES are truncated to the cap and rendered with a banner;
	// a hard 404 would hide content the user might still want to peek at.
	let content: string;
	let truncated = false;
	try {
		if (stat.size > RENDER_MAX_BYTES) {
			const fd = await import("fs/promises").then((m) => m.open(resolved.absPath, "r"));
			try {
				const buf = Buffer.alloc(RENDER_MAX_BYTES);
				await fd.read(buf, 0, RENDER_MAX_BYTES, 0);
				content = buf.toString("utf8");
			} finally {
				await fd.close();
			}
			truncated = true;
		} else {
			content = readFileSync(resolved.absPath, "utf8");
		}
	} catch {
		return wikiNotFound(opts, slide, decodedPath, res);
	}

	const linkExists = (urlPath: string) => cachedLinkExists(opts.workingDir, urlPath);

	const isMd = extname(resolved.absPath).toLowerCase() === ".md";
	const rendered = isMd
		? renderer.renderMarkdown(content, { linkExists })
		: renderer.renderTextAsCode(content, resolved.absPath, { linkExists });
	const banner = truncated
		? `<div class="wiki-banner">Showing the first ${formatSize(RENDER_MAX_BYTES)} of ${formatSize(stat.size)}. Larger files aren't rendered in full.</div>`
		: "";
	const bodyHtml = `${banner}${rendered}`;

	const labelOverrides = channelLabelOverrides(decodedPath, opts.lookupChannel);
	const lastSeg = decodedPath.slice(decodedPath.lastIndexOf("/") + 1);
	const html = renderShell({
		title: lastSeg,
		crumbs: buildCrumbs(decodedPath, labelOverrides),
		meta: `${formatMtime(stat.mtimeMs)} · ${formatSize(stat.size)}${truncated ? " (truncated)" : ""} · ${inferLang(resolved.absPath)}`,
		bodyHtml,
	});

	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "private, max-age=60",
		"Set-Cookie": slide,
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end(html);
}

function serveDirectory(
	opts: WikiHandlerOptions,
	_renderer: Renderer,
	absDir: string,
	decodedPath: string,
	slideCookie: string,
	res: ServerResponse,
): void {
	const urlDir = decodedPath.length === 0 ? "" : `${decodedPath.replace(/\/+$/, "")}/`;
	const entries = listDirectory(opts.workingDir, absDir, urlDir, opts.lookupChannel);
	const labelOverrides = channelLabelOverrides(decodedPath, opts.lookupChannel);
	const lastSeg = decodedPath.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "index";
	const title = labelOverrides?.[lastSeg] ?? (decodedPath === "" ? "digby" : lastSeg);
	const html = renderShell({
		title,
		crumbs: buildCrumbs(decodedPath, labelOverrides),
		meta: `${entries.length} entries`,
		bodyHtml: renderListingBody(entries),
	});
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "private, max-age=60",
		"Set-Cookie": slideCookie,
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end(html);
}

function wikiNotFound(opts: WikiHandlerOptions, slideCookie: string, decodedPath: string, res: ServerResponse): void {
	const labelOverrides = channelLabelOverrides(decodedPath, opts.lookupChannel);
	const html = renderShell({
		title: "Not found",
		crumbs: buildCrumbs(decodedPath, labelOverrides),
		bodyHtml: renderMissingBody(`/w/${decodedPath}`),
	});
	res.writeHead(404, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Set-Cookie": slideCookie,
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end(html);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function detectImageMimeSafely(absPath: string): Promise<string | null> {
	try {
		return await detectSupportedImageMimeTypeFromFile(absPath);
	} catch {
		return null;
	}
}

/** Decode the URL path, returning null on invalid escape sequences. */
function safeDecode(s: string): string | null {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
}

/**
 * Build crumb-label overrides for channel IDs in the current path. Crumbs
 * render via `buildCrumbs(path, overrides)` keyed on segment name.
 */
function channelLabelOverrides(
	decodedPath: string,
	lookup?: (id: string) => string | undefined,
): Record<string, string> | undefined {
	if (!lookup) return undefined;
	const out: Record<string, string> = {};
	for (const seg of decodedPath.split("/")) {
		if (/^[CDG][A-Z0-9]{6,}$/.test(seg)) {
			const name = lookup(seg);
			if (name) out[seg] = `#${name}`;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Restrict return-to URLs to same-origin paths under /w/ — blocks
 * open-redirect attacks via the ?r= parameter.
 *
 * Rules:
 *  - Must start with "/w/" or be exactly "/w" (constrains the wiki to
 *    itself; no redirecting users to /auth/logout, /health, etc).
 *  - Reject "//foo" (protocol-relative) and backslash (some browsers
 *    treat "\" as "/" in URLs).
 *  - Reject ASCII control characters (0x00-0x1f, 0x7f). Unicode
 *    filenames are fine — the URL is decoded once and the path is
 *    later split into segments, each checked by resolveSafe.
 */
function sanitizeReturnTo(r: string | null): string {
	if (!r) return "/w/";
	if (r.includes("\\") || /[\x00-\x1f\x7f]/.test(r)) return "/w/";
	if (r !== "/w" && !r.startsWith("/w/")) return "/w/";
	return r;
}

function formatMtime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function notFound(res: ServerResponse): void {
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("Not found");
}

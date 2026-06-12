/**
 * Raw file endpoint — /r/* — serves files as raw bytes behind the same
 * Slack OAuth auth and ACL as the wiki handler. No HTML rendering or
 * directory listings; file-only, 50 MB cap, correct Content-Type by
 * extension, Content-Disposition: attachment for unknown/binary types.
 */
import { createReadStream, statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { extname } from "path";
import { pipeline } from "stream/promises";
import * as log from "../log.js";
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
import { contentTypeFor, needsAttachment } from "./mime.js";

const RAW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

export type RawHandlerOptions = {
	workingDir: string;
	cookieSecret: string;
	slack: {
		clientId: string;
		clientSecret: string;
		teamId: string;
		redirectUri: string;
	};
};

export async function createRawHandler(
	opts: RawHandlerOptions,
): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (path === "/auth/slack/start") {
			return handleAuthStart(opts, url, res);
		}
		if (path === "/auth/slack/callback") {
			return handleAuthCallback(opts, url, res);
		}
		if (path === "/auth/logout") {
			return handleLogout(res);
		}
		if (path === "/r" || path === "/r/" || path.startsWith("/r/")) {
			return handleRaw(opts, url, req, res);
		}

		rawNotFound(res);
	};
}

// ---------------------------------------------------------------------------
// /auth/*
// ---------------------------------------------------------------------------

function handleAuthStart(opts: RawHandlerOptions, url: URL, res: ServerResponse): void {
	const returnTo = sanitizeReturnTo(url.searchParams.get("r"));
	const { state, nonce } = signStateWithNonce(returnTo, opts.cookieSecret);
	const href = authorizeUrl({
		clientId: opts.slack.clientId,
		redirectUri: opts.slack.redirectUri,
		state,
		nonce,
	});
	log.info(`[raw] auth-start → ${returnTo}`);
	res.writeHead(302, {
		Location: href,
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

async function handleAuthCallback(opts: RawHandlerOptions, url: URL, res: ServerResponse): Promise<void> {
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		log.warn("[raw] auth-callback missing code/state");
		res.writeHead(302, { Location: "/r/", "X-Robots-Tag": "noindex, nofollow" });
		res.end();
		return;
	}
	const verified = verifyState(state, opts.cookieSecret);
	if (!verified.ok) {
		log.warn("[raw] auth-callback bad state");
		res.writeHead(302, { Location: "/r/", "X-Robots-Tag": "noindex, nofollow" });
		res.end();
		return;
	}
	const identity = await exchangeCode(code, {
		clientId: opts.slack.clientId,
		clientSecret: opts.slack.clientSecret,
		redirectUri: opts.slack.redirectUri,
		expectedNonce: verified.nonce,
	});
	if (!identity) {
		log.warn("[raw] auth-callback exchange failed");
		res.writeHead(302, { Location: "/r/", "X-Robots-Tag": "noindex, nofollow" });
		res.end();
		return;
	}
	if (identity.teamId !== opts.slack.teamId) {
		log.warn(`[raw] auth-callback wrong team: ${identity.teamId} != ${opts.slack.teamId}`);
		res.writeHead(302, { Location: "/r/", "X-Robots-Tag": "noindex, nofollow" });
		res.end();
		return;
	}
	log.info(`[raw] auth-callback ok user=${identity.userId} → ${verified.returnTo}`);
	res.writeHead(302, {
		Location: verified.returnTo,
		"Set-Cookie": mintCookieHeader(identity.userId, identity.teamId, opts.cookieSecret),
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

function handleLogout(res: ServerResponse): void {
	log.info("[raw] logout");
	res.writeHead(302, {
		Location: "/r/",
		"Set-Cookie": clearCookieHeader(),
		"X-Robots-Tag": "noindex, nofollow",
	});
	res.end();
}

// ---------------------------------------------------------------------------
// /r/*
// ---------------------------------------------------------------------------

async function handleRaw(opts: RawHandlerOptions, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const cookieVal = readCookie(req.headers.cookie);
	const auth = cookieVal ? verifyCookie(cookieVal, opts.cookieSecret) : null;
	const ok = auth?.ok === true;

	const requestedPath = url.pathname.startsWith("/r/") ? url.pathname.slice("/r/".length) : "";

	log.info(`[raw] GET ${url.pathname} user=${ok ? auth!.payload.sub : "-"} status=${ok ? "auth" : "redirect"}`);

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

	const slide = mintCookieHeader(auth!.payload.sub, auth!.payload.team, opts.cookieSecret);

	// /r and /r/ with no path component → 404 (no index for the raw endpoint)
	if (requestedPath === "") {
		rawNotFound(res, slide);
		return;
	}

	const decodedPath = safeDecode(requestedPath);
	if (decodedPath === null) {
		rawNotFound(res, slide);
		return;
	}

	// No search endpoint on /r/
	if (decodedPath === "_search") {
		rawNotFound(res, slide);
		return;
	}

	const resolved = resolveSafe(opts.workingDir, decodedPath);
	if (!resolved.ok) {
		rawNotFound(res, slide);
		return;
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(resolved.absPath);
	} catch {
		rawNotFound(res, slide);
		return;
	}

	// Directories → 404 (file-only endpoint)
	if (!stat.isFile()) {
		rawNotFound(res, slide);
		return;
	}

	// 50 MB hard cap
	if (stat.size > RAW_MAX_BYTES) {
		rawNotFound(res, slide);
		return;
	}

	const ext = extname(resolved.absPath).toLowerCase();
	const ct = contentTypeFor(ext);
	const headers: Record<string, string | number> = {
		"Content-Type": ct,
		"Content-Length": stat.size,
		"Cache-Control": "private, max-age=60",
		"Set-Cookie": slide,
		"X-Robots-Tag": "noindex, nofollow",
	};
	if (needsAttachment(ext)) {
		headers["Content-Disposition"] = "attachment";
	}

	res.writeHead(200, headers);
	await streamFile(resolved.absPath, res);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signStateWithNonce(returnTo: string, secret: string): { state: string; nonce: string } {
	const state = signState(returnTo, secret);
	const verified = verifyState(state, secret);
	if (!verified.ok) throw new Error("just-signed state failed to verify");
	return { state, nonce: verified.nonce };
}

/**
 * Restrict return-to URLs to same-origin paths under /r/ — blocks open-redirect
 * attacks via the ?r= parameter. Mirrors the /w/ guard in handler.ts.
 */
function sanitizeReturnTo(r: string | null): string {
	if (!r) return "/r/";
	if (r.includes("\\") || /[\x00-\x1f\x7f]/.test(r)) return "/r/";
	if (r !== "/r" && !r.startsWith("/r/")) return "/r/";
	return r;
}

function safeDecode(s: string): string | null {
	try {
		return decodeURIComponent(s);
	} catch {
		return null;
	}
}

async function streamFile(abs: string, res: ServerResponse): Promise<void> {
	try {
		await pipeline(createReadStream(abs), res);
	} catch (err) {
		log.warn(`[raw] stream error on ${abs}`, err instanceof Error ? err.message : String(err));
		if (!res.writableEnded) res.end();
	}
}

function rawNotFound(res: ServerResponse, slide?: string): void {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-Robots-Tag": "noindex, nofollow",
	};
	if (slide) headers["Set-Cookie"] = slide;
	res.writeHead(404, headers);
	res.end("Not found");
}

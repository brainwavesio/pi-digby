/**
 * Wiki auth — Sign in with Slack (OpenID Connect) + signed cookie + signed state.
 *
 * Two HMAC-signed payloads, both `<base64url(json)>.<base64url(hmac)>`:
 *   - Cookie:  { sub, team, exp }  — 30d sliding session
 *   - State:   { r, n, exp }       — short-lived OAuth return-to + nonce
 *
 * No external JWT library — our payloads are our own format, not RFC JWT.
 *
 * Slack's id_token signature is intentionally NOT verified against the JWKS:
 * we obtain it via a direct HTTPS POST to slack.com authenticated with our
 * client_secret, so an attacker can't substitute a token mid-flight without
 * breaking TLS to slack.com. We still enforce the OIDC claim checks
 * (`iss`, `aud`, `exp`, `nonce`) inside validateIdToken — those guard
 * against token replay, audience confusion, and stale tokens even given
 * the TLS trust assumption.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "digby_w";
export const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";

export type CookiePayload = { sub: string; team: string; exp: number };
/**
 * State payload — `n` doubles as both CSRF nonce and the OIDC nonce we send
 * in the authorize URL. Slack echoes it back in the id_token's `nonce`
 * claim; we then verify the echoed value matches what we signed in `state`.
 */
export type StatePayload = { r: string; n: string; exp: number };

export const SLACK_ISSUER = "https://slack.com";

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function b64urlEncode(buf: Buffer | string): string {
	const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
	return b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	return Buffer.from(padded, "base64");
}

function hmac(secret: string, payload: string): string {
	return b64urlEncode(createHmac("sha256", secret).update(payload).digest());
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Cookie sign/verify
// ---------------------------------------------------------------------------

export function signCookie(payload: CookiePayload, secret: string): string {
	const body = b64urlEncode(JSON.stringify(payload));
	return `${body}.${hmac(secret, body)}`;
}

export function verifyCookie(
	token: string,
	secret: string,
	now = Date.now(),
): { ok: true; payload: CookiePayload } | { ok: false } {
	const parts = token.split(".");
	if (parts.length !== 2) return { ok: false };
	const [body, sig] = parts;
	if (!safeEqual(sig, hmac(secret, body))) return { ok: false };
	let parsed: CookiePayload;
	try {
		parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
	} catch {
		return { ok: false };
	}
	if (!parsed || typeof parsed.sub !== "string" || typeof parsed.team !== "string" || typeof parsed.exp !== "number") {
		return { ok: false };
	}
	if (parsed.exp < now) return { ok: false };
	return { ok: true, payload: parsed };
}

/**
 * Serialise a fresh 30d cookie. Caller emits this in a Set-Cookie header on
 * every successful authenticated response to slide the expiry forward.
 */
export function mintCookieHeader(sub: string, team: string, secret: string, now = Date.now()): string {
	const exp = now + COOKIE_TTL_MS;
	const value = signCookie({ sub, team, exp }, secret);
	return cookieHeader(COOKIE_NAME, value, COOKIE_TTL_MS);
}

export function clearCookieHeader(): string {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieHeader(name: string, value: string, maxAgeMs: number): string {
	const maxAgeSec = Math.floor(maxAgeMs / 1000);
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

/** Pull `digby_w` value out of a raw Cookie header. */
export function readCookie(cookieHeaderValue: string | undefined): string | undefined {
	if (!cookieHeaderValue) return undefined;
	for (const part of cookieHeaderValue.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === COOKIE_NAME) return rest.join("=");
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// State sign/verify (OAuth CSRF + return-to)
// ---------------------------------------------------------------------------

export function signState(returnTo: string, secret: string, now = Date.now()): string {
	const payload: StatePayload = {
		r: returnTo,
		n: randomBytes(16).toString("hex"),
		exp: now + STATE_TTL_MS,
	};
	const body = b64urlEncode(JSON.stringify(payload));
	return `${body}.${hmac(secret, body)}`;
}

export function verifyState(
	state: string,
	secret: string,
	now = Date.now(),
): { ok: true; returnTo: string; nonce: string } | { ok: false } {
	const parts = state.split(".");
	if (parts.length !== 2) return { ok: false };
	const [body, sig] = parts;
	if (!safeEqual(sig, hmac(secret, body))) return { ok: false };
	let parsed: StatePayload;
	try {
		parsed = JSON.parse(b64urlDecode(body).toString("utf8"));
	} catch {
		return { ok: false };
	}
	if (!parsed || typeof parsed.r !== "string" || typeof parsed.n !== "string" || typeof parsed.exp !== "number") {
		return { ok: false };
	}
	if (parsed.exp < now) return { ok: false };
	return { ok: true, returnTo: parsed.r, nonce: parsed.n };
}

// ---------------------------------------------------------------------------
// Slack OAuth helpers
// ---------------------------------------------------------------------------

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; nonce: string }): string {
	const params = new URLSearchParams({
		response_type: "code",
		scope: "openid profile email",
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		state: opts.state,
		nonce: opts.nonce,
	});
	return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

export type SlackIdentity = { userId: string; teamId: string };

/**
 * Exchange an OAuth code for the user's Slack identity.
 * Returns null on any failure — the caller maps that to "auth failed".
 */
export async function exchangeCode(
	code: string,
	opts: {
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		/** Nonce we sent in the authorize URL — must match id_token.nonce. */
		expectedNonce: string;
	},
	fetchFn: typeof fetch = fetch,
	now = Date.now(),
): Promise<SlackIdentity | null> {
	const body = new URLSearchParams({
		code,
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
		redirect_uri: opts.redirectUri,
		grant_type: "authorization_code",
	});
	let res: Response;
	try {
		res = await fetchFn(SLACK_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	let json: { ok?: boolean; id_token?: string; error?: string };
	try {
		json = (await res.json()) as { ok?: boolean; id_token?: string; error?: string };
	} catch {
		return null;
	}
	if (!json.ok || !json.id_token) return null;
	return validateIdToken(json.id_token, {
		audience: opts.clientId,
		expectedNonce: opts.expectedNonce,
		now,
	});
}

/**
 * Validate a Slack id_token against the OIDC claims we care about, and
 * extract the user/team identity. Returns null on any failure.
 *
 * Claims checked:
 *  - `iss` must equal "https://slack.com"
 *  - `aud` must equal our client_id (string or string[])
 *  - `exp` must be in the future (with a 60s clock-skew allowance)
 *  - `nonce` must equal what we sent in the authorize URL
 *  - `sub` must be a string (the Slack user id)
 *  - team_id must be present (namespaced `https://slack.com/team_id`,
 *    falling back to `team.id`)
 *
 * Signature/JWKS is intentionally NOT verified — see file-level comment.
 */
export function validateIdToken(
	idToken: string,
	opts: { audience: string; expectedNonce: string; now?: number; skewSeconds?: number },
): SlackIdentity | null {
	const parts = idToken.split(".");
	if (parts.length !== 3) return null;
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
	} catch {
		return null;
	}

	if (claims.iss !== SLACK_ISSUER) return null;

	const aud = claims.aud;
	const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
	if (!audOk) return null;

	const exp = typeof claims.exp === "number" ? claims.exp : null;
	if (exp === null) return null;
	const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
	const skew = opts.skewSeconds ?? 60;
	if (exp + skew < nowSec) return null;

	if (claims.nonce !== opts.expectedNonce) return null;

	const sub = claims.sub;
	const team =
		(claims["https://slack.com/team_id"] as string | undefined) ??
		((claims.team as { id?: string } | undefined)?.id as string | undefined);
	if (typeof sub !== "string" || typeof team !== "string") return null;
	return { userId: sub, teamId: team };
}

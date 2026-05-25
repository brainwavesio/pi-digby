/**
 * Wiki auth — Sign in with Slack (OpenID Connect) + signed cookie + signed state.
 *
 * Two HMAC-signed payloads, both `<base64url(json)>.<base64url(hmac)>`:
 *   - Cookie:  { sub, team, exp }  — 30d sliding session
 *   - State:   { r, n, exp }       — short-lived OAuth return-to + nonce
 *
 * No external JWT library — payloads are our own format, not RFC JWT.
 *
 * Slack's id_token (received over TLS from the token endpoint) is decoded
 * without signature verification. That's defensible because the only path
 * by which we obtain it is a direct HTTPS POST to slack.com, with our
 * client_secret in the body; an attacker can't substitute their own token
 * mid-flight without breaking TLS to slack.com.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "digby_w";
export const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";

export type CookiePayload = { sub: string; team: string; exp: number };
export type StatePayload = { r: string; n: string; exp: number };

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
): { ok: true; returnTo: string } | { ok: false } {
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
	if (!parsed || typeof parsed.r !== "string" || typeof parsed.exp !== "number") {
		return { ok: false };
	}
	if (parsed.exp < now) return { ok: false };
	return { ok: true, returnTo: parsed.r };
}

// ---------------------------------------------------------------------------
// Slack OAuth helpers
// ---------------------------------------------------------------------------

export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
	const params = new URLSearchParams({
		response_type: "code",
		scope: "openid profile email",
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		state: opts.state,
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
	opts: { clientId: string; clientSecret: string; redirectUri: string },
	fetchFn: typeof fetch = fetch,
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
	return decodeIdToken(json.id_token);
}

/**
 * Decode the unsigned payload of a Slack id_token. We trust this because we
 * just fetched it directly from slack.com over TLS using our client_secret —
 * see file-level comment.
 */
export function decodeIdToken(idToken: string): SlackIdentity | null {
	const parts = idToken.split(".");
	if (parts.length !== 3) return null;
	let claims: Record<string, unknown>;
	try {
		claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
	} catch {
		return null;
	}
	const sub = claims.sub;
	// Slack puts team_id in a namespaced claim. Accept either.
	const team =
		(claims["https://slack.com/team_id"] as string | undefined) ??
		((claims.team as { id?: string } | undefined)?.id as string | undefined);
	if (typeof sub !== "string" || typeof team !== "string") return null;
	return { userId: sub, teamId: team };
}

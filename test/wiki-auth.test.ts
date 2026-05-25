import { describe, expect, it } from "vitest";
import {
	COOKIE_TTL_MS,
	readCookie,
	signCookie,
	signState,
	SLACK_ISSUER,
	validateIdToken,
	verifyCookie,
	verifyState,
} from "../src/wiki/auth.js";

const SECRET = "test-secret-keep-it-quiet";

describe("cookie sign/verify", () => {
	it("roundtrips a valid cookie", () => {
		const now = Date.now();
		const token = signCookie({ sub: "U1", team: "T1", exp: now + 1000 }, SECRET);
		const res = verifyCookie(token, SECRET, now);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.payload.sub).toBe("U1");
			expect(res.payload.team).toBe("T1");
		}
	});

	it("rejects an expired cookie", () => {
		const now = Date.now();
		const token = signCookie({ sub: "U1", team: "T1", exp: now - 1 }, SECRET);
		expect(verifyCookie(token, SECRET, now).ok).toBe(false);
	});

	it("rejects a tampered cookie", () => {
		const now = Date.now();
		const token = signCookie({ sub: "U1", team: "T1", exp: now + 1000 }, SECRET);
		// Flip one char in the body half.
		const [body, sig] = token.split(".");
		const tampered = `${body.slice(0, -1)}X.${sig}`;
		expect(verifyCookie(tampered, SECRET, now).ok).toBe(false);
	});

	it("rejects under a different secret", () => {
		const now = Date.now();
		const token = signCookie({ sub: "U1", team: "T1", exp: now + 1000 }, SECRET);
		expect(verifyCookie(token, "other-secret", now).ok).toBe(false);
	});

	it("rejects garbage", () => {
		expect(verifyCookie("not-even-close", SECRET).ok).toBe(false);
		expect(verifyCookie("only.one.dot.too.many", SECRET).ok).toBe(false);
		expect(verifyCookie("", SECRET).ok).toBe(false);
	});

	it("mints sessions with a 30d TTL", () => {
		// sanity: COOKIE_TTL_MS is what we advertise
		expect(COOKIE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});
});

describe("readCookie", () => {
	it("finds digby_w among other cookies", () => {
		expect(readCookie("foo=bar; digby_w=abc.def; baz=qux")).toBe("abc.def");
	});
	it("returns undefined when missing", () => {
		expect(readCookie("foo=bar")).toBeUndefined();
		expect(readCookie(undefined)).toBeUndefined();
	});
});

describe("state sign/verify", () => {
	it("roundtrips the return-to path and exposes the embedded nonce", () => {
		const state = signState("/w/memory/tom.md", SECRET);
		const res = verifyState(state, SECRET);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.returnTo).toBe("/w/memory/tom.md");
			expect(res.nonce).toMatch(/^[0-9a-f]{32}$/);
		}
	});

	it("rejects an expired state", () => {
		const now = Date.now();
		const state = signState("/w/x", SECRET, now - 11 * 60 * 1000);
		expect(verifyState(state, SECRET, now).ok).toBe(false);
	});

	it("rejects a tampered state", () => {
		const state = signState("/w/x", SECRET);
		const [body, sig] = state.split(".");
		expect(verifyState(`${body}.${sig.slice(0, -1)}X`, SECRET).ok).toBe(false);
	});
});

describe("validateIdToken (OIDC claim checks)", () => {
	const CLIENT_ID = "12345.67890";
	const NONCE = "abcdef0123";

	function makeIdToken(claims: Record<string, unknown>): string {
		const enc = (o: object) =>
			Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
		return `${enc({ alg: "none" })}.${enc(claims)}.sig-not-checked`;
	}

	const okClaims = (over: Record<string, unknown> = {}) => ({
		iss: SLACK_ISSUER,
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 600,
		nonce: NONCE,
		sub: "U123",
		"https://slack.com/team_id": "T456",
		...over,
	});

	it("accepts a well-formed id_token", () => {
		const id = makeIdToken(okClaims());
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toEqual({
			userId: "U123",
			teamId: "T456",
		});
	});

	it("accepts aud as array containing the audience", () => {
		const id = makeIdToken(okClaims({ aud: ["other", CLIENT_ID] }));
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).not.toBeNull();
	});

	it("falls back to team.id when team_id namespace claim is missing", () => {
		const id = makeIdToken(
			okClaims({ "https://slack.com/team_id": undefined, team: { id: "T999" } }),
		);
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toEqual({
			userId: "U123",
			teamId: "T999",
		});
	});

	it("rejects a wrong issuer", () => {
		const id = makeIdToken(okClaims({ iss: "https://evil.example" }));
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
	});

	it("rejects a wrong audience", () => {
		const id = makeIdToken(okClaims({ aud: "different-client-id" }));
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
	});

	it("rejects an expired token (past skew)", () => {
		const id = makeIdToken(okClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
	});

	it("rejects a wrong nonce (replay)", () => {
		const id = makeIdToken(okClaims({ nonce: "different-nonce" }));
		expect(validateIdToken(id, { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
	});

	it("rejects when sub or team_id is missing", () => {
		expect(
			validateIdToken(makeIdToken(okClaims({ sub: undefined })), {
				audience: CLIENT_ID,
				expectedNonce: NONCE,
			}),
		).toBeNull();
		expect(
			validateIdToken(
				makeIdToken(okClaims({ "https://slack.com/team_id": undefined, team: undefined })),
				{ audience: CLIENT_ID, expectedNonce: NONCE },
			),
		).toBeNull();
	});

	it("rejects malformed tokens", () => {
		expect(validateIdToken("not.a.token.really", { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
		expect(validateIdToken("oneonly", { audience: CLIENT_ID, expectedNonce: NONCE })).toBeNull();
	});
});

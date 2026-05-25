import { describe, expect, it } from "vitest";
import {
	COOKIE_TTL_MS,
	decodeIdToken,
	readCookie,
	signCookie,
	signState,
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
	it("roundtrips the return-to path", () => {
		const state = signState("/w/memory/tom.md", SECRET);
		const res = verifyState(state, SECRET);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.returnTo).toBe("/w/memory/tom.md");
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

describe("decodeIdToken", () => {
	function makeIdToken(claims: Record<string, unknown>): string {
		const enc = (o: object) =>
			Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
		return `${enc({ alg: "none" })}.${enc(claims)}.sig-not-checked`;
	}

	it("extracts sub + team_id from a Slack id_token", () => {
		const id = makeIdToken({
			sub: "U123",
			"https://slack.com/team_id": "T456",
			email: "tom@example.com",
		});
		expect(decodeIdToken(id)).toEqual({ userId: "U123", teamId: "T456" });
	});

	it("falls back to team.id", () => {
		const id = makeIdToken({ sub: "U1", team: { id: "T1" } });
		expect(decodeIdToken(id)).toEqual({ userId: "U1", teamId: "T1" });
	});

	it("returns null when team_id is missing", () => {
		const id = makeIdToken({ sub: "U1" });
		expect(decodeIdToken(id)).toBeNull();
	});

	it("returns null on malformed token", () => {
		expect(decodeIdToken("not.a.token.really")).toBeNull();
		expect(decodeIdToken("oneonly")).toBeNull();
	});
});

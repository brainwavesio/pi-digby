/**
 * Tests for sanitizeReturnTo via the public auth-start handler.
 *
 * sanitizeReturnTo is module-private to handler.ts; we exercise it through
 * the user-visible behaviour (the signed state's `r` claim, decoded from
 * the Location header on /auth/slack/start).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { verifyState } from "../src/wiki/auth.js";
import { createWikiHandler } from "../src/wiki/handler.js";

const SECRET = "test-secret-sanitize";
// biome-ignore lint/suspicious/noExplicitAny: minimal node http stubs
let handler: any;

beforeAll(async () => {
	handler = await createWikiHandler({
		workingDir: "/tmp",
		cookieSecret: SECRET,
		slack: {
			clientId: "X",
			clientSecret: "Y",
			teamId: "T1",
			redirectUri: "https://example.com/auth/slack/callback",
		},
	});
});

function makeReq(url: string): {
	url: string;
	method: "GET";
	headers: Record<string, string>;
} {
	return { url, method: "GET", headers: {} };
}

function makeRes(): {
	statusCode: number;
	headers: Record<string, string | string[]>;
	body: string;
	writeHead: (s: number, h: Record<string, string | string[]>) => unknown;
	end: (b?: string) => unknown;
	getHeader: (n: string) => string | string[] | undefined;
	setHeader: (n: string, v: string) => unknown;
	headersSent: boolean;
} {
	const headers: Record<string, string | string[]> = {};
	const res = {
		statusCode: 0,
		headers,
		body: "",
		headersSent: false,
		writeHead(s: number, h: Record<string, string | string[]>) {
			res.statusCode = s;
			Object.assign(headers, h);
			res.headersSent = true;
			return res;
		},
		end(b = "") {
			res.body = b;
			return res;
		},
		getHeader(n: string) {
			return headers[n];
		},
		setHeader(n: string, v: string) {
			headers[n] = v;
			return res;
		},
	};
	return res;
}

async function startReturnTo(rawR: string | null): Promise<string> {
	const path = rawR === null ? "/auth/slack/start" : `/auth/slack/start?r=${encodeURIComponent(rawR)}`;
	const req = makeReq(path);
	const res = makeRes();
	await handler(req, res);
	const loc = res.headers.Location as string;
	const state = new URL(loc).searchParams.get("state");
	const verified = verifyState(state!, SECRET);
	if (!verified.ok) throw new Error("state failed to verify");
	return verified.returnTo;
}

describe("sanitizeReturnTo (via /auth/slack/start)", () => {
	it("accepts /w/", async () => {
		expect(await startReturnTo("/w/")).toBe("/w/");
	});
	it("accepts /w (no slash)", async () => {
		expect(await startReturnTo("/w")).toBe("/w");
	});
	it("accepts a nested /w/ path", async () => {
		expect(await startReturnTo("/w/memory/tom.md")).toBe("/w/memory/tom.md");
	});
	it("falls back when missing", async () => {
		expect(await startReturnTo(null)).toBe("/w/");
	});
	it("rejects protocol-relative //evil", async () => {
		expect(await startReturnTo("//evil.example/path")).toBe("/w/");
	});
	it("rejects absolute URLs", async () => {
		expect(await startReturnTo("https://evil.example/path")).toBe("/w/");
	});
	it("rejects non-/w paths (no redirect to /auth/logout, /health, etc.)", async () => {
		expect(await startReturnTo("/auth/logout")).toBe("/w/");
		expect(await startReturnTo("/health")).toBe("/w/");
		expect(await startReturnTo("/")).toBe("/w/");
	});
	it("rejects backslash", async () => {
		expect(await startReturnTo("/w/\\evil")).toBe("/w/");
		expect(await startReturnTo("\\\\evil.example")).toBe("/w/");
	});
	it("rejects ASCII control characters", async () => {
		expect(await startReturnTo("/w/\x00bad")).toBe("/w/");
		expect(await startReturnTo("/w/\x1ffoo")).toBe("/w/");
		expect(await startReturnTo("/w/\x7fdel")).toBe("/w/");
	});
	it("allows unicode filenames in /w/", async () => {
		expect(await startReturnTo("/w/memory/töm.md")).toBe("/w/memory/töm.md");
		expect(await startReturnTo("/w/メモ.md")).toBe("/w/メモ.md");
	});
});

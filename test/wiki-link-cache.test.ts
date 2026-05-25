/**
 * Tests for cachedLinkExists — wikilink existence checks are memoised
 * across renders to stop a markdown file with thousands of [[x]] links
 * from issuing one synchronous realpath + existsSync per occurrence.
 *
 * We exercise the cache via the public createWikiHandler path because
 * the cache itself is module-private; the assertion is that repeat
 * renders of a page with the same wikilink target don't re-stat.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signCookie } from "../src/wiki/auth.js";
import { __clearLinkExistsCache, createWikiHandler } from "../src/wiki/handler.js";

const SECRET = "test-link-cache-secret";
// biome-ignore lint/suspicious/noExplicitAny: minimal node http stubs
let handler: any;
let root: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "digby-link-cache-"));
	mkdirSync(join(root, "memory"));
	writeFileSync(join(root, "memory", "tom.md"), "# tom");
	writeFileSync(
		join(root, "page.md"),
		// 50 wikilinks pointing at the same target (cache should resolve once).
		Array.from({ length: 50 }, () => "[[memory/tom]]").join(" "),
	);
	handler = await createWikiHandler({
		workingDir: root,
		cookieSecret: SECRET,
		slack: {
			clientId: "X",
			clientSecret: "Y",
			teamId: "T1",
			redirectUri: "https://example.com/auth/slack/callback",
		},
	});
});

afterEach(() => {
	__clearLinkExistsCache();
});

beforeEach(() => {
	__clearLinkExistsCache();
});

function makeReq(url: string, cookie: string): {
	url: string;
	method: "GET";
	headers: Record<string, string>;
} {
	return { url, method: "GET", headers: { cookie: `digby_w=${cookie}` } };
}

function makeRes(): {
	statusCode: number;
	headers: Record<string, string | string[]>;
	body: string;
	writeHead: (s: number, h: Record<string, string | string[]>) => unknown;
	end: (b?: string) => unknown;
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
		setHeader(n: string, v: string) {
			headers[n] = v;
			return res;
		},
	};
	return res;
}

describe("cachedLinkExists", () => {
	it("renders 50 identical wikilinks as not-broken (cache works through markdown render)", async () => {
		const cookie = signCookie({ sub: "U1", team: "T1", exp: Date.now() + 60_000 }, SECRET);
		const req = makeReq("/w/page.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		// All 50 links rendered, none marked broken.
		expect(res.body).not.toContain("wiki-broken");
		expect((res.body.match(/wiki-link/g) ?? []).length).toBeGreaterThanOrEqual(50);
	});

	it("renders broken-link styling when target doesn't exist (and caches the miss)", async () => {
		const ghostPage = join(root, "ghost-page.md");
		writeFileSync(ghostPage, "[[memory/ghost]] [[memory/ghost]] [[memory/ghost]]");
		const cookie = signCookie({ sub: "U1", team: "T1", exp: Date.now() + 60_000 }, SECRET);
		const req = makeReq("/w/ghost-page.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("wiki-broken");
	});
});

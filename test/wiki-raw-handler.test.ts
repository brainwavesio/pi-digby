import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signCookie } from "../src/wiki/auth.js";
import { createRawHandler } from "../src/wiki/raw-handler.js";

const SECRET = "test-raw-handler-secret";
const TEAM = "T123456";

// biome-ignore lint/suspicious/noExplicitAny: minimal node http stubs
let handler: any;
let root: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "digby-raw-handler-"));
	mkdirSync(join(root, "docs"));
	mkdirSync(join(root, "credentials"));
	writeFileSync(join(root, "docs", "readme.md"), "# Hello\nworld");
	writeFileSync(join(root, "credentials", "secret.txt"), "hunter2");
	writeFileSync(join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

	handler = await createRawHandler({
		workingDir: root,
		cookieSecret: SECRET,
		slack: {
			clientId: "CLIENT_ID",
			clientSecret: "CLIENT_SECRET",
			teamId: TEAM,
			redirectUri: "https://example.com/auth/slack/callback",
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function validCookie(): string {
	return signCookie({ sub: "U001", team: TEAM, exp: Date.now() + 60_000 }, SECRET);
}

function makeReq(
	url: string,
	cookie?: string,
): { url: string; method: "GET"; headers: Record<string, string> } {
	return {
		url,
		method: "GET",
		headers: cookie ? { cookie: `digby_w=${cookie}` } : {},
	};
}

function makeRes() {
	// Use a PassThrough so stream/promises.pipeline can write to it and receive
	// the 'finish' event — a plain EventEmitter stub causes pipeline to hang.
	const { PassThrough } = require("stream");
	const stream = new PassThrough();
	const chunks: Buffer[] = [];
	stream.on("data", (c: Buffer) => chunks.push(c));

	const res = Object.assign(stream, {
		statusCode: 0,
		headers: {} as Record<string, string | number | string[]>,
		get body() {
			return Buffer.concat(chunks).toString();
		},
		headersSent: false,
		writeHead(s: number, h: Record<string, string | number | string[]>) {
			res.statusCode = s;
			Object.assign(res.headers, h);
			res.headersSent = true;
			return res;
		},
		setHeader(n: string, v: string) {
			res.headers[n] = v;
			return res;
		},
	});
	return res;
}

describe("unauthenticated requests", () => {
	it("redirects to auth start with return-to for /r/ path", async () => {
		const req = makeReq("/r/docs/readme.md");
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(302);
		const loc = res.headers.Location as string;
		expect(loc).toMatch(/^\/auth\/slack\/start\?r=/);
		const r = decodeURIComponent(new URL(loc, "http://localhost").searchParams.get("r") ?? "");
		expect(r).toBe("/r/docs/readme.md");
	});

	it("clears a bad cookie on redirect", async () => {
		const req = makeReq("/r/docs/readme.md", "invalid-cookie-value");
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(302);
		expect(res.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
	});
});

describe("authenticated requests — known file", () => {
	it("returns 200 with correct Content-Type for .md file", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/docs/readme.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
	});

	it("slides the cookie on 200 response", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/docs/readme.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["Set-Cookie"]).toBeTruthy();
		expect(typeof res.headers["Set-Cookie"]).toBe("string");
	});

	it("sets Content-Disposition: attachment for unknown binary extension", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/binary.bin", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers["Content-Type"]).toBe("application/octet-stream");
		expect(res.headers["Content-Disposition"]).toBe("attachment");
	});

	it("does NOT set Content-Disposition for text files", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/docs/readme.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.headers["Content-Disposition"]).toBeUndefined();
	});

	it("sets X-Robots-Tag on 200 response", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/docs/readme.md", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
	});
});

describe("authenticated requests — directory → 404", () => {
	it("returns 404 for a directory path", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/docs", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it("returns 404 for /r/ root (no index)", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it("returns 404 for /r (no trailing slash, no index)", async () => {
		const cookie = validCookie();
		const req = makeReq("/r", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});
});

describe("authenticated requests — denied path → 404", () => {
	it("returns 404 for credentials/ path", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/credentials/secret.txt", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});

	it("returns 404 for dotfile path", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/.env", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});
});

describe("authenticated requests — non-existent file → 404", () => {
	it("returns 404 for a file that does not exist", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/does/not/exist.txt", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});
});

describe("file size cap", () => {
	it("returns 404 for a file larger than 50 MB (sparse file)", async () => {
		// Create a sparse file that reports > 50 MB on stat without actually
		// consuming disk space. truncate() sets the file size via the OS
		// without writing data — stat.size will be 51 MB, isFile() is true.
		const { openSync, ftruncateSync, closeSync } = await import("fs");
		const bigPath = join(root, "big.bin");
		const fd = openSync(bigPath, "w");
		ftruncateSync(fd, 51 * 1024 * 1024);
		closeSync(fd);

		try {
			const cookie = validCookie();
			const req = makeReq("/r/big.bin", cookie);
			const res = makeRes();
			await handler(req, res);
			expect(res.statusCode).toBe(404);
		} finally {
			rmSync(bigPath, { force: true });
		}
	});
});

describe("/r/_search → 404", () => {
	it("returns 404 for _search", async () => {
		const cookie = validCookie();
		const req = makeReq("/r/_search", cookie);
		const res = makeRes();
		await handler(req, res);
		expect(res.statusCode).toBe(404);
	});
});

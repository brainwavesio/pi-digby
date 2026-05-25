/**
 * Wiki access control — path resolution + deny rules.
 *
 * Single source of truth for "is this URL path allowed to be served from /w/?".
 * Deny model is deliberately small: any path segment matching `.*` or
 * `credentials` is hidden. Everything else under `workingDir` is browseable.
 *
 * Used by both the request handler (to resolve incoming URLs to disk paths)
 * and the directory-listing renderer (to filter children).
 */
import { realpathSync } from "fs";
import { resolve, sep } from "path";

const DENY_SEGMENTS = new Set(["credentials"]);

/**
 * True if a single path segment must never appear in a wiki URL.
 *
 * Catches dotfiles (`.pi`, `.cache`, `.gitconfig`, `.bun`, `.npm`, `.env`,
 * etc.) and the explicit `credentials` deny.
 */
export function isDeniedSegment(name: string): boolean {
	if (name.length === 0) return true;
	if (name.startsWith(".")) return true;
	if (DENY_SEGMENTS.has(name)) return true;
	return false;
}

export type ResolveResult = { ok: true; absPath: string; relPath: string } | { ok: false };

/**
 * Resolve a URL path (e.g. "memory/tom.md") to an absolute on-disk path inside
 * `workingDir`, or return `{ ok: false }` if the path is denied or escapes
 * the root.
 *
 * Failure is intentionally opaque — the caller serves a 404 either way, so
 * the wiki never reveals whether a denied file exists.
 *
 * `urlPath` is the path portion after `/w/`, URL-decoded by the caller.
 * Empty string resolves to the root directory.
 */
export function resolveSafe(workingDir: string, urlPath: string): ResolveResult {
	// Normalise: strip leading/trailing slashes, decode happens upstream.
	const trimmed = urlPath.replace(/^\/+|\/+$/g, "");
	const segments = trimmed.length === 0 ? [] : trimmed.split("/");

	for (const seg of segments) {
		if (seg === "." || seg === "..") return { ok: false };
		if (isDeniedSegment(seg)) return { ok: false };
	}

	const rootReal = safeRealpath(workingDir);
	if (!rootReal) return { ok: false };

	const joined = segments.length === 0 ? rootReal : resolve(rootReal, ...segments);
	const absReal = safeRealpath(joined) ?? joined;

	// Symlink-escape guard: realpath must still live under the realpath of root.
	if (absReal !== rootReal && !absReal.startsWith(rootReal + sep)) {
		return { ok: false };
	}

	const relPath = absReal === rootReal ? "" : absReal.slice(rootReal.length + 1);
	return { ok: true, absPath: absReal, relPath };
}

function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
}

/**
 * MIME type helpers shared between the wiki handler and the raw-file handler.
 */

export function contentTypeFor(ext: string): string {
	switch (ext) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
		case ".mjs":
			return "application/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".md":
		case ".txt":
		case ".csv":
		case ".log":
		case ".diff":
		case ".patch":
		case ".ts":
		case ".tsx":
		case ".jsx":
		case ".py":
		case ".rb":
		case ".sh":
		case ".bash":
		case ".zsh":
		case ".fish":
		case ".toml":
		case ".ini":
		case ".conf":
		case ".yaml":
		case ".yml":
		case ".env":
		case ".sql":
			return "text/plain; charset=utf-8";
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".xml":
			return "text/xml; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".ico":
			return "image/x-icon";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

/** True when the type is unknown/binary — browsers should be prompted to download. */
export function needsAttachment(ext: string): boolean {
	return contentTypeFor(ext) === "application/octet-stream";
}

/**
 * True for file types that can execute active content (scripts, styles,
 * XML with XSLT, etc.) when rendered inline under the authenticated origin.
 *
 * The raw endpoint serves these with `Content-Security-Policy: sandbox`
 * to isolate them from the parent origin — cookies, localStorage, and
 * same-origin requests are all blocked inside the sandbox.
 *
 * `.html`/`.htm` get `sandbox allow-scripts allow-forms` so prototype pages
 * work (scripts run, forms submit) but the page cannot reach the auth cookie
 * or make credentialed requests back to the origin.
 *
 * `.svg`, `.xml`, `.js`/`.mjs`, `.css` get bare `sandbox` (no scripts) since
 * allowing scripts in those types would be unusual and unnecessary.
 */
export function scriptCapableCsp(ext: string): string | null {
	switch (ext) {
		case ".html":
		case ".htm":
			return "sandbox allow-scripts allow-forms allow-popups allow-modals";
		case ".svg":
		case ".xml":
		case ".js":
		case ".mjs":
		case ".css":
			return "sandbox";
		default:
			return null;
	}
}

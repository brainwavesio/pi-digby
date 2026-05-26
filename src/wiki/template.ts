/**
 * HTML shell for the wiki. One template, sentence case throughout.
 */

export type Crumb = { label: string; href?: string };

export type ShellOptions = {
	title: string;
	crumbs: Crumb[];
	meta?: string;
	bodyHtml: string;
	/** Current search query, if rendering a search page — populates the box. */
	searchQuery?: string;
};

export function renderShell(opts: ShellOptions): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(opts.title)} — Digby</title>
<link rel="stylesheet" href="/public/wiki.css">
</head>
<body>
<main class="wiki-shell">
<form class="wiki-search-bar" action="/w/_search" method="get" role="search">
<input type="search" name="q" placeholder="Search Digby's notes" autocomplete="off" maxlength="256" value="${escapeHtml(opts.searchQuery ?? "")}">
</form>
<nav class="wiki-crumb">${renderCrumbs(opts.crumbs)}</nav>
<h1 class="wiki-title">${escapeHtml(opts.title)}</h1>
${opts.meta ? `<div class="wiki-meta">${escapeHtml(opts.meta)}</div>` : ""}
<article class="wiki-content">
${opts.bodyHtml}
</article>
<footer class="wiki-foot">
<span>Digby wiki</span>
<a href="/auth/logout">Sign out</a>
</footer>
</main>
</body>
</html>`;
}

export function renderLoginPage(authorizeHref: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in — Digby</title>
<link rel="stylesheet" href="/public/wiki.css">
</head>
<body>
<main class="wiki-login">
<div>
<h1>Digby</h1>
<p>Sign in with Slack to browse Digby's notes.</p>
<a class="btn" href="${escapeHtml(authorizeHref)}">Sign in with Slack</a>
</div>
</main>
</body>
</html>`;
}

export function renderMissingBody(urlPath: string): string {
	return `<p class="wiki-missing">This page doesn't exist (yet).</p>
<p><code>${escapeHtml(urlPath)}</code></p>
<p><a href="/w/">← Back to the index</a></p>`;
}

/**
 * Build crumb objects for a `/w/` URL path. e.g.
 *   /w/memory/tom.md →
 *     [{label: 'digby', href: '/w/'},
 *      {label: 'memory', href: '/w/memory/'},
 *      {label: 'tom.md'}]
 */
export function buildCrumbs(urlPath: string, labelOverrides?: Record<string, string>): Crumb[] {
	const trimmed = urlPath.replace(/^\/+|\/+$/g, "");
	const parts = trimmed.length === 0 ? [] : trimmed.split("/");
	const crumbs: Crumb[] = [{ label: "digby", href: "/w/" }];
	let acc = "";
	for (let i = 0; i < parts.length; i++) {
		acc += `${parts[i]}/`;
		const isLast = i === parts.length - 1;
		const raw = parts[i];
		const label = labelOverrides?.[raw] ?? raw;
		crumbs.push(isLast ? { label } : { label, href: `/w/${acc}` });
	}
	return crumbs;
}

function renderCrumbs(crumbs: Crumb[]): string {
	return crumbs
		.map((c, i) => {
			const sep = i > 0 ? '<span class="sep"></span>' : "";
			const body = c.href ? `<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>` : escapeHtml(c.label);
			return `${sep}${body}`;
		})
		.join("");
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Directory listing for the wiki — reads a directory, filters denied entries,
 * and emits an HTML table. Channel IDs are resolved to `#name` via a caller-
 * supplied lookup (typically backed by SlackClient.getChannel).
 */
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { isDeniedSegment } from "./acl.js";
import { escapeHtml } from "./template.js";

export type ListingEntry = {
	name: string;
	displayLabel: string;
	href: string;
	isDir: boolean;
	size: number;
	mtimeMs: number;
};

export type ChannelNameLookup = (channelId: string) => string | undefined;

/**
 * Read `absDir` and produce a sorted, filtered list of entries.
 *
 * `urlDir` is the corresponding `/w/`-rooted URL path (with trailing slash,
 * or "" for the wiki root). `lookupChannel` is called for entries that look
 * like Slack channel IDs (`C…`, `D…`, or `G…` followed by 8+ alnums).
 */
export function listDirectory(absDir: string, urlDir: string, lookupChannel?: ChannelNameLookup): ListingEntry[] {
	let names: string[];
	try {
		names = readdirSync(absDir);
	} catch {
		return [];
	}

	const out: ListingEntry[] = [];
	for (const name of names) {
		if (isDeniedSegment(name)) continue;
		let s: ReturnType<typeof statSync>;
		try {
			s = statSync(join(absDir, name));
		} catch {
			continue;
		}
		const isDir = s.isDirectory();
		const isFile = s.isFile();
		if (!isDir && !isFile) continue; // skip sockets/symlinks-to-elsewhere/etc.

		const channelName = isDir && lookupChannel ? resolveChannelName(name, lookupChannel) : undefined;
		const displayLabel = channelName ?? name;
		const href = `/w/${urlDir}${encodeURIComponent(name)}${isDir ? "/" : ""}`;

		out.push({
			name,
			displayLabel,
			href,
			isDir,
			size: isFile ? s.size : 0,
			mtimeMs: s.mtimeMs,
		});
	}

	out.sort((a, b) => {
		// Directories first, then alpha (case-insensitive).
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.displayLabel.localeCompare(b.displayLabel, undefined, { sensitivity: "base" });
	});
	return out;
}

/**
 * If `name` looks like a Slack conversation ID, try to resolve it to a
 * human label like `#general`. Slack IDs start with C/D/G (channel, DM,
 * group DM) and are uppercase alnum.
 */
function resolveChannelName(name: string, lookup: ChannelNameLookup): string | undefined {
	if (!/^[CDG][A-Z0-9]{6,}$/.test(name)) return undefined;
	const ch = lookup(name);
	if (!ch) return undefined;
	return `#${ch}`;
}

export function renderListingBody(entries: ListingEntry[]): string {
	if (entries.length === 0) {
		return `<p class="wiki-missing">Empty.</p>`;
	}
	const rows = entries
		.map(
			(e) => `<tr>
<td><a class="${e.isDir ? "dir" : "file"}" href="${escapeHtml(e.href)}">${escapeHtml(e.displayLabel)}</a></td>
<td class="meta">${e.isDir ? "—" : formatSize(e.size)}</td>
<td class="meta">${formatDate(e.mtimeMs)}</td>
</tr>`,
		)
		.join("\n");
	return `<table class="wiki-listing">
<thead><tr><th>name</th><th>size</th><th>modified</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	return d.toISOString().slice(0, 10);
}

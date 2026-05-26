/**
 * Directory listing for the wiki.
 *
 * Two render modes:
 *   - renderListingBody (flat table)         — used inside any directory
 *   - renderRootListing (three sections)     — used at /w/ to surface
 *     curated notes above runtime artefacts (Slack channels/DMs, Linear
 *     workspaces). Same disk contents, just classified and grouped.
 *
 * Channel-shaped names (Slack conversation IDs like C012345, D012345,
 * G012345) are resolved to human labels via a caller-supplied lookup.
 * When the lookup misses (private channel the bot was removed from,
 * archived channel), the entry stays visible with an `(archived)`
 * suffix and a demoted style so it doesn't pretend the dir doesn't exist.
 */
import { readdirSync, statSync } from "fs";
import { isDeniedSegment, resolveSafe } from "./acl.js";
import { escapeHtml } from "./template.js";

export type ListingEntry = {
	name: string;
	displayLabel: string;
	href: string;
	isDir: boolean;
	size: number;
	mtimeMs: number;
	/** True if this is a channel/DM dir whose name lookup failed. */
	archived?: boolean;
};

export type ChannelNameLookup = (channelId: string) => string | undefined;

const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{6,}$/;
const LINEAR_DIR_PATTERN = /^linear:/;

/**
 * Read `absDir` and produce a sorted, filtered list of entries.
 *
 * `workingDir` is the wiki root; every child is run through resolveSafe so
 * symlink-escapes and root-escapes are excluded from listings (not just
 * from request-time path resolution).
 *
 * `urlDir` is the corresponding `/w/`-rooted URL path (with trailing slash,
 * or "" for the wiki root).
 */
export function listDirectory(
	workingDir: string,
	absDir: string,
	urlDir: string,
	lookupChannel?: ChannelNameLookup,
): ListingEntry[] {
	let names: string[];
	try {
		names = readdirSync(absDir);
	} catch {
		return [];
	}

	const out: ListingEntry[] = [];
	for (const name of names) {
		if (isDeniedSegment(name)) continue;

		// Run the full ACL on each child so a symlinked file pointing outside
		// the root never appears in a listing. The listing URL path (urlDir +
		// name) is the canonical form resolveSafe expects.
		const safe = resolveSafe(workingDir, `${urlDir}${name}`);
		if (!safe.ok) continue;

		let s: ReturnType<typeof statSync>;
		try {
			s = statSync(safe.absPath);
		} catch {
			continue;
		}
		const isDir = s.isDirectory();
		const isFile = s.isFile();
		if (!isDir && !isFile) continue; // skip sockets/devices/etc.

		const channelLookup = isDir && lookupChannel && CHANNEL_ID_PATTERN.test(name) ? lookupChannel(name) : undefined;
		const isChannelShaped = isDir && CHANNEL_ID_PATTERN.test(name);
		const archived = isChannelShaped && channelLookup === undefined;
		const displayLabel = channelLookup ? formatChannelLabel(channelLookup) : name;
		const href = `/w/${urlDir}${encodeURIComponent(name)}${isDir ? "/" : ""}`;

		out.push({
			name,
			displayLabel,
			href,
			isDir,
			size: isFile ? s.size : 0,
			mtimeMs: s.mtimeMs,
			archived: archived || undefined,
		});
	}

	out.sort(compareEntries);
	return out;
}

/** Slack DMs come back from the API as `DM:username`; channels as plain names. */
function formatChannelLabel(name: string): string {
	return name.startsWith("DM:") ? name : `#${name}`;
}

function compareEntries(a: ListingEntry, b: ListingEntry): number {
	// Directories first, then alpha (case-insensitive).
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	return a.displayLabel.localeCompare(b.displayLabel, undefined, { sensitivity: "base" });
}

/**
 * Bucket root entries into three groups for sectioned display.
 *
 *   notes     — everything that isn't channel- or linear-shaped (memory/,
 *               repos/, skills/, MEMORY.md, compliance/, *.md, …).
 *   channels  — directories matching the Slack conversation-id pattern.
 *   linear    — directories prefixed `linear:`.
 *
 * Files in the root always land in `notes`, regardless of name.
 */
export function partitionRootEntries(entries: ListingEntry[]): {
	notes: ListingEntry[];
	channels: ListingEntry[];
	linear: ListingEntry[];
} {
	const notes: ListingEntry[] = [];
	const channels: ListingEntry[] = [];
	const linear: ListingEntry[] = [];
	for (const e of entries) {
		if (e.isDir && CHANNEL_ID_PATTERN.test(e.name)) channels.push(e);
		else if (e.isDir && LINEAR_DIR_PATTERN.test(e.name)) linear.push(e);
		else notes.push(e);
	}
	return { notes, channels, linear };
}

export function renderListingBody(entries: ListingEntry[]): string {
	if (entries.length === 0) {
		return `<p class="wiki-missing">Empty.</p>`;
	}
	return renderTable(entries);
}

/**
 * Render the root listing as three labelled sections. Empty sections are
 * omitted; if everything is empty, falls back to the "Empty." line so the
 * page still has visible content.
 */
export function renderRootListing(entries: ListingEntry[]): string {
	const { notes, channels, linear } = partitionRootEntries(entries);
	const parts: string[] = [];
	if (notes.length > 0) parts.push(renderSection("Notes", notes));
	if (channels.length > 0) parts.push(renderSection("Channels", channels));
	if (linear.length > 0) parts.push(renderSection("Linear", linear));
	if (parts.length === 0) return `<p class="wiki-missing">Empty.</p>`;
	return parts.join("\n");
}

function renderSection(title: string, entries: ListingEntry[]): string {
	return `<section class="wiki-section">
<h2 class="wiki-section-title">${escapeHtml(title)}</h2>
${renderTable(entries)}
</section>`;
}

function renderTable(entries: ListingEntry[]): string {
	const rows = entries
		.map((e) => {
			const linkClass = e.isDir ? "dir" : "file";
			const archivedSuffix = e.archived ? ` <span class="archived-tag">(archived)</span>` : "";
			const rowClass = e.archived ? ' class="archived"' : "";
			return `<tr${rowClass}>
<td><a class="${linkClass}" href="${escapeHtml(e.href)}">${escapeHtml(e.displayLabel)}</a>${archivedSuffix}</td>
<td class="meta">${e.isDir ? "—" : formatSize(e.size)}</td>
<td class="meta">${formatDate(e.mtimeMs)}</td>
</tr>`;
		})
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

---
name: slack-canvas
description: Create and edit Slack Canvases — living documents that appear as channel tabs. Use for briefs, specs, plans, and collaborative docs.
---

# Slack Canvas

Create and edit living documents in Slack channels using the Canvases API. Canvases are native Slack documents — channel canvases appear as a tab visible to all channel members. We use these instead of Google Docs for collaborative work.

## When to Use

- User asks to "write up", "draft", "document", or "put together" something
- Collaborative documents: briefs, specs, plans, project docs, status pages
- Anything you'd previously put in a Google Doc

Don't use for ephemeral content — just post a message.

## Canvas Types

- **Channel canvas** — one per channel, appears as a channel tab. Default choice.
- **Standalone canvas** — independent document, shareable to multiple channels. Use when a channel needs multiple docs.

## Content Format

Markdown: headings (h1-h3), bold, italic, lists (bulleted, ordered, checklists), code blocks, tables (max 300 cells), links, dividers, blockquotes, emojis.

Mention syntax within canvas markdown:
- User: `![](@U123ABCDEFG)`
- Channel: `![](#C123ABC456)`

## API Access

Use `bun -e` with `@slack/web-api` (auto-installed by Bun on first run). Token is `$MOM_SLACK_BOT_TOKEN`.

```typescript
import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
const client = new WebClient(process.env.MOM_SLACK_BOT_TOKEN);
```

Write markdown to a scratch file first, then `readFileSync` it into the API call. This avoids shell escaping issues.

## Operations

### Create channel canvas

```typescript
const r = await client.apiCall("conversations.canvases.create", {
  channel_id: "CHANNEL_ID",
  document_content: { type: "markdown", markdown: readFileSync("scratch/doc.md", "utf-8") },
});
console.log(r.canvas_id); // e.g. "F0ABC123XYZ"
```

Returns `canvas_id`. Error `channel_canvas_already_exists` if one exists — update instead.

### Create standalone canvas

```typescript
const r = await client.apiCall("canvases.create", {
  title: "Document Title",
  document_content: { type: "markdown", markdown: readFileSync("scratch/doc.md", "utf-8") },
});
console.log(r.canvas_id);
```

Share to a channel:

```typescript
await client.apiCall("canvases.access.set", {
  canvas_id: "CANVAS_ID",
  access_level: "write", // or "read"
  channel_ids: ["CHANNEL_ID"],
});
```

### Replace entire canvas

```typescript
await client.apiCall("canvases.edit", {
  canvas_id: "CANVAS_ID",
  changes: [{
    operation: "replace",
    document_content: { type: "markdown", markdown: readFileSync("scratch/doc.md", "utf-8") },
  }],
});
```

### Edit a specific section

Look up the section ID first, then replace it:

```typescript
const lookup = await client.apiCall("canvases.sections.lookup", {
  canvas_id: "CANVAS_ID",
  criteria: { contains_text: "Heading Text" },
});
const sectionId = (lookup as any).sections[0].id;

await client.apiCall("canvases.edit", {
  canvas_id: "CANVAS_ID",
  changes: [{
    operation: "replace",
    section_id: sectionId,
    document_content: { type: "markdown", markdown: newSectionContent },
  }],
});
```

Section lookup criteria supports `section_types`: `h1`, `h2`, `h3`, `any_header`.

### Other edit operations

```typescript
// Append to end (no section_id needed)
{ operation: "insert_at_end", document_content: { type: "markdown", markdown: content } }

// Prepend to start
{ operation: "insert_at_start", document_content: { type: "markdown", markdown: content } }

// Insert before/after a section (requires section_id)
{ operation: "insert_after", section_id: "...", document_content: { ... } }

// Delete a section
{ operation: "delete", section_id: "..." }
```

### Delete a canvas

```typescript
await client.apiCall("canvases.delete", { canvas_id: "CANVAS_ID" });
```

Permanent and irreversible.

## Conventions

1. **Track canvas IDs in MEMORY.md** — after creating a canvas, record the `canvas_id`:
   ```
   ## Canvases
   - Channel canvas: F0ABC123XYZ (project brief)
   - Standalone: F0DEF456 (API spec)
   ```

2. **Keep a working copy** — write content to `scratch/` first, then publish to canvas. There is no API to read canvas content back as markdown, so your scratch file is the source of truth.

3. **Use headings for structure** — structure documents with h1/h2/h3. This enables targeted section edits via `canvases.sections.lookup` instead of full replacements.

4. **Channel canvas first** — default to channel canvas (tab in channel). Only use standalone when multiple docs are needed per channel.

5. **Handle existing canvases** — before creating, check MEMORY.md for an existing canvas_id. If `conversations.canvases.create` returns `channel_canvas_already_exists`, update the existing one.

6. **Cross-context (Linear)** — when working on a Linear project mapped to a Slack channel, read/update that channel's canvas. Note updates in your Linear activity so stakeholders know.

## Rate Limits

- Create: 20+/min (Tier 2)
- Edit, lookup, delete, access: 50+/min (Tier 3)

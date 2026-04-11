# Slack Canvas Skill — Brief for Digby

Create a global skill at `/data/skills/slack-canvas/` that lets you create, read, and edit Slack Canvases. Canvases are native living documents in Slack — they appear as a tab in a channel and are editable by both you and channel members. We're using these instead of Google Docs for collaborative document work.

## Prerequisites

The bot token (`$MOM_SLACK_BOT_TOKEN`) has `canvases:read` and `canvases:write` scopes. You already have access to it in your environment.

## What are Canvases?

Two types:

- **Channel canvas** — one per channel max. Appears as a tab in the channel. All channel members can see it. Created via `conversations.canvases.create`. If one already exists, the API returns error `channel_canvas_already_exists`.
- **Standalone canvas** — independent document. Can be shared to channels via `canvases.access.set`. Created via `canvases.create`. Use when a channel needs multiple documents.

Content format is **markdown**: h1-h3, bold, italic, bulleted/ordered/checklists, code blocks, tables (max 300 cells), links, dividers, quotes, user mentions (`![](@U123)`), channel mentions (`![](#C123)`).

## Slack API Methods

All methods: POST to `https://slack.com/api/<method>`, `Content-Type: application/json`, `Authorization: Bearer $MOM_SLACK_BOT_TOKEN`.

### conversations.canvases.create

Create a channel canvas (appears as channel tab).

```json
{
  "channel_id": "C123ABC",
  "document_content": { "type": "markdown", "markdown": "# Title\n\nContent" }
}
```

Returns `{ "ok": true, "canvas_id": "F0xxxxx" }`.

### canvases.create

Create a standalone canvas.

```json
{
  "title": "Document Title",
  "document_content": { "type": "markdown", "markdown": "# Title\n\nContent" }
}
```

Returns `{ "ok": true, "canvas_id": "F0xxxxx" }`.

### canvases.edit

Edit canvas content. Accepts a `changes` array with one or more operations.

```json
{
  "canvas_id": "F0xxxxx",
  "changes": [
    {
      "operation": "replace",
      "document_content": { "type": "markdown", "markdown": "# New content" }
    }
  ]
}
```

Operations:

| Operation | section_id required? | Description |
|-----------|---------------------|-------------|
| `replace` | No = replace entire canvas | Full content replacement |
| `replace` | Yes = replace that section | Targeted section replacement |
| `insert_at_start` | No | Add content at beginning |
| `insert_at_end` | No | Append content |
| `insert_before` | Yes | Insert before a section |
| `insert_after` | Yes | Insert after a section |
| `delete` | Yes | Remove a section |

### canvases.sections.lookup

Find section IDs for targeted edits.

```json
{
  "canvas_id": "F0xxxxx",
  "criteria": { "section_types": ["any_header"], "contains_text": "Section Name" }
}
```

Section types: `h1`, `h2`, `h3`, `any_header`. Returns array of `{ "id": "temp:xxx:xxx" }`.

### canvases.delete

```json
{ "canvas_id": "F0xxxxx" }
```

Permanent and irreversible.

### canvases.access.set

Share a standalone canvas with channels or users.

```json
{
  "canvas_id": "F0xxxxx",
  "access_level": "write",
  "channel_ids": ["C123ABC"]
}
```

Access levels: `read`, `write`. Not needed for channel canvases (access follows channel membership).

## Rate Limits

- Create: Tier 2 (20+/min)
- Edit, sections lookup, delete, access: Tier 3 (50+/min)

## What to Build

### 1. Helper script: `canvas.sh`

A bash script using `curl` and `jq` that wraps the API. Should accept subcommands and read markdown content from a file path (so you write content to a scratch file first, then pass the path).

Subcommands:

```bash
# Create a channel canvas (returns canvas_id)
{baseDir}/canvas.sh create-channel <channel_id> <markdown_file>

# Create a standalone canvas (returns canvas_id)
{baseDir}/canvas.sh create <title> <markdown_file>

# Replace entire canvas content
{baseDir}/canvas.sh replace <canvas_id> <markdown_file>

# Edit a specific section by heading text
{baseDir}/canvas.sh edit-section <canvas_id> <heading_text> <markdown_file>

# Append content to end
{baseDir}/canvas.sh append <canvas_id> <markdown_file>

# List sections (headings and their IDs)
{baseDir}/canvas.sh sections <canvas_id>

# Delete a canvas
{baseDir}/canvas.sh delete <canvas_id>
```

The script should:
- Use `$MOM_SLACK_BOT_TOKEN` from environment
- Read markdown content from the file path argument
- Output the canvas_id on create operations
- Show clear error messages from the Slack API on failure
- Handle the JSON escaping of markdown content properly (use jq to build the JSON payload so newlines/quotes are escaped correctly)

### 2. Skill definition: `SKILL.md`

```markdown
---
name: slack-canvas
description: Create and edit Slack Canvases — living documents in channels. Use for briefs, specs, plans, and other collaborative documents.
---

# Slack Canvas

(instructions for yourself on when and how to use the canvas skill)
```

The SKILL.md should cover:

**When to use:**
- Collaborative documents: briefs, specs, plans, project docs, meeting notes
- Anything you'd previously have put in a Google Doc
- When the user asks you to "write up", "draft", "document", or "put together" something

**When NOT to use:**
- Ephemeral content (just post a message)
- Tiny one-off responses

**Workflow:**
1. Write content to a scratch file in the channel's `scratch/` directory
2. Call the helper script
3. Record the `canvas_id` in channel MEMORY.md so you remember it next time
4. For updates, check MEMORY.md for existing canvas_id, then use replace or edit-section

**Channel canvas vs standalone:**
- Default to channel canvas (one per channel, appears as tab) for the primary working document
- Use standalone canvases when a channel needs multiple documents
- If `create-channel` returns `channel_canvas_already_exists`, check MEMORY.md for the existing canvas_id and update it instead

**Cross-context (Linear):**
- When working on a Linear project that maps to a Slack channel, you can read/update the channel's canvas
- Mention canvas updates in Linear activity so stakeholders know the doc was updated
- Use MEMORY.md to track which Linear projects map to which Slack channels

**Content tips:**
- Use proper markdown headings (# h1, ## h2, ### h3) to structure documents — this enables surgical section editing later
- Keep a consistent structure so edit-section works reliably
- Tables are supported (max 300 cells)
- You can @mention users with `![](@U123USERID)` syntax in the markdown

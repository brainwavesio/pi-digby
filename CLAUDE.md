# CLAUDE.md

Fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) for the Brainwaves deployment of pi-mom (Slack bot). Upstream rules in [AGENTS.md](AGENTS.md) still apply.

## What this fork adds

- `deploy/` — Cloudflare Container deployment (Durable Object + Docker)
- `entrypoint.sh` — seeds persistent MCP config, substitutes env vars, starts mom
- `.pi/mcp.json` — default MCP server config (copied to `/data/.pi/mcp.json` on first boot)
- MCP support via `pi-mcp-adapter` loaded as an extension factory in `packages/mom/src/agent.ts`

## Architecture

```
Cloudflare Worker (deploy/src/index.ts)
  └─ Durable Object (PiMomContainer)
       └─ Docker container (Dockerfile)
            ├─ /app         — built monorepo (ephemeral)
            ├─ /data        — persistent volume (workspace, logs, config)
            └─ entrypoint.sh → node packages/mom/dist/main.js --sandbox=host /data
```

- The bot uses **Amazon Bedrock** (Claude Sonnet) as its LLM provider
- Slack communication via Socket Mode (no public endpoint needed)
- Container auto-restarts via cron trigger every 5 minutes

## Key paths in container

| Path | Persistent | Purpose |
|------|-----------|---------|
| `/app` | No | Built monorepo, wiped on redeploy |
| `/data` | Yes | Workspace: channel dirs, logs, memory, skills, events |
| `/data/.pi/mcp.json` | Yes | MCP server config (agent can edit, survives redeploys) |
| `/app/.pi/mcp.json` | Symlink | Points to `/data/.pi/mcp.json` at runtime |

## Commands

```bash
npm install          # install deps
npm run build        # build all packages
npm run check        # lint + typecheck (run after code changes, before committing)
```

Per AGENTS.md: never run `npm run dev`, `npm run build`, or `npm test` yourself. Use `npm run check` to validate.

## Deploy

Push to `main` triggers `.github/workflows/deploy.yml` → builds Docker image → deploys to Cloudflare.

Control panel: `https://pi-digby.<account>.workers.dev/` (start, stop, restart, status).

### Secrets (set via `wrangler secret put` from `deploy/`)

| Secret | Purpose |
|--------|---------|
| `MOM_SLACK_APP_TOKEN` | Slack app-level token (Socket Mode) |
| `MOM_SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `AWS_ACCESS_KEY_ID` | Bedrock credentials |
| `AWS_SECRET_ACCESS_KEY` | Bedrock credentials |
| `BROWSER_USE_API_KEY` | browser-use CLI (cloud mode) |
| `EXA_API_KEY` | Exa search MCP server |

## MCP setup

MCP servers are configured in `.pi/mcp.json` (repo default) and persisted at `/data/.pi/mcp.json` in the container. The agent can edit the persistent copy at runtime.

The `pi-mcp-adapter` extension is loaded via `extensionFactories` in `packages/mom/src/agent.ts` (dynamic import to avoid tsgo type-checking the `.ts` source files). No package manager resolution needed — it's a direct npm dependency.

`entrypoint.sh` handles env var substitution in URLs (the adapter only interpolates `${VAR}` in headers, not URLs).

## Upstream sync

```bash
git fetch upstream
git merge upstream/main
```

Resolve conflicts in `packages/mom/` and `deploy/` carefully — those are the fork-specific files.

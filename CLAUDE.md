# CLAUDE.md

pi-digby — Slack bot for Brainwaves, powered by pi-agent-core + Amazon Bedrock.

## Architecture

```
AWS ECS Fargate
  └─ Docker container
       ├─ /app         — built app (ephemeral)
       ├─ /data        — EFS-backed persistent storage
       └─ entrypoint.sh → node dist/main.js /data
```

- LLM: **Amazon Bedrock** (Claude Sonnet 4.6)
- Slack: Socket Mode (no public endpoint)
- Persistence: EFS at `/data` (channel dirs, logs, memory, skills, events)
- MCP: `pi-mcp-adapter` loaded via `extensionFactories` in `src/agent/setup.ts`

## Commands

```bash
npm install          # install deps
npm run check        # lint + typecheck (biome + tsgo)
npm run build        # compile to dist/
```

Use `npm run check` to validate changes before committing. The pre-commit hook runs this automatically.

## Key paths

| Path | Purpose |
|------|---------|
| `src/` | Harness source code |
| `src/main.ts` | Entry point |
| `src/slack/` | Slack client (retry), event router |
| `src/channel/` | Per-channel queue, RunContext (guaranteed resolve), state |
| `src/agent/` | Agent setup, event handler, system prompt, skills |
| `src/tools/` | bash, read, write, edit, attach, react |
| `src/persistence/` | log.jsonl sync, context.jsonl, MEMORY.md |
| `src/events/` | Scheduled/periodic event watcher |
| `deploy/` | AWS CloudFormation + ECS task definition |
| `docs/` | Migration plan, harness design docs |
| `.pi/mcp.json` | Default MCP server config |

## Deploy

Push to `main` triggers `.github/workflows/deploy.yml` → builds Docker image → ECR → ECS service update.

## Secrets (AWS Secrets Manager)

| Secret | Purpose |
|--------|---------|
| `MOM_SLACK_APP_TOKEN` | Slack app-level token (Socket Mode) |
| `MOM_SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `AWS_ACCESS_KEY_ID` | Bedrock credentials |
| `AWS_SECRET_ACCESS_KEY` | Bedrock credentials |
| `BROWSER_USE_API_KEY` | browser-use CLI (cloud mode) |
| `EXA_API_KEY` | Exa search MCP server |

## Upstream dependencies

Consumed as npm packages (not local sources):
- `@mariozechner/pi-agent-core` — Agent class, tool execution loop
- `@mariozechner/pi-ai` — Bedrock streaming provider
- `@mariozechner/pi-coding-agent` — AgentSession, SessionManager, convertToLlm
- `pi-mcp-adapter` — MCP server integration

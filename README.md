# pi-digby

A self-hosted AI agent that lives in your Slack workspace, powered by [Claude](https://www.anthropic.com/claude) via Amazon Bedrock. Digby responds to mentions, maintains persistent memory across conversations, can read and edit files, run shell commands, search the web via MCP, and trigger on a schedule — all from your existing Slack setup with no public endpoints required.

## What it does

- **Slack bot via Socket Mode** — no public endpoint needed; connects outbound over WebSocket
- **Persistent memory** — maintains `MEMORY.md` and per-channel `log.jsonl` / `context.jsonl` on an EFS volume that survives container restarts
- **File system tools** — read, write, edit, and attach files inside the working directory
- **Shell access** — runs bash commands, installs packages, executes scripts
- **MCP integrations** — plug in any MCP server (Linear, Exa search, and more) via `.pi/mcp.json`
- **Linear integration** — optional webhook-driven agent that comments on Linear issues
- **Scheduled events** — trigger the bot on a cron schedule via files in `events/`
- **Wiki knowledge base** — optional read-only web UI for browsing the working directory as a wiki (requires Slack OAuth config)

## Architecture

```
Slack (Socket Mode)
  └─ pi-digby (Node.js, AWS ECS Fargate)
       ├─ src/slack/router.ts    — event classification and routing
       ├─ src/agent/setup.ts     — AgentSession, tools, MCP runtime
       ├─ src/persistence/       — log.jsonl, context.jsonl, MEMORY.md
       ├─ src/events/            — scheduled event watcher
       └─ /data (AWS EFS)        — persistent storage across deploys
```

pi-digby is a single Node process. Each Slack channel runs in its own "lane" with a FIFO queue; threads get separate agent session directories. The LLM is Claude Sonnet (via Amazon Bedrock) with tool use. MCP servers are loaded at startup from `.pi/mcp.json` in the working directory.

## Prerequisites

- **Node.js 20+** (or use the provided Docker image)
- **AWS account** with Amazon Bedrock enabled and Claude Sonnet access in `us-east-1`
- **Slack app** with Socket Mode enabled and the following bot scopes:
  - `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`
  - `chat:write`, `files:read`, `files:write`, `reactions:write`, `users:read`
- **GitHub repository** forked from this one (for the GitHub Actions deploy pipeline)

## Quick start

### 1. Fork and configure GitHub Actions

Fork this repository, then add the following **Actions variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Description |
|----------|-------------|
| `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |

The deploy workflow uses OIDC to authenticate with AWS. You will need to create an IAM role that trusts your GitHub repository — see `docs/deployment.md` for the full CloudFormation template that provisions this and all other infrastructure.

### 2. Deploy infrastructure

```bash
aws cloudformation deploy \
  --profile YOUR_AWS_PROFILE \
  --region us-east-1 \
  --stack-name pi-digby \
  --template-file deploy/cloudformation.yml \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

This creates: VPC, ECS Fargate cluster/service, EFS volume, ECR repository, IAM roles, Secrets Manager secret, and CloudWatch log group.

### 3. Set secrets in AWS Secrets Manager

```bash
aws secretsmanager put-secret-value \
  --profile YOUR_AWS_PROFILE \
  --region us-east-1 \
  --secret-id pi-digby/env \
  --secret-string '{
    "DIGBY_SLACK_APP_TOKEN": "xapp-...",
    "DIGBY_SLACK_BOT_TOKEN": "xoxb-...",
    "EXA_API_KEY": "...",
    "GH_TOKEN": "..."
  }'
```

See the full secrets table below for all available keys.

### 4. Push to main

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the Docker image, pushes it to ECR, and updates the ECS service.

### 5. Invite the bot to Slack channels

Invite `@digby` to any channel you want it to monitor. Mention it to trigger a response.

## Environment variables / secrets

All secrets are stored in AWS Secrets Manager as `pi-digby/env` (JSON). The ECS task reads them at startup.

| Key | Required | Description |
|-----|----------|-------------|
| `DIGBY_SLACK_APP_TOKEN` | Yes | Slack app-level token (`xapp-…`) for Socket Mode |
| `DIGBY_SLACK_BOT_TOKEN` | Yes | Slack bot OAuth token (`xoxb-…`) |
| `EXA_API_KEY` | No | [Exa](https://exa.ai) search API key (for the Exa MCP server) |
| `GH_TOKEN` | No | GitHub personal access token (for GitHub operations) |
| `BROWSER_USE_API_KEY` | No | [browser-use](https://browser-use.com) cloud API key |
| `DD_API_KEY` | No | Datadog API key |
| `DD_APP_KEY` | No | Datadog application key |
| `LINEAR_API_KEY` | No | Linear API key (enables Linear agent) |
| `LINEAR_WEBHOOK_SECRET` | No | Linear webhook secret (enables Linear agent) |
| `DIGBY_COOKIE_SECRET` | No | 32-byte hex secret for wiki session cookies (`openssl rand -hex 32`) |
| `DIGBY_SLACK_CLIENT_ID` | No | Slack OAuth client ID (enables wiki sign-in) |
| `DIGBY_SLACK_CLIENT_SECRET` | No | Slack OAuth client secret (enables wiki sign-in) |
| `DIGBY_SLACK_TEAM_ID` | No | Slack workspace ID (`T…`) — wiki ACL |
| `DIGBY_WIKI_BASE_URL` | No | Public URL of the wiki (e.g. `https://digby.example.com`) |

> **Note:** Bedrock authentication uses the ECS task IAM role — no `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` needed for the bot itself.

## MCP servers

Configure MCP servers in `.pi/mcp.json` inside your working directory (`/data` on EFS). Example:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://your-mcp-server.example.com/mcp",
      "auth": "oauth"
    }
  }
}
```

The repo ships with Linear and Exa MCP servers pre-configured as examples.

## Local development

```bash
npm install
npm run check    # lint + typecheck
npm run build    # compile to dist/
npm test         # run tests
```

To run the bot locally, set `DIGBY_SLACK_APP_TOKEN` and `DIGBY_SLACK_BOT_TOKEN` in your environment and point it at a local working directory:

```bash
node dist/main.js /path/to/working-dir
```

## Documentation

- [`docs/deployment.md`](docs/deployment.md) — full deployment guide, manual operations, secrets management
- [`docs/architecture.md`](docs/architecture.md) — runtime model, lanes, message history vs agent context
- [`docs/aws-migration.md`](docs/aws-migration.md) — infrastructure design decisions

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (coming soon). PRs welcome. Please open an issue first for significant changes.

## License

MIT — see [LICENSE](LICENSE).

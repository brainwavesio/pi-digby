# Contributing to pi-digby

Bug reports, feature requests, and pull requests are welcome. For significant changes, please open an issue first so we can talk it through before you invest the time.

## Toolchain

- **Node.js 20+** and **npm**
- **Docker** — only if you're working on the container image

## Setup

```bash
git clone https://github.com/brainwavesio/pi-digby.git
cd pi-digby
npm install
```

## Development loop

```bash
npm run check    # Biome lint + typecheck — the pre-commit hook runs this too
npm run build    # compile to dist/ (includes the wiki's static assets)
npm test         # vitest
```

To run the bot locally you need the two Slack tokens (see the README [Quick start](README.md#quick-start) for creating the app) and ambient AWS credentials with Bedrock access (`bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` in `us-east-1`):

```bash
npm run build
DIGBY_SLACK_APP_TOKEN=xapp-... \
DIGBY_SLACK_BOT_TOKEN=xoxb-... \
node dist/main.js /path/to/working-dir
```

The working directory can be any empty directory — it plays the role of `/data` in production: channel logs, memory, and MCP config all live there.

## Tests

Tests live in [`test/`](test/) and run with vitest. If you change behaviour, add or update a test that fails without your change — tests here should capture *why* the behaviour matters, not just restate the implementation.

## Pull requests

- Branch from `main`; branch names follow `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `revert:`).
- Keep the diff focused — no unrelated cleanup bundled in.
- PRs are squash-merged, so the PR title becomes the commit message: write it like one.
- `npm run check` and `npm test` must pass.

## Security

If you find a security issue, please follow [SECURITY.md](SECURITY.md) rather than opening a public issue. It's worth reading the README's [Security model](README.md#security-model) first — digby is deliberately agentic, so some things that look like vulnerabilities are documented design decisions.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

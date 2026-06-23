# Contributing to Digby

Digby is an open-source Slack ops agent built on the pi-agent-core runtime and Amazon Bedrock. We welcome bug reports, feature requests, and pull requests from the community.

## Prerequisites

- **Node.js** 20+
- **Bun** (used as the package manager and test runner)
- **Docker** (for local container builds)
- **AWS CLI** (for deploy operations)

## Getting started

```bash
git clone https://github.com/brainwavesio/pi-digby.git
cd pi-digby
cp .env.example .env          # fill in your Slack and AWS credentials
bun install
bun run dev
```

## Code style

We use [Biome](https://biomejs.dev/) for linting and formatting. Before opening a PR, make sure your changes pass:

```bash
bun run lint      # lint check
bun run format    # auto-format
```

PRs that fail lint will not be merged.

## Branch naming

| Type | Pattern |
|------|---------|
| New feature | `feat/<slug>` |
| Bug fix | `fix/<slug>` |
| Maintenance / chore | `chore/<slug>` |

## PR process

1. Fork the repository and create your branch from `main`.
2. Make your changes on a branch following the naming convention above.
3. Open a pull request against `main`.
4. One approval from a maintainer is required before merging.
5. PRs are merged with **squash merge** to keep the history clean.

## Testing

```bash
bun test
```

Unit tests live alongside the source files in `src/**/*.test.ts`. Please add or update tests for any logic you change.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add support for scheduled reminders
fix: handle empty message payloads in router
chore: upgrade biome to 1.9
docs: update deployment guide
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.

## What makes a good issue

- A clear, descriptive title.
- Steps to reproduce (for bugs) or a concrete problem statement (for features).
- Relevant logs, screenshots, or error messages.
- Environment details: OS, Node version, deployment type (ECS / local).

## What makes a good PR

- A concise summary of **what** changed and **why**.
- Tests covering the new or fixed behaviour.
- No unrelated cleanup bundled in — keep the diff focused.
- Screenshots or log excerpts where the change has a visible effect.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

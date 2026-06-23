# Security Policy

## Secrets and credentials

pi-digby does not store secrets in GitHub Actions secrets or environment variables baked into the image. All runtime secrets (Slack tokens, API keys) are injected at container startup via **AWS Secrets Manager** (`pi-digby/env`). The ECS task role grants read access to that secret; no credentials are embedded in the repository or Docker image.

If you find a secret or credential committed to this repository, please report it privately using the contact below so it can be rotated immediately.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report security issues privately to: **security@brain-waves.io**

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

We aim to acknowledge reports within 2 business days and provide a fix or mitigation within 14 days for critical issues.

## Scope

- The pi-digby harness source code in this repository
- The CloudFormation infrastructure template (`deploy/cloudformation.yml`)
- The GitHub Actions workflows (`.github/workflows/`)

Out of scope: third-party dependencies (report those to their respective maintainers).

## For contributors

- Never commit secrets, tokens, or credentials to this repository
- Never use `pull_request_target` in GitHub Actions workflows (it runs in privileged context and can expose secrets to fork PRs)
- The `deploy.yml` workflow only runs on direct pushes to `main` — never on PRs

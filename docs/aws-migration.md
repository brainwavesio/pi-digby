# AWS ECS Fargate Migration Plan

Migration from Cloudflare Workers Containers to AWS ECS Fargate for the pi-digby Slack bot.

## Motivation

Cloudflare Containers has intermittent capacity issues — deploys fail with no useful error when containers aren't available, requiring manual retries. This is a platform limitation, not a bug in our code. ECS Fargate provides guaranteed capacity, native persistent storage, and built-in restart/health management.

## Architecture

```
GitHub Actions (on push to main)
  ├─ Build Docker image → ECR
  └─ Update ECS Service (force new deployment)

VPC (us-east-1, 2 public subnets)
  └─ ECS Fargate Service
       ├─ Task: 0.5 vCPU / 1 GB RAM
       ├─ EFS mount at /data
       ├─ Secrets from AWS Secrets Manager
       ├─ CloudWatch Logs
       ├─ Health check HTTP server (:8080/health)
       └─ desired_count=1, restartPolicy=on-failure
  └─ EFS File System
       └─ Access Point → /data (uid=0, gid=0)

ECR Repository
  └─ pi-digby (Docker images, lifecycle policy: keep last 10)
```

## Cost estimate

| Resource | Estimate |
|----------|----------|
| Fargate (0.5 vCPU + 1 GB, always-on) | ~$18/mo |
| EFS (infrequent access, <1 GB) | ~$0.50/mo |
| ECR (image storage) | ~$0.50/mo |
| CloudWatch Logs | ~$1/mo |
| **Total** | **~$20/mo** |

Covered by AWS credits.

## What changes

### Dockerfile

Remove Cloudflare-specific tooling, add health check server:

```diff
- # tigrisfs — R2 FUSE mount
- RUN ...tigrisfs install...
- # cloudflared
- RUN ...cloudflared install...
- # fuse
- apt-get install ... fuse ...
+ HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
+   CMD curl -f http://localhost:8080/health || exit 1
```

### entrypoint.sh

Remove R2 FUSE mount logic — EFS is pre-mounted by ECS at `/data`:

```diff
- # Mount R2 bucket
- if [ -n "$R2_ACCOUNT_ID" ] && [ -n "$R2_BUCKET_NAME" ]; then
-   ...tigrisfs mount logic...
- fi
+ # /data is pre-mounted by ECS via EFS — no mount logic needed
```

Add health check server (lightweight Bun HTTP server):

```diff
+ # Start health check server (ECS container health check)
+ bun -e "Bun.serve({port:8080,fetch:()=>new Response('ok')})" &
```

The rest of entrypoint.sh stays the same: symlinks, MCP config seeding, QMD setup, `exec node packages/mom/dist/main.js --sandbox=host /data`.

### deploy/ directory

**Replace entirely.** Remove:

- `deploy/src/index.ts` — Cloudflare Worker / Durable Object / control panel
- `deploy/wrangler.toml` — Cloudflare config
- `deploy/package.json` / `deploy/tsconfig.json` — wrangler deps

Add:

- `deploy/cloudformation.yml` — full infrastructure stack (VPC, ECS, EFS, ECR, IAM, Secrets Manager)
- `deploy/task-definition.json` — ECS task definition template (referenced by GitHub Actions)

### .github/workflows/deploy.yml

Replace wrangler deploy with ECR push + ECS service update:

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Configure AWS credentials
    uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/pi-digby-github-deploy
      aws-region: us-east-1

  - name: Login to ECR
    uses: aws-actions/amazon-ecr-login@v2

  - name: Build and push Docker image
    uses: docker/build-push-action@v6
    with:
      context: .
      push: true
      tags: |
        ${{ steps.ecr.outputs.registry }}/pi-digby:${{ github.sha }}
        ${{ steps.ecr.outputs.registry }}/pi-digby:latest
      cache-from: type=gha
      cache-to: type=gha,mode=max

  - name: Deploy to ECS
    run: |
      aws ecs update-service \
        --cluster pi-digby \
        --service pi-digby \
        --force-new-deployment
```

ECS handles the rolling update: starts new task, health-checks it, drains the old one.

## Infrastructure (CloudFormation)

Single stack `pi-digby` in us-east-1. Resources:

### Networking

- **VPC**: 10.0.0.0/16, DNS enabled
- **2 public subnets**: 10.0.1.0/24, 10.0.2.0/24 (us-east-1a, us-east-1b)
- **Internet gateway** + route table
- **Security group**: egress all, ingress none (bot uses outbound Socket Mode only; health check is internal)

No NAT gateway needed — Fargate tasks in public subnets with auto-assign public IP get direct internet access.

### Storage

- **EFS file system**: encrypted at rest, infrequent access storage class
- **EFS access point**: path `/data`, owner uid/gid 0 (root, matches container)
- **Mount targets**: one per subnet

### Compute

- **ECS cluster**: `pi-digby`, Fargate capacity provider
- **Task definition**:
  - 0.5 vCPU, 1024 MB memory
  - Container `pi-digby` from ECR
  - EFS volume mounted at `/data`
  - Health check: `curl -f http://localhost:8080/health`
  - Logging: CloudWatch log group `/ecs/pi-digby`
  - Secrets injected from Secrets Manager
- **ECS service**:
  - desired_count=1
  - deployment: min 0%, max 100% (replace strategy — only one bot instance at a time to avoid duplicate Slack responses)
  - restart on failure

### Secrets

Migrate from `wrangler secret` to AWS Secrets Manager, one secret `pi-digby/env` with JSON keys:

| Key | Purpose |
|-----|---------|
| `MOM_SLACK_APP_TOKEN` | Slack Socket Mode |
| `MOM_SLACK_BOT_TOKEN` | Slack Bot OAuth |
| `AWS_ACCESS_KEY_ID` | Bedrock credentials |
| `AWS_SECRET_ACCESS_KEY` | Bedrock credentials |
| `BROWSER_USE_API_KEY` | browser-use cloud |
| `EXA_API_KEY` | Exa search MCP |
| `GH_TOKEN` | GitHub API |
| `DD_API_KEY` | Datadog |
| `DD_APP_KEY` | Datadog |

Note: `R2_*` vars are no longer needed (EFS replaces R2).

### IAM

- **Task execution role**: pull from ECR, read Secrets Manager, write CloudWatch Logs
- **Task role**: Bedrock invoke access (the container's own AWS identity)
- **GitHub deploy role**: OIDC trust for `brainwavesio/pi-digby` repo, permissions to push ECR + update ECS service

### Container image

- **ECR repository**: `pi-digby`, lifecycle policy keeps last 10 images

## Health check server

Minimal Bun HTTP server started in entrypoint.sh before the bot process:

```js
Bun.serve({ port: 8080, fetch: () => new Response("ok") })
```

ECS container health check hits `http://localhost:8080/health` every 30s. Three consecutive failures trigger task restart. This replaces the entire Cloudflare Durable Object health check / cron / keepAlive / ghost detection system.

Future option: the health check server could expose `/status` with process info (uptime, memory, etc.) for operational visibility, but not needed for v1.

## Data migration

One-time process, ~10 min downtime.

### Prerequisites

- ECS infrastructure deployed (CloudFormation stack created)
- EFS file system mounted and accessible
- Cloudflare bot still running (to verify data is current)

### Steps

1. **Stop the Cloudflare bot** — prevent writes during migration
   ```bash
   curl https://pi-digby.<account>.workers.dev/stop
   ```

2. **Run migration task** — temporary ECS task that syncs R2 → EFS
   ```bash
   # Using rclone in a one-off ECS task with EFS mounted
   rclone sync :s3:pi-digby-data /data \
     --s3-provider=Cloudflare \
     --s3-endpoint=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
     --s3-access-key-id=$R2_ACCESS_KEY_ID \
     --s3-secret-access-key=$R2_SECRET_ACCESS_KEY \
     --progress
   ```

3. **Verify data integrity**
   ```bash
   # Check key paths exist
   ls -la /data/.pi/mcp.json
   ls -la /data/MEMORY.md
   ls -la /data/*/log.jsonl
   ```

4. **Start the ECS bot** — update service desired count to 1
   ```bash
   aws ecs update-service --cluster pi-digby --service pi-digby --desired-count 1
   ```

5. **Verify bot is running** — check Slack for responsiveness

6. **Decommission Cloudflare** — once confirmed stable (after a few days):
   - Delete the Cloudflare Worker (`wrangler delete`)
   - Keep R2 bucket as backup for 30 days, then delete

## Implementation order

### Phase 1: Infrastructure

1. Write CloudFormation template (`deploy/cloudformation.yml`)
2. Write ECS task definition (`deploy/task-definition.json`)
3. Deploy stack: `aws cloudformation deploy --stack-name pi-digby --template-file deploy/cloudformation.yml --capabilities CAPABILITY_IAM`
4. Create secrets in Secrets Manager
5. Push initial Docker image to ECR

### Phase 2: App changes

1. Remove tigrisfs, fuse, cloudflared from Dockerfile
2. Remove R2 mount logic from entrypoint.sh
3. Add health check server to entrypoint.sh
4. Remove `R2_*` env var references
5. Test locally with Docker (mount a local dir at /data)

### Phase 3: CI/CD

1. Write new GitHub Actions workflow
2. Set up OIDC trust between GitHub and AWS
3. Test deploy pipeline end-to-end (with ECS service at desired_count=0)

### Phase 4: Migration

1. Stop Cloudflare bot
2. Run rclone migration task
3. Verify data
4. Set ECS desired_count=1
5. Verify bot in Slack

### Phase 5: Cleanup

1. Monitor for 48h
2. Delete Cloudflare Worker
3. Remove old `deploy/src/index.ts`, `wrangler.toml` from repo
4. Keep R2 bucket 30 days as backup, then delete

## Rollback plan

If the ECS deployment has issues:

1. Set ECS desired_count=0
2. Restart the Cloudflare bot: `curl https://pi-digby.<account>.workers.dev/start`
3. Data written to EFS during the ECS run would need to be synced back to R2 (reverse rclone)

The Cloudflare deployment stays intact until Phase 5, so rollback is always available.

## Files to create/modify

| File | Action |
|------|--------|
| `deploy/cloudformation.yml` | **Create** — full infrastructure stack |
| `deploy/task-definition.json` | **Create** — ECS task definition |
| `.github/workflows/deploy.yml` | **Rewrite** — ECR + ECS pipeline |
| `Dockerfile` | **Modify** — remove CF tooling, add healthcheck |
| `entrypoint.sh` | **Modify** — remove R2 mount, add health server |
| `deploy/src/index.ts` | **Delete** (Phase 5) |
| `deploy/wrangler.toml` | **Delete** (Phase 5) |
| `deploy/package.json` | **Rewrite** — remove wrangler deps (Phase 5) |

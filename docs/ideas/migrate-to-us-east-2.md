# Migrate pi-digby from us-east-1 to us-east-2

## Context

pi-digby currently runs in `us-east-1`, which is the oldest, busiest, and historically most outage-prone AWS region. Moving to `us-east-2` (Ohio) gives us:

- Better regional stability with similar latency to Slack/Linear (both operate nationally, no meaningful RTT difference)
- Slightly lower Fargate cost
- Alignment with the Datadog AWS integration (which will be deployed to us-east-2)

**Model compatibility**: `src/agent/setup.ts:46` uses `us.anthropic.claude-sonnet-4-6` — the `us.` prefix is a cross-region inference profile that routes across all major US regions. No code change needed for Bedrock access.

**Data migration**: The EFS volume at `/data` contains channel logs, memory, skills, and the agent session state (`context.jsonl`). This is the primary migration concern — EFS is regional, so we need to replicate the data before cutover.

## Approach

Use **AWS Backup cross-region copy** to replicate the existing daily EFS backup from us-east-1 to us-east-2, then restore it in us-east-2. This piggybacks on existing backup infrastructure (daily snapshots already configured at `deploy/cloudformation.yml` backup section) and avoids standing up DataSync or a temporary EC2 bastion.

## Prerequisites

- AWS account has Fargate service quota headroom in us-east-2 (default quota is generous, should be fine for 1 task)
- Bedrock model access enabled in us-east-2 (IAM permission `bedrock:InvokeModel` on the cross-region inference profile; the existing task role policy should cover it but verify)
- Cloudflare tunnel token is region-agnostic (it is — `cloudflared` dials out to Cloudflare's edge)

## Step 1: Parameterize the CloudFormation template

`deploy/cloudformation.yml` hardcodes `us-east-1` in 10 places. These must be parameterized so the same template deploys to either region cleanly.

Replace with `${AWS::Region}` pseudo-parameter:

| Line | Current | Replace with |
|------|---------|--------------|
| 53 | `us-east-1a` | `!Select [0, !GetAZs ""]` |
| 64 | `us-east-1b` | `!Select [1, !GetAZs ""]` |
| 300, 437 | `arn:aws:logs:us-east-1:...` | `arn:aws:logs:${AWS::Region}:...` |
| 393 | `arn:aws:cloudformation:us-east-1:...` | `arn:aws:cloudformation:${AWS::Region}:...` |
| 420, 426 | `arn:aws:ecs:us-east-1:...` | `arn:aws:ecs:${AWS::Region}:...` |
| 448, 449 | `arn:aws:backup:us-east-1:...` | `arn:aws:backup:${AWS::Region}:...` |
| 494 | `Value: us-east-1` | `Value: !Ref AWS::Region` |

This cleanup is worth doing in a separate PR before the migration so it's trivially reversible if issues arise.

## Step 2: Set up cross-region backup replication

In the existing us-east-1 stack, add a copy rule to the `BackupPlan` resource that replicates backups to a new vault in us-east-2.

1. Create the destination vault in us-east-2 first (standalone stack or manual):
   ```yaml
   DestinationVault:
     Type: AWS::Backup::BackupVault
     Properties:
       BackupVaultName: pi-digby-us-east-2
   ```
2. Update the us-east-1 backup plan with a copy action targeting the us-east-2 vault ARN:
   ```yaml
   CopyActions:
     - DestinationBackupVaultArn: arn:aws:backup:us-east-2:${AWS::AccountId}:backup-vault:pi-digby-us-east-2
       Lifecycle:
         DeleteAfterDays: 5
   ```
3. Wait 24h for the next scheduled backup to run and replicate, or trigger an on-demand backup via the AWS Backup console.

## Step 3: Stand up the us-east-2 stack

1. Deploy a **parallel** CloudFormation stack in us-east-2 with the parameterized template, but **do not start the ECS service yet** (set `DesiredCount: 0`).
2. This creates: VPC, subnets, security groups, EFS (empty), ECR repo, CloudWatch log group, Secrets Manager secret (empty placeholders), IAM roles, ECS cluster + task definition.
3. Populate the us-east-2 Secrets Manager secret with the same values as us-east-1 (MOM_SLACK_*, LINEAR_*, CLOUDFLARE_TUNNEL_TOKEN, etc.). Secrets are regional — you'll need to copy them manually or via a script.
4. Build and push the Docker image to the us-east-2 ECR repo (the GitHub Actions workflow targets one region via env var; either run it manually with `AWS_REGION=us-east-2` or use `aws ecr` + `docker push` directly).

## Step 4: Restore EFS data in us-east-2

1. In the us-east-2 AWS Backup console, locate the copied recovery point in the `pi-digby-us-east-2` vault.
2. Restore to a new EFS filesystem **or** restore into the empty EFS created by the CloudFormation stack. The latter requires matching the filesystem ID, which is tricky — cleaner to:
   a. Restore to a new EFS (call it `pi-digby-restored`)
   b. Update the us-east-2 CloudFormation stack to reference the restored EFS ID instead of creating a new one (use a parameter like `ExistingEfsId`)
   c. Or: restore to a temp EFS, mount both temp and stack-created EFS on a one-shot ECS task, `rsync` from temp to target, delete temp

The rsync approach is more work but keeps the stack self-contained. The parameter approach is cleaner if you're comfortable with the stack referencing an externally-created resource.

## Step 5: Cutover

digby has a single active instance (one Slack connection, one Linear webhook). The cutover is a hard swap: scale us-east-1 to zero, sync, start us-east-2. Because it's strictly sequential, there's no split-brain risk — but the sequence must be strict.

**Expected downtime**: ~5-10 minutes (time for the final backup + copy + restore + task start). Slack messages received during this window will be backfilled on restart via `client.backfillChannel()` (existing behavior). Linear webhooks received during this window will be retried by Linear per its webhook retry policy (1 minute, 1 hour, 6 hours).

1. **Stop us-east-1 first**: scale the us-east-1 ECS service to `DesiredCount: 0` — this stops all writes to the us-east-1 EFS
2. Wait for the task to fully drain (check ECS console, should be <60s)
3. Verify no writes to us-east-1 EFS (check CloudWatch metrics for EFS activity)
4. Do a final on-demand backup in us-east-1, wait for the cross-region copy to complete
5. Restore that latest backup to us-east-2 EFS (final delta sync — captures everything from the last periodic backup up to the stop)
6. **Start the us-east-2 ECS service** (`DesiredCount: 1`)
7. Verify digby boots cleanly: check CloudWatch logs for startup, verify Slack client connects, verify Linear webhook is reachable via Cloudflare tunnel
8. Smoke test: mention digby in Slack, verify response; assign a Linear issue, verify thought activity fires

## Step 6: Update external references

- Cloudflare tunnel: **no change needed** — the tunnel runs inside the container and dials out. It's region-agnostic.
- Linear webhook URL: **no change needed** — same Cloudflare hostname (`surface.digby.brain-waves.io`).
- GitHub Actions deploy workflow: update `AWS_REGION` env var from `us-east-1` to `us-east-2` in `.github/workflows/deploy.yml`.
- `CLAUDE.md`: update any region references.

## Step 7: Park us-east-1 resources

Because digby has exactly one active instance (single Slack + Linear integration, no load balancing), we scale us-east-1 to zero at cutover — not leave it running. The us-east-1 CloudFormation stack stays in place as a dormant rollback target with `DesiredCount: 0`.

- **Decommissioning the parked stack is tracked as a separate piece of work** (see followup below). Do not delete it as part of this migration.
- Keep the latest us-east-1 EFS backup retained until decommissioning.
- The ECS service at `DesiredCount: 0` incurs no Fargate cost. The EFS volume and daily backups continue to incur small storage costs (~$0.30/GB/month for EFS Standard, less for IA tier). This is acceptable for a few days of rollback safety.

## Verification

- `curl https://surface.digby.brain-waves.io/health` returns "ok"
- Slack: `@digby hi` → responds with cost footer
- Linear: assign an issue to digby → receives thought activity within 10s, produces response
- CloudWatch logs in `/ecs/pi-digby` (us-east-2) show normal activity
- EFS contains historical channel directories (ls `/data/C*` inside the container via ECS Exec)
- Datadog (once integrated) shows ECS task metrics from us-east-2

## Rollback plan

If us-east-2 is unhealthy:
1. Stop us-east-2 ECS service (`DesiredCount: 0`)
2. Scale us-east-1 ECS service back up (`DesiredCount: 1`) — still has EFS state from before cutover
3. Debug us-east-2 issues without production pressure
4. Any messages that arrived during the us-east-2 window will be in us-east-2 EFS only — Slack messages are recoverable via `backfillChannel()` on restart, but Linear agent sessions may be lost. If this matters, do a reverse sync (us-east-2 EFS → us-east-1 EFS via AWS Backup) before scaling us-east-1 back up.

## Critical files to modify

- `deploy/cloudformation.yml` — parameterize region references, add backup copy rule
- `.github/workflows/deploy.yml` — update `AWS_REGION` from `us-east-1` to `us-east-2`
- `CLAUDE.md` — update region references (if any)

## Followup work (separate plans)

- **Decommission us-east-1 stack** — after 2-3 days of stable us-east-2 operation, delete the parked us-east-1 CloudFormation stack, Secrets Manager secret, and any leftover backup copies. Track as its own plan.
- **Reverse DR backup** — consider replicating us-east-2 EFS backups back to us-east-1 (or another region) for disaster recovery. Small retention window (3-5 days) is enough.

## Open questions

- How are the Linear API key and webhook secret provisioned into the us-east-2 Secrets Manager — manual copy via AWS console, or via a one-shot migration script (`aws secretsmanager get-secret-value` + `put-secret-value`)?

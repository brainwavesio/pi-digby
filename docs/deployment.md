# Deployment

pi-digby runs on AWS ECS Fargate in us-east-1.

## Infrastructure

Managed by CloudFormation stack `pi-digby`. Deploy/update with:

```bash
aws cloudformation deploy \
  --profile brainwaves \
  --region us-east-1 \
  --stack-name pi-digby \
  --template-file deploy/cloudformation.yml \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

### Resources

| Resource | ID / ARN |
|----------|----------|
| VPC | `vpc-0c1999dc6e5c15de0` |
| ECS Cluster | `pi-digby` |
| ECS Service | `pi-digby` |
| ECR | `150506369510.dkr.ecr.us-east-1.amazonaws.com/pi-digby` |
| EFS | `fs-0d331efafa19adc32` (mounted at `/data`) |
| GitHub Deploy Role | `arn:aws:iam::150506369510:role/pi-digby-github-deploy` |
| Secrets Manager | `pi-digby/env` |
| CloudWatch Logs | `/ecs/pi-digby` |

## Secrets

Stored in AWS Secrets Manager as `pi-digby/env` (JSON with individual keys).

Update secrets:
```bash
aws secretsmanager put-secret-value \
  --profile brainwaves \
  --region us-east-1 \
  --secret-id pi-digby/env \
  --secret-string '{
    "MOM_SLACK_APP_TOKEN": "xapp-...",
    "MOM_SLACK_BOT_TOKEN": "xoxb-...",
    "AWS_ACCESS_KEY_ID": "...",
    "AWS_SECRET_ACCESS_KEY": "...",
    "BROWSER_USE_API_KEY": "...",
    "EXA_API_KEY": "...",
    "GH_TOKEN": "...",
    "DD_API_KEY": "...",
    "DD_APP_KEY": "..."
  }'
```

View current secrets:
```bash
aws secretsmanager get-secret-value \
  --profile brainwaves \
  --region us-east-1 \
  --secret-id pi-digby/env \
  --query SecretString --output text | jq .
```

## CI/CD

Push to `main` triggers `.github/workflows/deploy.yml`:
1. OIDC auth → assumes `pi-digby-github-deploy` role
2. Build Docker image → push to ECR (tagged with SHA + `latest`)
3. `aws ecs update-service --force-new-deployment`
4. Wait for ECS service to stabilize

## Manual operations

```bash
# View running tasks
aws ecs list-tasks --profile brainwaves --region us-east-1 --cluster pi-digby

# View logs
aws logs tail /ecs/pi-digby --profile brainwaves --region us-east-1 --follow

# Exec into container (debugging)
TASK_ID=$(aws ecs list-tasks --profile brainwaves --region us-east-1 --cluster pi-digby --query 'taskArns[0]' --output text)
aws ecs execute-command --profile brainwaves --region us-east-1 --cluster pi-digby --task $TASK_ID --container pi-digby --interactive --command /bin/bash

# Force restart
aws ecs update-service --profile brainwaves --region us-east-1 --cluster pi-digby --service pi-digby --force-new-deployment

# Scale down (stop bot)
aws ecs update-service --profile brainwaves --region us-east-1 --cluster pi-digby --service pi-digby --desired-count 0

# Scale up (start bot)
aws ecs update-service --profile brainwaves --region us-east-1 --cluster pi-digby --service pi-digby --desired-count 1
```

## Data migration (R2 → EFS)

One-time migration from Cloudflare R2:
```bash
# 1. Stop Cloudflare bot
# 2. Mount EFS locally or run rclone in an ECS task
# 3. rclone sync :s3:pi-digby-data /data
# 4. Verify: ls /data/.pi/mcp.json /data/MEMORY.md /data/*/log.jsonl
# 5. Start ECS: aws ecs update-service ... --desired-count 1
```

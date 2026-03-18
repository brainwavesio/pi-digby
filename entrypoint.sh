#!/bin/sh
# Mount R2 bucket at /data for persistent storage
if [ -n "$R2_ACCOUNT_ID" ] && [ -n "$R2_BUCKET_NAME" ]; then
  mkdir -p /data
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

  # Scope R2 credentials to the tigrisfs process only,
  # keeping global AWS_* vars for Bedrock
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    /usr/local/bin/tigrisfs --endpoint "$R2_ENDPOINT" -f "$R2_BUCKET_NAME" /data &

  # Wait for mount to be ready
  MOUNT_TIMEOUT=15
  ELAPSED=0
  while ! mountpoint -q /data 2>/dev/null; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    if [ "$ELAPSED" -ge "$MOUNT_TIMEOUT" ]; then
      echo "WARNING: R2 mount failed after ${MOUNT_TIMEOUT}s, continuing with ephemeral /data"
      break
    fi
  done

  if mountpoint -q /data 2>/dev/null; then
    echo "R2 bucket '${R2_BUCKET_NAME}' mounted at /data"
  fi
else
  echo "R2 not configured, using ephemeral /data"
fi

# Persist ~/.pi on R2 so OAuth tokens, auth.json, and MCP cache survive restarts.
# /root/.pi is symlinked -> /data/.pi (the R2 mount).
mkdir -p /data/.pi
ln -sfn /data/.pi /root/.pi

# Persist ~/.gitconfig on R2 so git identity survives restarts.
if [ -f /data/.gitconfig ]; then
  ln -sf /data/.gitconfig /root/.gitconfig
fi

# Seed MCP config from repo default on first run
if [ ! -f /data/.pi/mcp.json ]; then
  cp /app/.pi/mcp.json /data/.pi/mcp.json
fi

# Substitute env vars into config values that don't support interpolation (e.g. URLs)
if [ -n "$EXA_API_KEY" ]; then
  sed -i "s|EXA_API_KEY_PLACEHOLDER|$EXA_API_KEY|g" /data/.pi/mcp.json
fi

ln -sf /data/.pi/mcp.json /app/.pi/mcp.json

# QMD setup: seed config and prepare directories
if [ ! -f /data/qmd.yml ]; then
  cp /app/qmd.yml /data/qmd.yml
fi
mkdir -p /data/.cache/qmd /data/memory

# Persist ~/.cache/qmd on R2 so embedding models and index survive restarts.
mkdir -p /root/.cache
ln -sfn /data/.cache/qmd /root/.cache/qmd

# Background: build initial index
QMD_CACHE_DIR=/data/.cache/qmd qmd embed &

exec node packages/mom/dist/main.js --sandbox=host /data

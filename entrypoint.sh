#!/bin/sh

# /data is pre-mounted by ECS via EFS — no mount logic needed

# Persist ~/.pi on EFS so MCP config, auth tokens survive restarts
mkdir -p /data/.pi
ln -sfn /data/.pi /root/.pi

# Persist ~/.gitconfig on EFS
if [ -f /data/.gitconfig ]; then
  ln -sf /data/.gitconfig /root/.gitconfig
fi

# Seed MCP config from repo default on first run
if [ ! -f /data/.pi/mcp.json ]; then
  cp /app/.pi/mcp.json /data/.pi/mcp.json
fi

# Substitute env vars into MCP config URLs
if [ -n "$EXA_API_KEY" ]; then
  sed -i "s|EXA_API_KEY_PLACEHOLDER|$EXA_API_KEY|g" /data/.pi/mcp.json
fi

ln -sf /data/.pi/mcp.json /app/.pi/mcp.json

# QMD setup: seed config and prepare directories
if [ ! -f /data/qmd.yml ]; then
  cat > /data/qmd.yml << 'QMDEOF'
collections:
  - name: channels
    paths:
      - /data/*/memory/**/*.md
      - /data/*/log.jsonl
  - name: global
    paths:
      - /data/memory/**/*.md
      - /data/MEMORY.md
QMDEOF
fi
mkdir -p /data/.cache/qmd /data/memory

# Persist QMD cache on EFS
mkdir -p /root/.cache
ln -sfn /data/.cache/qmd /root/.cache/qmd

# Background: build initial index
QMD_CACHE_DIR=/data/.cache/qmd qmd embed &

exec node dist/main.js /data

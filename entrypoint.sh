#!/bin/sh

# /data is pre-mounted by ECS via EFS — no mount logic needed
# HOME=/data (set in Dockerfile) so all ~/... paths resolve to /data/...

# Seed MCP config from repo default on first run
mkdir -p /data/.pi
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

# Background: build initial index
qmd embed &

exec node dist/main.js /data

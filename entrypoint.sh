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

# QMD setup: ensure collections are registered in the sqlite DB
# Collections live in the sqlite DB (on EFS), not in qmd.yml.
# We re-register them on every start — idempotent, fast if already up to date.
mkdir -p /data/.cache/qmd /data/memory

# Persist QMD cache on EFS
mkdir -p /root/.cache
ln -sfn /data/.cache/qmd /root/.cache/qmd

# Register collections (idempotent — safe to run every boot)
QMD_CACHE_DIR=/data/.cache/qmd qmd collection add /data/memory \
  --name memory --context "Global workspace memory, notes, and daily summaries" 2>/dev/null || true
QMD_CACHE_DIR=/data/.cache/qmd qmd collection add /data \
  --name channels --mask "*/memory/**/*.md" \
  --context "Per-channel memory, daily summaries, and notes" 2>/dev/null || true
QMD_CACHE_DIR=/data/.cache/qmd qmd collection add /data \
  --name skills --mask "**/skills/**/SKILL.md" \
  --context "Reusable CLI tool definitions" 2>/dev/null || true

# Background: update index then generate missing embeddings
(QMD_CACHE_DIR=/data/.cache/qmd qmd update && QMD_CACHE_DIR=/data/.cache/qmd qmd embed) &

# Start Cloudflare Tunnel (if configured)
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
  echo "Cloudflare tunnel started"
fi

exec node dist/main.js /data

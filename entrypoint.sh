#!/bin/sh
# Seed persistent MCP config from repo default on first run, then symlink
mkdir -p /data/.pi
if [ ! -f /data/.pi/mcp.json ]; then
  cp /app/.pi/mcp.json /data/.pi/mcp.json
fi

# Substitute env vars into config values that don't support interpolation (e.g. URLs)
if [ -n "$EXA_API_KEY" ]; then
  sed -i "s|EXA_API_KEY_PLACEHOLDER|$EXA_API_KEY|g" /data/.pi/mcp.json
fi

ln -sf /data/.pi/mcp.json /app/.pi/mcp.json

exec node packages/mom/dist/main.js --sandbox=host /data

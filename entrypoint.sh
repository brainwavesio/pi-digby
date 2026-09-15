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

# Install or upgrade the bundled D1 skill. Only files owned by this bundled
# skill are changed; other workspace skills and files remain untouched.
mkdir -p /data/skills
bundled_d1_skill=/app/skills/cloudflare-d1
installed_d1_skill=/data/skills/cloudflare-d1
if ! cmp -s "$bundled_d1_skill/.version" "$installed_d1_skill/.version"; then
  mkdir -p "$installed_d1_skill"
  if ! (
    cp "$bundled_d1_skill/SKILL.md" "$installed_d1_skill/SKILL.md" &&
    cp "$bundled_d1_skill/users.sh" "$installed_d1_skill/users.sh" &&
    chmod +x "$installed_d1_skill/users.sh" &&
    rm -f "$installed_d1_skill/query.sh" "$installed_d1_skill/validate_sql.py" &&
    cp "$bundled_d1_skill/.version" "$installed_d1_skill/.version.next" &&
    mv "$installed_d1_skill/.version.next" "$installed_d1_skill/.version"
  ); then
    echo "Failed to install the bundled Cloudflare D1 skill" >&2
    exit 1
  fi
fi

# Substitute env vars into MCP config URLs
if [ -n "$EXA_API_KEY" ]; then
  sed -i "s|EXA_API_KEY_PLACEHOLDER|$EXA_API_KEY|g" /data/.pi/mcp.json
fi

ln -sf /data/.pi/mcp.json /app/.pi/mcp.json

# QMD setup: persist config and cache on EFS so collections and models
# survive container restarts without re-registration or re-downloading.
mkdir -p /data/.cache/qmd /data/.config/qmd /data/memory

# Persist ~/.cache/qmd (models + sqlite DB) on EFS
mkdir -p /root/.cache
ln -sfn /data/.cache/qmd /root/.cache/qmd

# Persist ~/.config/qmd (collection definitions) on EFS
mkdir -p /root/.config
ln -sfn /data/.config/qmd /root/.config/qmd

# Seed collection config on first boot (idempotent — only writes if missing)
if [ ! -f /data/.config/qmd/index.yml ]; then
  cat > /data/.config/qmd/index.yml << 'QMDEOF'
collections:
  memory:
    path: /data/memory
    pattern: "**/*.md"
    context: "Global workspace memory, notes, and daily summaries"
  channels:
    path: /data
    pattern: "*/memory/**/*.md"
    context: "Per-channel memory, daily summaries, and notes"
  skills:
    path: /data
    pattern: "**/skills/**/SKILL.md"
    context: "Reusable CLI tool definitions"
QMDEOF
fi

# Background: re-index any changed files, then embed new content
(qmd update && qmd embed) &

# Start Cloudflare Tunnel (if configured)
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
  echo "Cloudflare tunnel started"
fi

exec node dist/main.js /data

FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl ca-certificates \
    build-essential python3 \
    libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev \
    libgif-dev librsvg2-dev libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-bookworm-slim

# Detect target architecture for arch-specific downloads
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl wget ca-certificates \
    python3 python3-pip python3-venv \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    imagemagick \
    unzip zip less vim nano htop procps tmux \
    gh \
  && rm -rf /var/lib/apt/lists/*

# ripgrep — arch-aware
RUN RG_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
  && curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${RG_ARCH}-unknown-linux-musl.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-14.1.1-${RG_ARCH}-unknown-linux-musl/rg"

# cloudflared (Cloudflare Tunnel client) — pinned version + per-arch checksum
RUN CF_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
  && AMD64_SHA="4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30" \
  && ARM64_SHA="0755ba4cbab59980e6148367fcf53a8f3ec85a97deefd63c2420cf7850769bee" \
  && EXPECTED=$([ "$TARGETARCH" = "arm64" ] && echo "$ARM64_SHA" || echo "$AMD64_SHA") \
  && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-linux-${CF_ARCH}" \
  && echo "${EXPECTED}  /usr/local/bin/cloudflared" | sha256sum -c - \
  && chmod +x /usr/local/bin/cloudflared

# pup (Datadog CLI) — arch-aware
RUN VERSION=$(curl -sL https://api.github.com/repos/DataDog/pup/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) \
  && PUP_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x86_64") \
  && curl -fsSL "https://github.com/DataDog/pup/releases/download/${VERSION}/pup_${VERSION#v}_Linux_${PUP_ARCH}.tar.gz" \
    -o /tmp/pup.tar.gz \
  && tar -xzf /tmp/pup.tar.gz -C /usr/local/bin/ pup \
  && rm /tmp/pup.tar.gz \
  && chmod +x /usr/local/bin/pup

# uv (fast Python package manager) — install.sh auto-detects arch
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
  && ln -s /root/.local/bin/uv /usr/local/bin/uv \
  && ln -s /root/.local/bin/uvx /usr/local/bin/uvx

# bun (fast JS/TS runtime) — install script auto-detects arch
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

# AWS CLI v2 — arch-aware
RUN AWS_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/awscliv2.zip /tmp/aws

# qmd (semantic search over markdown files)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake python3-dev \
  && npm install -g @tobilu/qmd@2.5.1 \
  && apt-get purge -y build-essential cmake python3-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# claude (Claude Code CLI) and codex (OpenAI Codex CLI)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Ensure /usr/local/bin is in PATH for all users (including `node` user used for claude/codex)
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY .pi/ .pi/
COPY entrypoint.sh ./

RUN mkdir -p /data && chmod +x entrypoint.sh

# At runtime, HOME=/data so all dotfiles/caches land on EFS.
# Build-time installs (uv, bun) stay in /root, reachable via /usr/local/bin symlinks.
ENV HOME=/data

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["./entrypoint.sh"]

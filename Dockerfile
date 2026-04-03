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

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl wget ca-certificates \
    python3 python3-pip python3-venv \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    imagemagick \
    unzip zip less vim nano htop procps tmux \
    gh \
  && rm -rf /var/lib/apt/lists/*

# ripgrep
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-14.1.1-x86_64-unknown-linux-musl/rg"

# cloudflared (Cloudflare Tunnel client) — pinned version + checksum
RUN curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-linux-amd64" \
  && echo "4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30  /usr/local/bin/cloudflared" | sha256sum -c - \
  && chmod +x /usr/local/bin/cloudflared

# pup (Datadog CLI)
RUN VERSION=$(curl -s https://api.github.com/repos/datadog-labs/pup/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) \
  && curl -fsSL "https://github.com/datadog-labs/pup/releases/download/${VERSION}/pup_${VERSION#v}_Linux_x86_64.tar.gz" \
    -o /tmp/pup.tar.gz \
  && tar -xzf /tmp/pup.tar.gz -C /usr/local/bin/ pup \
  && rm /tmp/pup.tar.gz \
  && chmod +x /usr/local/bin/pup

# uv (fast Python package manager)
RUN curl -fsSL https://astral.sh/uv/install.sh | sh \
  && ln -s /root/.local/bin/uv /usr/local/bin/uv \
  && ln -s /root/.local/bin/uvx /usr/local/bin/uvx

# bun (fast JS/TS runtime)
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -s /root/.bun/bin/bunx /usr/local/bin/bunx

# qmd (semantic search over markdown files)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake python3-dev \
  && npm install -g @tobilu/qmd \
  && apt-get purge -y build-essential cmake python3-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

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

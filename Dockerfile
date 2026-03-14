FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl ca-certificates \
    build-essential python3 \
    libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev \
    libgif-dev librsvg2-dev libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first so npm ci is cached independently of source changes
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/ai/package.json packages/ai/
COPY packages/coding-agent/package.json packages/coding-agent/
COPY packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json packages/coding-agent/examples/extensions/custom-provider-anthropic/
COPY packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/
COPY packages/coding-agent/examples/extensions/custom-provider-qwen-cli/package.json packages/coding-agent/examples/extensions/custom-provider-qwen-cli/
COPY packages/coding-agent/examples/extensions/sandbox/package.json packages/coding-agent/examples/extensions/sandbox/
COPY packages/coding-agent/examples/extensions/with-deps/package.json packages/coding-agent/examples/extensions/with-deps/
COPY packages/mom/package.json packages/mom/
COPY packages/pods/package.json packages/pods/
COPY packages/tui/package.json packages/tui/
COPY packages/web-ui/package.json packages/web-ui/
COPY packages/web-ui/example/package.json packages/web-ui/example/
RUN npm ci

# Now copy source and build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl wget ca-certificates \
    python3 python3-pip python3-venv \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    unzip zip less vim nano htop procps tmux \
    gh fuse \
  && rm -rf /var/lib/apt/lists/*

# tigrisfs (FUSE adapter for mounting R2 buckets)
RUN VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) \
  && curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_amd64.tar.gz" \
    -o /tmp/tigrisfs.tar.gz \
  && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ \
  && rm /tmp/tigrisfs.tar.gz \
  && chmod +x /usr/local/bin/tigrisfs

# ripgrep
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-14.1.1-x86_64-unknown-linux-musl/rg"

# cloudflared (for tunneling artifact servers to the web)
RUN curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" \
  && chmod +x /usr/local/bin/cloudflared

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
COPY --from=builder /app .

RUN mkdir -p /data

RUN chmod +x entrypoint.sh
CMD ["./entrypoint.sh"]

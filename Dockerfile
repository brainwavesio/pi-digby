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
    git jq curl ca-certificates \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
  && rm -rf /var/lib/apt/lists/*

# ripgrep (used by coding agent for file search)
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-14.1.1-x86_64-unknown-linux-musl/rg"

WORKDIR /app
COPY --from=builder /app .

RUN mkdir -p /data

RUN chmod +x entrypoint.sh
CMD ["./entrypoint.sh"]

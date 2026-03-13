FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl ca-certificates \
    build-essential python3 \
    libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev \
    libgif-dev librsvg2-dev libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

# ripgrep (used by coding agent for file search)
RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz" \
  | tar xz --strip-components=1 -C /usr/local/bin "ripgrep-14.1.1-x86_64-unknown-linux-musl/rg"

WORKDIR /app
RUN git clone --depth 1 https://github.com/brainwavesio/pi-digby.git . \
  && npm ci \
  && npm run build \
  && rm -rf .git

RUN mkdir -p /data

CMD ["node", "packages/mom/dist/main.js", "--sandbox=host", "/data"]

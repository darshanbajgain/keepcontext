# KeepContext image. Published to ghcr.io on every release tag (.github/workflows/docker.yml).

# cloudflared for Settings → Public access (src/tunnel.js): the official release binary, pinned and checksum-verified.
# To update: new version + the two SHA-256 values from the release notes (github.com/cloudflare/cloudflared/releases).
FROM node:26-slim AS cloudflared
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.10.1
ARG CLOUDFLARED_SHA256_AMD64=3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586
ARG CLOUDFLARED_SHA256_ARM64=2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) sum="$CLOUDFLARED_SHA256_AMD64" ;; \
      arm64) sum="$CLOUDFLARED_SHA256_ARM64" ;; \
      *) echo "no cloudflared for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); require('fs').writeFileSync('/cloudflared', Buffer.from(await r.arrayBuffer())); }).catch((e) => { console.error(e.message); process.exit(1); })" \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH:-amd64}"; \
    echo "$sum  /cloudflared" | sha256sum -c -; \
    chmod 755 /cloudflared

FROM node:26-slim

WORKDIR /app
# cloudflared verifies Cloudflare's TLS certificates with the system CA store, which the slim image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=cloudflared /cloudflared /usr/local/bin/cloudflared
ENV NODE_ENV=production DATA_DIR=/data PORT=8787

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Run as the image's unprivileged "node" user; the database lives in the /data volume.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ARG VERSION=dev
LABEL org.opencontainers.image.title="KeepContext" \
      org.opencontainers.image.description="One self-hosted memory for every AI app, over MCP" \
      org.opencontainers.image.source="https://github.com/darshanbajgain/keepcontext" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$VERSION"

CMD ["node", "--no-warnings", "src/server.js"]

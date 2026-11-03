# KeepContext image. Published to ghcr.io on every release tag (.github/workflows/docker.yml).
FROM node:26-slim

WORKDIR /app
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

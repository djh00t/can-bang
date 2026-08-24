FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY core core
COPY server server
COPY web web
COPY mcp mcp
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core ./core
COPY --from=builder /app/server ./server
COPY --from=builder /app/web ./web
COPY --from=builder /app/mcp ./mcp
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

RUN useradd --create-home --uid 10001 workbench && mkdir -p /data && chown -R workbench:workbench /data
USER workbench

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://localhost:8080/health >/dev/null || exit 1

CMD ["node", "server/dist/index.js"]

# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS builder
WORKDIR /app

# Native modules + Rust toolchain for workspace build
RUN apk add --no-cache python3 make g++ rust cargo

COPY package.json package-lock.json npm-shrinkwrap.json ./
COPY scripts/check-ollama.js scripts/postinstall-check-native.mjs scripts/setup-githooks.mjs ./scripts/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Non-root runtime user
RUN addgroup -S memphis && adduser -S -G memphis memphis

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/crates/memphis-napi/index.node ./crates/memphis-napi/index.node
COPY --from=builder /app/scripts/public-chat-gateway.mjs ./scripts/public-chat-gateway.mjs
COPY --from=builder /app/sites/memphis-v5/chat/ ./sites/memphis-v5/chat/
COPY --from=builder /app/sites/memphis-v5/favicon.svg ./sites/memphis-v5/favicon.svg

RUN mkdir -p /home/memphis/.memphis /app/data \
  && chown -R memphis:memphis /app /home/memphis

USER memphis
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/infra/cli/index.js", "serve"]

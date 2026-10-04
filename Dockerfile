# syntax=docker/dockerfile:1

# Multi-stage build: the runtime image carries production dependencies and
# compiled output only — no toolchain, no tests, no source.

FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first so the layer caches across source-only changes.
COPY package.json package-lock.json ./
# esbuild is a native module; without a libc match it silently fails at runtime.
RUN apk add --no-cache libc6-compat \
    && npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# Prune to production dependencies for the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, which the bot's graceful shutdown
# depends on to drain cleanly.
RUN apk add --no-cache tini \
    && addgroup -S redoubt && adduser -S redoubt -G redoubt

COPY --from=build --chown=redoubt:redoubt /app/node_modules ./node_modules
COPY --from=build --chown=redoubt:redoubt /app/dist ./dist
COPY --from=build --chown=redoubt:redoubt /app/drizzle ./drizzle
COPY --from=build --chown=redoubt:redoubt /app/package.json ./package.json

USER redoubt

ENV NODE_ENV=production

# The process exits non-zero on an uncaught exception so an orchestrator
# restarts it rather than leaving a half-dead container running.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

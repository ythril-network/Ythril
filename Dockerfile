# syntax=docker/dockerfile:1
# ── Stage 1: Build Angular SPA ───────────────────────────────────────────────
FROM node:22-slim AS client-builder

WORKDIR /build

# Copy workspace manifests for layer caching
COPY package.json package-lock.json* ./
COPY client/package.json ./client/

# Install client dependencies
RUN npm ci --workspace=client

# Copy source and build
COPY client/ ./client/
RUN npm run build:prod --workspace=client
# Angular output: client/dist/browser/

# ── Stage 2: Build server ────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Build tools required for bcrypt native C++ addon
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY server/package.json ./server/

# Install all dependencies (including devDependencies for TypeScript compiler)
RUN npm ci --workspace=server

# Copy source
COPY server/ ./server/

# Compile TypeScript
RUN npm run build --workspace=server

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-slim AS production

LABEL org.opencontainers.image.source="https://github.com/ythril-network/Ythril"
LABEL org.opencontainers.image.description="Ythril — self-hosted brain & knowledge management platform"
LABEL org.opencontainers.image.licenses="PolyForm-Small-Business-1.0.0"

# Build tools for bcrypt native addon (compiled during npm ci --omit=dev)
# ffmpeg: LGPL-2.1+ core only (no GPL codecs); used for audio/video media embedding pipeline.
# Verify at build time: ffmpeg -buildconf | grep enable-gpl must be absent.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY server/package.json ./server/

# Install production dependencies only
RUN npm ci --workspace=server --omit=dev

# Copy compiled output from builder
COPY --from=builder /build/server/dist ./server/dist

# Copy compiled Angular SPA from client-builder
COPY --from=client-builder /build/client/dist/browser ./client/dist/browser

# Pre-download & cache the embedding model so first startup is instant and fully offline.
# --mount=type=cache keeps downloaded files on the build host between rebuilds so that
# invalidating an earlier layer (e.g. npm ci) doesn't re-download ~274 MB every time.
# The model is then copied into the image layer so the container starts offline.
ENV MODEL_CACHE_DIR=/app/model-cache
RUN --mount=type=cache,target=/tmp/hf-model-cache \
    printf '%s\n' \
    'import { pipeline, env } from "@huggingface/transformers";' \
    'env.cacheDir = "/tmp/hf-model-cache";' \
    'await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", { dtype: "fp32" });' \
    > /app/server/warm.mjs && \
    node /app/server/warm.mjs && \
    rm /app/server/warm.mjs && \
    mkdir -p /app/model-cache && \
    cp -a /tmp/hf-model-cache/. /app/model-cache/
ENV NODE_ENV=production
ENV PORT=3200
ENV CONFIG_PATH=/config/config.json
ENV DATA_ROOT=/data
ENV CLIENT_DIST=/app/client/dist/browser

EXPOSE 3200

# Pre-create mount-point directories owned by node so volume mounts are writable
RUN mkdir -p /data /config && chown -R node:node /data /config /app/model-cache

# Run as non-root user
USER node

CMD ["node", "server/dist/index.js"]

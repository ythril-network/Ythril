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

# Build tools for bcrypt native addon (compiled during npm ci --omit=dev)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

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
# MODEL_CACHE_DIR is baked into the image layer; the node user has read/write access.
ENV MODEL_CACHE_DIR=/app/model-cache
RUN printf '%s\n' \
    'import { pipeline, env } from "@huggingface/transformers";' \
    'env.cacheDir = process.env.MODEL_CACHE_DIR;' \
    'console.log("Downloading nomic-embed-text-v1.5 (~274 MB, cached in image)...");' \
    'await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5");' \
    'console.log("Embedding model ready.");' \
    > /app/server/warm.mjs && node /app/server/warm.mjs && rm /app/server/warm.mjs
ENV NODE_ENV=production
ENV PORT=3200
ENV CONFIG_PATH=/config/config.json
ENV DATA_ROOT=/data
ENV MONGO_URI=mongodb://ythril-mongo:27017
ENV CLIENT_DIST=/app/client/dist/browser

EXPOSE 3200

# Pre-create mount-point directories owned by node so volume mounts are writable
RUN mkdir -p /data /config && chown -R node:node /data /config /app/model-cache

# Run as non-root user
USER node

CMD ["node", "server/dist/index.js"]

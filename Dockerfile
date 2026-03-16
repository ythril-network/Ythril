# ── Stage 1: Build Angular SPA ───────────────────────────────────────────────
FROM node:22-alpine AS client-builder

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
FROM node:22-alpine AS builder

# Build tools required for bcrypt native C++ addon
RUN apk add --no-cache python3 make g++

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
FROM node:22-alpine AS production

RUN apk add --no-cache python3 make g++

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

# Runtime environment
ENV NODE_ENV=production
ENV PORT=3200
ENV CONFIG_PATH=/config/config.json
ENV DATA_ROOT=/data
ENV MONGO_URI=mongodb://ythril-mongo:27017
ENV CLIENT_DIST=/app/client/dist/browser

EXPOSE 3200

# Pre-create mount-point directories owned by node so volume mounts are writable
RUN mkdir -p /data /config && chown -R node:node /data /config

# Run as non-root user
USER node

CMD ["node", "server/dist/index.js"]

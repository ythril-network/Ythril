# syntax=docker/dockerfile:1
# ── Stage 1: Build Angular SPA ───────────────────────────────────────────────
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS client-builder

WORKDIR /build

# Copy workspace manifests for layer caching
COPY package.json package-lock.json* ./
COPY client/package.json ./client/

# Install client dependencies.
#
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip is not an optimisation, it is what makes this step hermetic — the same
# reasoning that put it on both `npm ci` steps in CI. `onnxruntime-node` fetches its CUDA execution-provider
# binaries from a GitHub release on postinstall, and on a machine with no `nvcc` it logs "nvcc not found.
# Assuming CUDA 12" and downloads the GPU tarball anyway. Two CI runs failed 35 minutes apart on that
# download alone; a Docker build has the same dependency on github.com being reachable and fast, and it is
# the build most likely to run somewhere that neither is true.
#
# Owner ruled P-5 = A on 2026-08-15: skip it in the image too. A GPU deployment loses the execution provider
# and needs its own image variant — nothing in the published image uses it, since the bundled embedder runs
# on CPU.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci --workspace=client

# Copy source and build.
#
# `docs/` comes along because the in-product Help page renders the SHIPPED guides: angular.json copies
# docs/*.md into the client's assets, so an operator can answer "what does this setting do?" without
# leaving the instance — which matters most exactly where it is hardest, on an air-gapped install with
# no route to github.com. Without this COPY the asset glob resolves to nothing and Help ships empty.
COPY client/ ./client/
COPY docs/ ./docs/
RUN npm run build:prod --workspace=client
# Angular output: client/dist/browser/

# ── Stage 2: Build server ────────────────────────────────────────────────────
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS builder

# Build tools required for bcrypt native C++ addon
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace manifests first for layer caching
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY server/package.json ./server/

# Install all dependencies (including devDependencies for TypeScript compiler).
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip — see the client stage for why. Repeated because ENV does not cross a
# stage boundary, which is exactly the kind of thing a reader assumes and a build silently disproves.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci --workspace=server

# Copy source
COPY server/ ./server/

# Compile TypeScript
RUN npm run build --workspace=server

# ── Stage 1b: Production dependencies, built WITH the toolchain ──────────────
#
# The production stage used to run `npm ci --omit=dev` itself, which meant it needed `python3 make g++` to
# compile the bcrypt native addon — a compiler in the shipped image that nothing at runtime uses.
#
# MEASURED, because the first estimate here was wrong: that apt layer was 755 MB total, but ffmpeg is 472 MB of
# it. Removing the toolchain takes the layer to **472 MB — a 283 MB saving**, not 755. The layer also changes
# digest on every release regardless of the lockfile, because `apt-get update` is not reproducible, so it was
# re-downloaded on every pull; that half of the problem is unchanged, since ffmpeg still needs apt.
#
# Its own stage rather than reusing `builder`: builder's `node_modules` includes devDependencies (it needs the
# TypeScript compiler), so copying from there would ship those too. This installs the production tree only.
#
# ABI safety, which is the whole risk in moving a native addon between stages: same pinned base image, so the
# same Node version and the same libc. The compiled `.node` binary is copied, not rebuilt — `docker-boot.test.js`
# asserts bcrypt actually loads in the final image, because a broken native addon fails at REQUIRE time and
# would otherwise show up as a login that 500s rather than as a build error.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS prod-deps

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip — see the client stage. This is the `npm ci` that produces the tree the
# published image actually SHIPS, so it is the one where a GPU tarball would be both downloaded and carried.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
RUN npm ci --workspace=server --omit=dev

# ── Stage 1c: Warm the embedding model, in a stage of its own ─────────────────
#
# ## Why the largest layer in the image had to stop living in the production stage
#
# The model warm used to be a `RUN` inside `production`, positioned above the app-source COPYs so a source change
# would not invalidate it. That reasoning was right and insufficient: it still sat BELOW the ffmpeg apt layer and
# below `COPY --from=prod-deps node_modules`, so a dependency bump — or any `apt-get update`, which is not
# reproducible — re-executed it. Re-executing a `RUN` produces a fresh layer, and a fresh layer is a fresh digest
# even when its content is identical.
#
# MEASURED by an operator against the registry, and it recurs every release onto a node whose RAID1 has been
# degraded to a single drive since 2026-07-03: **2.3.0 → 2.4.0 shared 5 of 16 layers (76.2 MiB, ~7%) and
# re-downloaded 1024.4 MiB (93.5%)**. The 482.5 MiB model layer changed digest on a release that did not change
# the model.
#
# ## What makes a layer REUSABLE across releases
#
# Not "it was not invalidated" — a pull compares content digests, so a layer that is rebuilt but comes out
# byte-identical is not downloaded again. That is achievable for a COPY of fixed content and is not achievable for
# a RUN that downloads: the warm step also created and deleted `/app/server/warm.mjs`, which leaves `/app/server`
# with a new mtime in the same changeset as the model, so 482.5 MiB moved because of one directory timestamp.
#
# So the download happens here, in a stage that is thrown away, and production takes the result as a plain COPY.
# The shipped layer then keys on the model bytes alone. Everything above it in the production stage may change
# freely without costing a user 482.5 MiB.
#
# `FROM prod-deps` rather than a fresh stage that installs `@huggingface/transformers` on its own: the version has
# to be the one the server actually runs, and that is pinned in the lockfile. Installing the package separately
# would either duplicate a version string that can drift or leave it unpinned — a supply-chain regression to save
# a layer that is discarded anyway. This costs nothing: `prod-deps` is already built.
FROM prod-deps AS model-warm

# HF rate-limits anonymous downloads per-IP (shared CI egress), so the retry/backoff below rides through it,
# and `--mount=type=cache` keeps a local rebuild from re-fetching ~274 MB.
#
# This said "intermittent 403" until 2026-08-07, when the observed code was **429** on every one of six
# attempts. Corrected rather than left, because the two suggest different fixes: a 403 reads as an auth or
# policy problem you cannot wait out, and a 429 is precisely the one you can — which is what the backoff
# below is now sized for.
#
# The mtime stamp here is for THIS stage's own layer, not for the shipped one: it lets CI's `--cache-from
# type=gha` reuse a warm step across builds. The layer a user pulls is stamped again in the production stage,
# because — measured — stamping the source cannot make a `COPY` of it deterministic. See the note there.
#
# Ownership is deliberately NOT set here; the production stage sets it in the layer that ships.
#
# `warm.mjs` goes in `/app`, and that placement is load-bearing in BOTH directions:
#
#   - it must be under `/app`, because Node resolves a bare `@huggingface/transformers` import by walking up
#     from the SCRIPT's directory looking for `node_modules`. Writing it to `/` was tried and fails the build
#     outright — `/node_modules` does not exist. (The original wrote it to `/app/server`, which resolved.)
#   - it must NOT be under `/model-cache`, because a create-and-delete leaves the parent directory's new mtime
#     in the same changeset, and `/model-cache` is the tree the production stage takes.
#
# `/app`'s mtime moving here is harmless in a way it was not before: this whole stage is discarded, and only
# `/model-cache` is read out of it.
#
# ── The retry policy, and why it is two policies ─────────────────────────────────────────────────────
#
# This loop used to be six attempts backing off 2, 4, 8, 16, 32 seconds. It looked like protection and was
# not: the whole budget is 62 seconds, and the failure it actually receives is `Error (429)` — HuggingFace
# rate-limiting the anonymous download after a day's build volume. A rate-limit window does not clear in a
# minute, so the loop exhausted itself against an error that could not have succeeded in the time allowed,
# and took a release build down with it (2026-08-07).
#
# The loop was never broken — it logged all five retries and threw on the sixth, exactly as written. It was
# CALIBRATED for the wrong failure. That distinction is why the fix is a budget and not a rewrite.
#
# So the two failures now get different treatment, because they want opposite things:
#
#   - **429 — wait it out.** Up to nine sleeps of 15, 30, 45, 60, 75, 90, 90, 90, 90 seconds: about
#     9.5 minutes. A build already takes ~45, so spending that to survive a rate limit is cheap next to
#     spending 45 to discover one.
#   - **Anything else — fail fast.** A wrong model name, a 404, a full disk: three attempts and out, because
#     none of them become true by waiting. Without this split, raising the budget would have made every
#     genuine misconfiguration take ten minutes to report itself.
RUN --mount=type=cache,target=/tmp/hf-model-cache \
    printf '%s\n' \
    'import { pipeline, env } from "@huggingface/transformers";' \
    'env.cacheDir = "/tmp/hf-model-cache";' \
    'const load = () => pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", { dtype: "fp32" });' \
    'const rateLimited = (err) => String(err).includes("(429)");' \
    'const attempts = 10;' \
    'const FAST_FAIL_AFTER = 3;' \
    'for (let i = 1; i <= attempts; i++) {' \
    '  try { await load(); break; }' \
    '  catch (err) {' \
    '    const limited = rateLimited(err);' \
    '    if (i === attempts || (!limited && i >= FAST_FAIL_AFTER)) throw err;' \
    '    const delay = limited ? Math.min(90, 15 * i) : 2 ** i;' \
    '    console.warn(`model download attempt ${i}/${attempts} failed${limited ? " (rate limited)" : ""}: ${err}; retrying in ${delay}s`);' \
    '    await new Promise(r => setTimeout(r, delay * 1000));' \
    '  }' \
    '}' \
    > /app/warm.mjs && \
    node /app/warm.mjs && \
    rm /app/warm.mjs && \
    mkdir -p /model-cache && \
    cp -a /tmp/hf-model-cache/. /model-cache/ && \
    find /model-cache -exec touch -h -d '@1' {} +

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS production

LABEL org.opencontainers.image.source="https://github.com/ythril-network/Ythril"
LABEL org.opencontainers.image.description="Ythril — self-hosted brain & knowledge management platform"
LABEL org.opencontainers.image.licenses="PolyForm-Small-Business-1.0.0"

# NO python3/make/g++ here any more — the toolchain lives in the `prod-deps` stage and the compiled addon is
# copied in below. That removes a 755 MB layer from the shipped image, and with it a layer that changed digest
# on every release for no reason anyone wanted: `apt-get update` is not reproducible, so it was re-downloaded on
# every pull even when nothing about it had changed.
#
# ffmpeg, for the audio/video media embedding pipeline.
#
# LICENSING, corrected 2026-08-04 — this comment used to claim "LGPL-2.1+ core only (no GPL codecs)" and told
# the reader to verify that `--enable-gpl` was absent. Running that check disproves it: **Debian builds ffmpeg
# WITH `--enable-gpl`**, so the binary shipped here is GPL-2.0-or-later. It reported the same in the released
# 2.2.5 image, so the stated verification cannot ever have been run — the comment asserted the opposite of the
# artefact while naming the command that would have caught it.
#
# Why it is still fine to ship, and it is the same argument NOTICE already makes for LibreOffice in the
# doc-office sidecar: the executable is invoked as a SEPARATE PROCESS (`spawn('ffmpeg', …)` in
# files/media/{audio,video}-embedder.ts), never linked into Ythril. What that argument does NOT cover is
# redistribution of the binary itself, which needs attribution and a corresponding-source offer — now present
# in NOTICE under "Bundled Binary: FFmpeg". It had been missing entirely.
#
# Asserted by `testing/standalone/ffmpeg-licensing-is-stated.test.js` so the claim and the artefact cannot drift
# apart again in either direction.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json* ./
COPY server/package.json ./server/

# The production dependency tree, already installed and already compiled, from a stage that had a compiler.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules

# The embedding model, baked in so first startup is instant and needs no network.
#
# ## Why this is a mounted copy and not a `COPY --from`
#
# MEASURED, and the obvious form does not work. Four builds of a minimal reproduction, forcing the copy to
# re-execute with a changed upstream stage:
#
#     COPY --from=warm /model-cache /app/model-cache   → layer digest CHANGED
#     COPY marker.txt ./            (7 bytes!)         → layer digest CHANGED
#     RUN --mount=from=warm … + stamp tree AND parent  → layer digest IDENTICAL
#
# The reason a 7-byte COPY moves is the whole finding: **adding an entry to a directory bumps that directory's
# mtime, and the bumped parent ships in the same layer as the payload.** Stamping the copied tree cannot reach
# `/app`, so 482.5 MiB moves because of one directory timestamp — the same shape as the old warm step, which
# created and deleted `/app/server/warm.mjs` and so put `/app/server`'s mtime in the model's layer.
#
# So: mount the warmed tree (the download stays out of this layer, which is the point of the `model-warm` stage),
# copy it in, and stamp every entry the layer contains, `/app` included. The changeset is then fully determined by
# the model bytes, and a rebuild — for a dependency bump, an apt layer, a new release — re-materialises the same
# digest. That is what makes a pull skip it.
#
# `/app`'s mtime being 1970 in this layer is invisible: the later COPYs write to `/app` again and set their own.
#
# Ownership is set INSIDE this RUN. A later `chown -R` would rewrite the whole tree into a second layer — that is
# exactly how the published image came to ship the embedding model twice.
ENV MODEL_CACHE_DIR=/app/model-cache
RUN --mount=from=model-warm,source=/model-cache,target=/mnt/model-cache \
    mkdir -p /app/model-cache && \
    cp -a /mnt/model-cache/. /app/model-cache/ && \
    chown -R node:node /app/model-cache && \
    find /app/model-cache -exec touch -h -d '@1' {} + && \
    touch -h -d '@1' /app

# No model may be fetched at RUN TIME. Set after the warm step above, which is the one place a download
# is legitimate — it happens on a build machine, once, and its result is what ships.
#
# `env.allowRemoteModels` defaults to TRUE in @huggingface/transformers, so before this a cache MISS
# silently downloaded from huggingface.co: the instance's IP and the model id it asked for, to a third
# party, with no configuration, from an image whose README says "works fully offline". Exactly one model
# is baked in, so every other id — and every id at all on an install with an empty cache — was that request.
#
# `HF_HUB_OFFLINE` is the ecosystem's name for this and is already set on the `unstructured` sidecar in
# docker-compose.yml, for the same reason. transformers.js does not read it (it is Python's), so
# `brain/embedding.ts` maps it onto `env.allowRemoteModels` itself.
#
# This cannot break the bundled model: transformers.js consults its FileCache BEFORE deciding local vs
# remote, so the baked `/app/model-cache` satisfies the load. Verified against a real populated cache —
# the default model loads with remote fetching disabled; a model that is NOT baked fails with a message
# naming this flag. An operator who deliberately wants a different model sets `HF_HUB_OFFLINE=0`.
ENV HF_HUB_OFFLINE=1

# Copy compiled output from builder
COPY --from=builder /build/server/dist ./server/dist

# Copy compiled Angular SPA from client-builder
COPY --from=client-builder /build/client/dist/browser ./client/dist/browser

# The licence and the third-party notices, INSIDE the image.
#
# They were not here, and the image is the primary distribution — most users never see the git repo. That made the
# one place the notices are legally required the one place they were absent:
#
#   - Apache-2.0 §4(d): a distribution of a work that carries a NOTICE file "must include a readable copy of the
#     attribution notices contained within such NOTICE file". Ythril redistributes several Apache-2.0 works in this
#     image — @huggingface/transformers, sharp, and the embedding model weights themselves.
#   - MIT: "The above copyright notice and this permission notice shall be included in all copies or substantial
#     portions of the Software." An image is a copy.
#
# A few KB, in the app layer where it belongs. Found by the Legal & Compliance audit lens; asserted by
# `notice-ships-in-the-image`.
COPY NOTICE LICENSE ./

ENV NODE_ENV=production
ENV PORT=3200
ENV CONFIG_PATH=/config/config.json
ENV DATA_ROOT=/data
ENV CLIENT_DIST=/app/client/dist/browser

EXPOSE 3200

# Pre-create mount-point directories owned by node so volume mounts are writable.
#
# `/app/model-cache` is NOT chowned here, and that is the point. A `chown -R` rewrites every file's metadata, so
# Docker copied the whole 482.5 MiB model tree into a SECOND layer — the published image shipped the embedding
# model TWICE, in every tag, on every pull. Measured against the registry: layer 10 was the model at 482.5 MiB and
# layer 13 was this chown at exactly 482.5 MiB, which no `mkdir` of two empty directories can account for.
#
# The ownership is set inside the RUN that creates the cache instead, so it lands in that one layer.
# `/data` and `/config` are empty, so chowning them costs nothing.
RUN mkdir -p /data /config && chown -R node:node /data /config

# Run as non-root user
USER node

CMD ["node", "server/dist/index.js"]

# The commit the image was built from, readable with `docker image inspect` (Q-294). scripts/owner-instance.ps1
# rebuilds the owner's instance after a Docker wipe from a worktree at the commit it recorded and passes it here,
# so the rebuilt image says which commit it is. The LAST instructions of the stage on purpose: a build arg
# invalidates the cache of every instruction after the point it is used, and here there is none.
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

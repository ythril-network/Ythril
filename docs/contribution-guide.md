# Ythril Contribution Guide

> How to set up a development environment, run tests, and ship releases.

Audience: developers and maintainers working on Ythril source code.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Layout](#repository-layout)
3. [Development Setup](#development-setup)
4. [Building](#building)
5. [Testing](#testing)
6. [Container Images](#container-images)
7. [Releasing a New Version](#releasing-a-new-version)
8. [Engineering Principles](#engineering-principles)
9. [Code Style](#code-style)
10. [Commit Conventions](#commit-conventions)
11. [Pull Request Checklist](#pull-request-checklist)
12. [License](#license)

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22+ |
| npm | 10+ (ships with Node 22) |
| Docker | 24+ with Compose v2 |
| Git | 2.40+ |

MongoDB is not installed locally — it runs inside Docker via `mongodb/mongodb-atlas-local` (includes `mongot` for `$vectorSearch`).

---

## Repository Layout

```
ythril/
├── client/          Angular 21 SPA (workspace: @ythril/client)
├── server/          Express 5 + TypeScript API (workspace: @ythril/server)
├── testing/
│   ├── integration/ API scenario tests
│   ├── red-team-tests/ Security attack simulations
│   ├── standalone/  Unit-level tests (no Docker)
│   └── sync/        Multi-instance sync tests (3 containers)
├── config/          Runtime config (bind-mounted into container)
├── docs/            Project documentation
├── docker-compose.yml          Production compose
├── testing/docker-compose.test.yml  Test compose (3 instances)
├── Dockerfile       Multi-stage build (client → server → production)
├── package.json     Root workspace manifest
└── tsconfig.base.json  Shared TypeScript config
```

npm workspaces: the root `package.json` declares `["server", "client"]`. All `npm` commands should be run from the repo root using `--workspace=` flags.

---

## Development Setup

```bash
# Clone
git clone https://github.com/ythril-network/Ythril.git
cd Ythril

# Install all dependencies (both workspaces)
npm install

# Start development server (hot-reload via tsx watch)
npm run dev

# In a separate terminal, start the Angular dev server with proxy
cd client && npm start
```

The Angular dev server proxies `/api`, `/mcp`, `/setup`, `/health`, and `/ready` to `localhost:3200` via `proxy.conf.json`.

For development you still need a MongoDB instance. The easiest way is running just the database from the compose file:

```bash
docker compose up -d ythril-mongo
```

Then set the env var before starting the dev server:

```bash
MONGO_URI=mongodb://localhost:27017/?directConnection=true npm run dev
```

---

## Building

### Server (TypeScript → JavaScript)

```bash
npm run build:server          # Compiles server/src → server/dist
```

### Client (Angular production build)

```bash
npm run build:client          # Outputs to client/dist/browser/
```

### Both

```bash
npm run build                 # Server then client
```

### Docker image

```bash
npm run docker:build          # docker compose build + prune cache
```

The Dockerfile is a three-stage build:

1. **client-builder** — installs client deps, runs `ng build --configuration production`
2. **builder** — installs server deps (incl. native bcrypt), compiles TypeScript
3. **production** — `node:22-slim`, copies compiled server + client SPA + embedding model, runs as non-root `node` user on port 3200

---

## Testing

All tests use Node.js built-in `node --test` — no extra test framework.

### Standalone tests (no Docker required)

```bash
npm run test:standalone
```

Covers: config reload, config loader normalisation, config file permissions, log redaction, metrics endpoint, OIDC contracts, OIDC silent refresh, quota logic, rate-limit bucketing, readiness probe, secrets permissions, schema validation (ReDoS protection, $options sanitisation, operator whitelist), theme API, theme postMessage tokens, vector search detection.

### Integration tests (single Docker instance)

```bash
# Start the primary instance
docker compose up -d

# Run tests against localhost:3200
npm run test:integration
```

Covers: setup gating, auth, files, spaces, brain CRUD (memories, entities, edges, chrono), schema validation (strict/warn/off, bulk, dry-run), networks, voting, invite handshake, MCP tools (including bulk_write), notifications, about endpoint, sync history, space rename, space deletion, space export, space wipe, conflict resolution, proxy spaces.

### Sync tests (three Docker instances)

```bash
# Start all three instances + provision tokens
npm run test:up

# Run sync suite
npm run test:sync

# Tear down
npm run test:down
```

Covers: closed-network sync, braintree governance, democratic voting, pubsub topology, gossip exchange, conflict detection, file sync, entity/edge sync, fork/merge, Merkle verification, vote propagation, direction enforcement, leave/removal.

### Red-team tests

```bash
npm run test:redteam
```

Attack simulations: auth bypass, path traversal, MongoDB injection ($options injection, operator whitelist), space boundary, oversized payload, invite replay, SSRF (IPv4/IPv6, network members), sequence injection, mass assignment, token brute-force, sync scope bypass, MCP security (token hygiene, input validation, operator injection), direction enforcement, space rename.

### Run everything

```bash
npm run test:all
```

`test:all` now enforces cleanup automatically (`test:down:clean`) even if a suite fails. If you need containers and volumes left intact for debugging, use:

```bash
npm run test:all:keep
```

**Rule:** All tests must pass before merging. A failing red-team test is treated as a security regression.

---

## Container Images

Published images are available on two registries:

| Registry | Image |
|----------|-------|
| GitHub Container Registry | `ghcr.io/ythril-network/ythril` |
| Docker Hub | `docker.io/ythril/ythril` |

### Tag scheme

Every release produces four tags:

| Tag | Example for `v1.0.0` |
|-----|-----------------------|
| Full version | `1.0.0` |
| Minor | `1.0` |
| Major | `1` |
| Latest | `latest` |

### Architectures

All images are multi-arch manifests covering `linux/amd64` and `linux/arm64`.

### Pulling

```bash
# GHCR (default in docker-compose.yml)
docker pull ghcr.io/ythril-network/ythril:latest

# Docker Hub
docker pull ythril/ythril:latest
```

### Switching registries in docker-compose.yml

The default compose file uses GHCR:

```yaml
services:
  ythril:
    image: ghcr.io/ythril-network/ythril:latest
```

To use Docker Hub instead:

```yaml
services:
  ythril:
    image: ythril/ythril:latest
```

To build locally from source (contributor workflow):

```yaml
services:
  ythril:
    build: .
```

Or keep the `image:` line and override on the CLI:

```bash
docker compose up -d --build
```

---

## Releasing a New Version

Images are built and pushed automatically by the CI workflow (`.github/workflows/publish.yml`) when a version tag is pushed.

### Steps

1. Update `version` in `package.json`, `server/package.json`, and `client/package.json`.

2. Commit and tag:

   ```bash
   git add -A
   git commit -m "release: v1.0.0"
   git tag v1.0.0
   git push origin main --tags
   ```

3. GitHub Actions builds for `linux/amd64` + `linux/arm64` and pushes to both GHCR and Docker Hub.

### Required GitHub secrets

| Secret | Purpose |
|--------|---------|
| `DOCKERHUB_USERNAME` | Docker Hub account username |
| `DOCKERHUB_TOKEN` | Docker Hub access token (not password) |

GHCR authentication uses the built-in `GITHUB_TOKEN` — no extra secret needed.

### Post-first-publish

After the first image push to GHCR, set the package to **Public** at:

```
https://github.com/orgs/ythril-network/packages/container/ythril/settings
```

---

## Engineering Principles

Every line of code in this repository is held to six non-negotiable standards. No shortcut is justified by team size, current scale, or deadline pressure.

### 1. Security

Ythril is designed for ISO 27001-class environments. Security is not a phase — it is a property of every commit.

- **Validate at the boundary, trust internally.** Every public endpoint validates input with Zod schemas before any logic runs. Internal function calls between modules do not re-validate.
- **Defence in depth.** A single control is never the only thing standing between an attacker and a breach. Input validation, SSRF checks, path-traversal guards, rate limits, and audit logging each operate independently.
- **Cryptographic choices are non-negotiable.** AES-256-GCM for secrets at rest. RSA-4096-OAEP for invite payloads. bcrypt cost-12 for token hashes. HMAC-SHA256 for webhook signatures. `crypto.timingSafeEqual` for all constant-time comparisons. No weaker alternatives.
- **No dynamic evaluation.** No `eval()`, no `Function()` constructors, no template-string code generation. User input never reaches a code path that interprets it as executable.
- **Secrets never appear in logs.** The log-redaction layer strips tokens, passwords, and keys before they reach stdout. Red-team tests verify this.
- **SSRF protection is mandatory** for any feature that makes outbound HTTP requests using user-supplied URLs. Resolve the hostname, reject private/link-local/loopback ranges, reject non-HTTP(S) schemes. The `validateUrl()` utility exists for this — use it.
- **Every security-adjacent change must pass red-team tests.** A failing red-team test is treated as a security regression, not a flaky test.

### 2. Scalability

The codebase targets production deployments with large datasets and high concurrency. Single-instance convenience must never create a scalability ceiling.

- **No unbounded queries.** Every database query that could return an arbitrary number of documents uses a `limit`. Pagination is the default; fetching "all" is the exception and must be explicitly justified.
- **No unbounded recursion or chain walks.** Any traversal (graphs, fork chains, nested structures) must have a hard depth cap with a visited-set cycle guard. The `forkChainDepth()` pattern in `sync.ts` is the reference implementation.
- **Indexes exist for every query pattern.** When adding a new `find()` or `countDocuments()` call, ensure a supporting index exists or create one. Queries that scan entire collections are rejected in review.
- **Streaming over buffering.** File transfers use streams. Large response sets are paginated. No endpoint loads an entire collection into memory.
- **Rate limits protect every public surface.** The rate-limit middleware is applied to all route groups. Limits are tuned per-endpoint based on expected traffic, not a global catch-all.
- **Background work uses bounded workers.** Retry queues, webhook delivery, and cleanup jobs use capped concurrency and MongoDB-backed scheduling — not in-memory timers or `setTimeout` chains.

### 3. Stability

A production Ythril instance must survive ungraceful conditions without operator intervention.

- **Never crash on transient failures.** Database disconnects, upstream timeouts, and malformed peer messages are handled with retries or structured error responses — never `process.exit()`. The HTTP server binds unconditionally at startup; it does not wait for database readiness.
- **Typed errors, not string matching.** Error routing uses typed error classes (`NotFoundError`, `ValidationError`) caught by the Express error handler. String-based error detection (`err.message.includes(...)`) is not permitted.
- **TTL indexes for all time-series data.** Audit logs, webhook delivery records, and any other append-only collection must use MongoDB TTL indexes with configurable retention. Documents carry an `_expireAt` field set at write time; the TTL index uses `expireAfterSeconds: 0`.
- **Graceful shutdown.** The process handles `SIGTERM` by stopping new request acceptance, draining in-flight requests, flushing pending writes, and then exiting. Background workers (retry loops, sync timers) have explicit `stop()` methods wired into the shutdown sequence.
- **Static imports only in request handlers.** Top-level `import` statements are resolved at startup. Dynamic `await import()` inside request handlers adds latency on every call and creates non-deterministic module-resolution failures — it is not permitted.

### 4. State-of-the-Art

Dependencies, language features, and architectural patterns stay current. "It works" is not sufficient — it must be the modern way to do it.

- **Current Node.js LTS, current framework versions.** The project tracks Node.js 22+, Express 5, Angular 21, TypeScript 5.9 strict mode, MongoDB driver 7+. When a major version ships, migration happens proactively — not when forced by deprecation.
- **Use platform APIs before reaching for libraries.** Node.js `crypto`, `fs/promises`, `node:test`, `node:assert` are preferred over third-party equivalents. A new dependency must justify itself against what the platform already provides.
- **TypeScript strict mode is mandatory.** `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals: true`. No `// @ts-ignore`. `as never` casts are acceptable only for the MongoDB driver's generic limitations and must be commented.
- **No deprecated APIs.** If a library marks an API as deprecated, migrate immediately — do not add a TODO.
- **Zod for runtime validation.** No hand-written validators, no `joi`, no `class-validator`. Zod schemas are the single source of truth for request shapes.

### 5. Cleverness (Simplicity Over Cleverness)

Code should be boring to read. Clever tricks create maintenance debt.

- **Explicit over implicit.** No metaprogramming, no runtime prototype manipulation, no dynamic property injection. If a module needs a function, it imports it by name.
- **Flat over nested.** Guard-clause early returns instead of deeply nested `if/else` trees. Each handler reads top-to-bottom: validate → authorize → execute → respond.
- **No abstractions for one-time operations.** A helper function earns its existence by being called from at least two sites. Single-use wrappers add indirection without value.
- **Error messages are for operators.** Every error response includes enough context to diagnose the issue without reading source code. `"spaceId 'x' not found"` over `"not found"`.
- **Comments explain why, not what.** The code should be self-documenting for *what* it does. Comments are reserved for non-obvious constraints, security rationale, and performance justifications.

### 6. Legal

Ythril ships under the PolyForm Small Business License 1.0.0. Every contribution must respect this.

- **No copyleft-contaminated code dependencies in shipped Node packages.** GPL and AGPL dependencies are not permitted in the application dependency tree. Runtime infrastructure (for example MongoDB deployment options) must be documented explicitly in [Dependencies](dependencies.md), with licensing impact explained.
- **License header awareness.** Third-party code snippets adapted into the codebase must have their original license noted in the `NOTICE` file.
- **No proprietary service lock-in.** Features must work with self-hosted infrastructure. Cloud-managed services (Atlas, S3, etc.) may be supported as optional backends but never as the only path.
- **NOTICE file stays accurate.** When adding or removing a dependency that requires attribution, update `NOTICE` in the same commit.

---

## Code Style

- **TypeScript** — strict mode, ES2022 target, NodeNext modules.
- **Server** — Express 5, Zod for validation, no ORMs (raw MongoDB driver).
- **Client** — Angular 21, standalone components, signals over observables where possible.
- No mocking in tests — all tests run against real Docker containers.
- Validate at system boundaries; trust internal code.
- No temp fixes, no lazy implementations. State-of-the-art from day one.

---

## Commit Conventions

Use conventional-commit-style prefixes:

| Prefix | Use |
|--------|-----|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `security:` | Security fix |
| `docs:` | Documentation only |
| `test:` | Test additions or fixes |
| `refactor:` | Code restructuring (no behaviour change) |
| `release:` | Version bump + tag |

---

## Pull Request Checklist

- [ ] All existing tests pass (`npm run test:all`)
- [ ] If debugging failures, use `npm run test:all:keep` and clean up afterwards
- [ ] New features have corresponding tests
- [ ] Red-team tests still pass after security-adjacent changes
- [ ] `npm run build` succeeds cleanly (server + client)
- [ ] Documentation updated in `docs/` if applicable
- [ ] No secrets, tokens, or credentials in the diff

---

## License

Ythril is licensed under the **PolyForm Small Business License 1.0.0**. By contributing, you agree that your contributions are licensed under the same terms. See [LICENSE](../LICENSE) for the full text.

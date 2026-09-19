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
9. [UI Primitives](#ui-primitives)
10. [Code Style](#code-style)
11. [Commit Conventions](#commit-conventions)
12. [Pull Request Checklist](#pull-request-checklist)
13. [License and contributor agreement](#license-and-contributor-agreement)

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

## Before You Change Something Load-Bearing

Read [`docs/decisions.md`](decisions.md). It records the calls that are expensive or impossible to reverse —
why PDF rasterisation avoids the obvious library, why SSRF is checked twice, why the image refuses to fetch a model
at runtime — and each record names **the reversal it exists to prevent**.

They are short, and they are there because the reasoning used to live only in code comments and in working notes
that are gitignored. If a change of yours contradicts one, that is not automatically wrong — but it needs its own
record rather than arriving inside an unrelated commit.

## Repository Layout

```text
ythril/
├── client/          Angular 21 SPA (workspace: @ythril/client)
├── server/          Express 5 + TypeScript API (workspace: @ythril/server)
├── sidecars/        First-party sidecars (doc-render: PDF → page PNGs for the F11 VLM extraction path)
├── testing/
│   ├── _init/       Test bootstrap (config reset, sync-token provisioning)
│   ├── integration/ API scenario tests
│   ├── red-team-tests/ Security attack simulations
│   ├── standalone/  Unit-level tests (no Docker)
│   └── sync/        Multi-instance sync tests (4 Ythril instances; the test stack is 9 containers total — 4 Ythril + 4 Mongo + doc-render)
├── kubernetes/      K8s manifests (Ythril + ollama/whisper/unstructured sidecars, NetworkPolicies)
├── scripts/         Build, setup, and maintenance scripts
├── config/          Runtime config (bind-mounted into container)
├── docs/            Project documentation
├── docker-compose.yml          Production compose
├── testing/docker-compose.test.yml  Test compose (4 instances — a/b/c + migration-lock d)
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

The Angular dev server proxies `/api`, `/mcp`, `/setup`, `/health`, and `/ready` to `localhost:3210` via `proxy.conf.json`. Note the port: `proxy.conf.json` targets **3210**, but `npm run dev` starts the API on its default port **3200**. Run the server on 3210 so the proxy can reach it:

```bash
PORT=3210 TRUST_PROXY=1 npm run dev
```

`TRUST_PROXY=1` is required when the server runs bare behind `ng serve`: the dev proxy adds an `X-Forwarded-For` header (`xfwd: true`), and with trust proxy off `express-rate-limit` rejects **every** API call with a 500 (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`).

For development you still need a MongoDB instance, and you must provide your own — the bundled `ythril-mongo` from `docker-compose.yml` publishes **no host ports** and sits on an `internal: true` network (a deliberate security hardening), so it is intentionally unreachable from the host. Point `MONGO_URI` at a developer-provided MongoDB instead:

```bash
# Option A — a local mongod listening on 127.0.0.1:27017
MONGO_URI=mongodb://127.0.0.1:27017/?directConnection=true PORT=3210 TRUST_PROXY=1 npm run dev
```

Or, to reuse the bundled container, expose its port with a dev-only `docker-compose.override.yml` that publishes `27017` and drops the `internal` flag — never commit that override, and keep it out of any deployed environment.

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

Server-side and integration tests use Node.js' built-in `node --test` runner — no extra framework. The **client** has its own unit suite built on **Vitest + jsdom**.

### Before you push

```bash
npm run preflight
```

Runs every structural gate that does **not** need Docker — icon registry, scheduler wiring, route guards, audit-route coverage, the four documentation gates, docs lint, and the client suite (which includes i18n key coverage). Seconds, no containers.

These are grouped into one command because they share a property: **each catches something that produces no error, no failed build and no failed unit test.** An unregistered icon renders as a blank space. A scheduler nobody starts looks like one with nothing to do. A documented endpoint that doesn't exist returns a 404 with nothing to explain it. A translation key missing from `de`/`pl` renders the raw key.

Deciding *which* of those applies to a given change is exactly the judgement people get wrong at the end of a long task — a PR shipped a blank icon that way, past a green docs lint, 685 green client tests and a green production build. Run the lot; it's cheap.

Docker-dependent suites (integration, sync, red-team) still run in CI.

### Client unit tests (no Docker required)

```bash
npm run test:client          # → vitest run
```

Runs the Angular component/service specs under `client/` in a jsdom environment. This suite runs in CI as the dedicated **"Client unit tests"** step (`.github/workflows/ci.yml`).

#### Characterization tests before a refactor

Before splitting or restructuring a large component, add a `*.characterization.spec.ts` next to it and prove it against the **original** file, in its own commit or PR. A characterization test written against already-restructured code pins the new behaviour, which tells you nothing about whether the restructure preserved anything.

Two conventions make these worth the effort:

- **Record what the code does today, not what it should do.** Where behaviour is surprising, say so in the comment and pin it anyway — that turns a later "tidy-up" into a visible decision instead of a silent change. `graph.component.characterization.spec.ts` is the worked example.
- **Validate the suite by mutation.** A test that passes both before and after a change is worth nothing. Apply plausible refactor slips to the original one at a time (drop a cache guard, loosen an `&&` to `||`, remove a fallback) and confirm each one fails the suite. Anything that survives is a gap in the tests, not a harmless mutation.

At the rendering boundary, pin the **model** handed to the library rather than the library's output — e.g. the element list given to cytoscape, not what it draws. That lets the renderer move without the tests moving with it.

That leaves one thing the model cannot tell you: whether the library still implements what the model names. A renderer typically **discards an unknown property in silence**, so a style the code sets, the tests pin and the comments describe can be doing nothing at all. The graph set `shadow-*` for as long as it had existed — cytoscape 2 properties, removed in cytoscape 3 — behind an `as any` on each style block that stopped the compiler from mentioning it. Prefer the library's own typings over a cast, and where a cast is genuinely unavoidable, check the property against the shipped bundle (`graph-styles-exist-in-cytoscape` does this). A gate of that shape needs a **positive control**: one that cannot read the bundle at all reports success in exactly the same way as one that finds no problems.

### Standalone tests (no Docker required)

```bash
npm run test:standalone
```

Covers: config reload, config loader normalisation, config file permissions, log redaction, metrics endpoint, OIDC contracts, OIDC silent refresh, quota logic, rate-limit bucketing, readiness probe, secrets permissions, schema validation (ReDoS protection, $options sanitisation, operator whitelist), theme API, theme postMessage tokens, vector search detection.

### Integration tests (single Docker instance)

```bash
# Start the primary instance. NOTE: the `ythril` service in docker-compose.yml has no
# `build:` stanza — a bare `docker compose up -d` runs the PUBLISHED image
# (ghcr.io/ythril-network/ythril:latest), NOT your local working tree. To test local code,
# build the image yourself and point compose at it (e.g. an override with a `build: .` on the
# `ythril` service, or `docker build -t ghcr.io/ythril-network/ythril:latest .` first).
docker compose up -d

# Run tests against localhost:3200
npm run test:integration
```

Covers: setup gating, auth, files, spaces, brain CRUD (facts, entities, edges, chrono), schema validation (strict/warn/off, bulk, dry-run), networks, voting, invite handshake, MCP tools (including bulk_write), notifications, about endpoint, sync history, space rename, space deletion, space export, space wipe, conflict resolution, proxy spaces.

#### Rate-limit kill-switches

A test run makes thousands of requests from one IP, so the limiters have to come off. Three env vars do
that, and they are honoured **only when `NODE_ENV !== 'production'`**:

| Variable | Disables |
|---|---|
| `SKIP_AUTH_RATE_LIMIT` | the login / TOTP limiter |
| `SKIP_GLOBAL_RATE_LIMIT` | the general API limiter |
| `SKIP_SYNC_RATE_LIMIT` | the peer-sync limiter |

The production check is not belt-and-braces: these limiters are the **only** throttle in front of admin
TOTP verification, so a leaked value — a copy-pasted compose file, a shared `.env` — must not be able to
switch them off on a live instance. Setting any of them also logs a loud warning at startup, so a
misconfigured non-production deployment says so rather than quietly running unthrottled.

### Sync tests (four Docker instances)

```bash
# Start all four instances + provision tokens
npm run test:up

# Run sync suite
npm run test:sync

# Tear down
npm run test:down
```

Covers: closed-network sync, braintree governance, democratic voting, pubsub topology, gossip exchange, conflict detection, file sync, entity/edge sync, fork/merge, Merkle verification, vote propagation, vote signing &amp; safe relay, signing-key rotation, vote forgery rejection, tombstone forgery rejection, direction enforcement, leave/removal.

### Red-team tests

```bash
npm run test:redteam
```

Attack simulations: auth bypass, path traversal, MongoDB injection ($options injection, operator whitelist), space boundary, oversized payload, invite replay, SSRF (IPv4/IPv6, alternate host encodings, network members), sequence injection, mass assignment, token brute-force, sync scope bypass, MCP security (token hygiene, input validation, operator injection), auth escalation (MCP proxy member-space scope, MFA setup/disable gating, token-minting scope), direction enforcement, space rename.

### Run everything

```bash
# Start the test stack FIRST — test:all does NOT bring it up.
npm run test:up

npm run test:all
```

> **`test:all` does not start the Docker stack.** It runs `test:all:core`
> (integration → sync → red-team → standalone) and then `test:down:clean`, but there is
> no `test:up` inside it. On a fresh checkout the integration and sync suites fail
> (nothing is listening on `localhost:3200`) unless you run `npm run test:up` first.

`test:all` enforces cleanup automatically (`test:down:clean`) even if a suite fails. If you need containers and volumes left intact for debugging, use:

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

```text
https://github.com/orgs/ythril-network/packages/container/ythril/settings
```

---

## Engineering Principles

Every line of code in this repository is held to six non-negotiable standards. No shortcut is justified by team size, current scale, or deadline pressure.

### 1. Security

Ythril is designed for ISO 27001-class environments. Security is not a phase — it is a property of every commit.

- **Validate at the boundary, trust internally.** Every public endpoint validates input with Zod schemas before any logic runs. Internal function calls between modules do not re-validate.
- **Defence in depth.** A single control is never the only thing standing between an attacker and a breach. Input validation, SSRF checks, path-traversal guards, rate limits, and audit logging each operate independently.
- **Cryptographic choices are non-negotiable.** AES-256-GCM for secrets at rest. RSA-4096-OAEP for invite payloads. Ed25519 for governance vote-cast signatures. bcrypt cost-12 for token hashes. HMAC-SHA256 for webhook signatures. `crypto.timingSafeEqual` for all constant-time comparisons. No weaker alternatives.
- **No dynamic evaluation.** No `eval()`, no `Function()` constructors, no template-string code generation. User input never reaches a code path that interprets it as executable.
- **Secrets never appear in logs.** The log-redaction layer strips tokens, passwords, and keys before they reach stdout. Red-team tests verify this.
- **SSRF protection is mandatory** for any feature that makes outbound HTTP requests using user-supplied URLs. `util/ssrf.ts` provides the layers: `isSsrfSafeUrl()` for a synchronous config-time string check (rejects non-HTTP(S) schemes, embedded credentials, and blocked addresses in every encoding — decimal/hex/octal/short-form IPv4, IPv4-mapped IPv6, ULA/link-local), and `assertUrlSafeResolved()` / `ssrfSafeFetch()` for the authoritative use-time check that resolves DNS, validates every resolved A/AAAA record, and re-validates each redirect hop. Never `fetch()` a user-supplied URL directly — use `ssrfSafeFetch()`.
- **Every security-adjacent change must pass red-team tests.** A failing red-team test is treated as a security regression, not a flaky test.

### 2. Scalability

The codebase targets production deployments with large datasets and high concurrency. Single-instance convenience must never create a scalability ceiling.

- **No unbounded queries.** Every database query that could return an arbitrary number of documents uses a `limit`. Pagination is the default; fetching "all" is the exception and must be explicitly justified.
- **No unbounded recursion or chain walks.** Any traversal (graphs, fork chains, nested structures) must have a hard depth cap with a visited-set cycle guard. The `forkChainDepth()` pattern in `sync.ts` is the reference implementation.
- **Indexes exist for every query pattern.** When adding a new `find()` or `countDocuments()` call, ensure a supporting index exists or create one. Queries that scan entire collections are rejected in review.
- **Streaming over buffering.** File transfers use streams. Large response sets are paginated. No endpoint loads an entire collection into fact.
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

### 7. Migrations & data evolution

Choose a migration strategy by **whether the data syncs across networks**, because sync applies pulled records with a **whole-document `replaceOne` (last-writer-wins by `seq`)**, not a field-level merge (`server/src/sync/engine.ts`).

- **Synced data → self-healing (lazy), never a one-time boot migration.** The per-space MongoDB record collections that replicate across networks — facts, entities, edges, chrono, links, `{space}_files`, and their fields — can be silently reverted by a **mixed-version peer**: an older-version instance that rewrites a record with a higher `seq` replaces the *whole* document and undoes any boot migration. So don't migrate these on boot — **repair or derive the field on access**, so it re-heals after any cross-version clobber. Examples: token prefixes backfilled on first use (`index.ts`); a file's raw size (`sizeBytes`) re-`stat`'d from disk when a record lacks it.
- **Local, non-synced state → an idempotent boot migration is fine.** State the single instance owns and no peer overwrites — `config.json` (loader migrations), at-rest state-file encryption, index creation (`createIndex`/TTL) — converges once on boot and stays. Keep it idempotent (a no-op once applied) so re-running is free.
- **A stored-field rename on a synced collection is the fragile case.** It changes the wire format, so mixed-version peers see a blank for the name they don't know until everyone upgrades. Do it only at a major release, document it as breaking, and prefer pairing it with a self-healing field for anything that must stay correct.

---

## UI Primitives

Client work has a shared component set — `settings-card`, `status-pill`, `summary-strip`,
`relative-time`, `usage-bar`, the confirm dialog and `ph-icon`. Each of them replaced two or three
divergent implementations of the same idea, so **reach for one before writing new markup**: a bespoke
badge on one page becomes the next thing someone has to reconcile.

They were discoverable only by reading a page that happened to use one, which is exactly how a fourth
badge dialect gets written. The API of each, with the page-PR checklist that goes with them, is in
**[UI Primitives](ui-primitives.md)**.

---

## Code Style

- **TypeScript** — strict mode, ES2022 target, NodeNext modules.
- **Server** — Express 5, Zod for validation, no ORMs (raw MongoDB driver).
- **Client** — Angular 21, standalone components, signals over observables where possible.
- **Client is fully zoneless** — zone.js has been removed. There is no zone-driven change-detection safety net, and heavy pages run with `OnPush`, so all async state must flow through **signals**, the **`AsyncPipe`**, or explicit change detection (`ChangeDetectorRef`/`markForCheck`). Mutating a field imperatively after an `await` will not repaint the view.
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
- [ ] Client unit tests pass (`npm run test:client`)
- [ ] If debugging failures, use `npm run test:all:keep` and clean up afterwards
- [ ] New features have corresponding tests
- [ ] Red-team tests still pass after security-adjacent changes
- [ ] `npm run build` succeeds cleanly (server + client)
- [ ] Documentation updated in `docs/` if applicable
- [ ] No secrets, tokens, or credentials in the diff

---

## License and contributor agreement

Ythril is distributed under the **PolyForm Small Business License 1.0.0**. See [LICENSE](../LICENSE) for the full text.

**Contributing requires signing the [Contributor License Agreement](../CLA.md).** It is a licence, not an assignment: **you keep the copyright in everything you write.** What you grant is a licence broad enough for the project to be maintained, redistributed, and — this is the operative part — **licensed to others under different terms in future**, whether commercial, a different open licence, or both.

Signing is one click on your first pull request, via a bot, and it covers every contribution you make afterwards. There is nothing to print and nothing to repeat.

**Why this replaced the previous wording.** This section used to say only that "your contributions are licensed under the same terms". That reads as reassuring and was in fact the problem: a contribution arriving under PolyForm Small Business does **not** carry the right to sublicense or relicense it, so the one sentence that looked like it settled the question was the sentence that would have made a future relicence require the individual agreement of every past contributor. The CLA grants that right explicitly and up front, which is the whole point of having one.

If a term in the CLA is a blocker for you, open an issue and say so.

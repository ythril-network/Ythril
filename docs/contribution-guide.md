# Ythril Contribution Guide

> How to set up a development environment, run tests, and ship releases.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Layout](#repository-layout)
3. [Development Setup](#development-setup)
4. [Building](#building)
5. [Testing](#testing)
6. [Container Images](#container-images)
7. [Releasing a New Version](#releasing-a-new-version)
8. [Code Style](#code-style)
9. [Commit Conventions](#commit-conventions)
10. [Pull Request Checklist](#pull-request-checklist)
11. [License](#license)

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

Covers: config reload, log redaction, quota logic, rate-limit bucketing, secrets permissions.

### Integration tests (single Docker instance)

```bash
# Start the primary instance
docker compose up -d

# Run tests against localhost:3200
npm run test:integration
```

Covers: setup gating, auth, files, spaces, brain CRUD, networks, voting, invite handshake, MCP tools, notifications, about endpoint, sync history.

### Sync tests (three Docker instances)

```bash
# Start all three instances + provision tokens
npm run test:up

# Run sync suite
npm run test:sync

# Tear down
npm run test:down
```

Covers: closed-network sync, braintree governance, democratic voting, gossip exchange, conflict detection, file sync, entity/edge sync, fork/merge, Merkle verification, vote propagation, leave/removal.

### Red-team tests

```bash
npm run test:redteam
```

Attack simulations: auth bypass, path traversal, MongoDB injection, space boundary, oversized payload, invite replay, SSRF, sequence injection, mass assignment, token brute-force, sync scope bypass.

### Run everything

```bash
npm run test:all
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

| Tag | Example for `v0.2.1` |
|-----|-----------------------|
| Full version | `0.2.1` |
| Minor | `0.2` |
| Major | `0` |
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
   git commit -m "release: v0.2.0"
   git tag v0.2.0
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
- [ ] New features have corresponding tests
- [ ] Red-team tests still pass after security-adjacent changes
- [ ] `npm run build` succeeds cleanly (server + client)
- [ ] Documentation updated in `docs/` if applicable
- [ ] No secrets, tokens, or credentials in the diff

---

## License

Ythril is licensed under **AGPL-3.0-only**. By contributing, you agree that your contributions are licensed under the same terms. See [LICENSE](../LICENSE) for the full text.

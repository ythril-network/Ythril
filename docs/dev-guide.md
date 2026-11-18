# Dev guide

> How to set up a development environment, build Ythril from source and run its tests.

Audience: someone changing their own copy of Ythril. The licence allows that; it does not allow passing the changed copy on.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 22+ |
| npm | 10+ (ships with Node 22) |
| Docker | 24+ with Compose v2 |
| Git | 2.40+ |

MongoDB is not installed locally — it runs inside Docker via `mongodb/mongodb-atlas-local` (includes `mongot` for `$vectorSearch`).

## Repository layout

```text
ythril/
├── client/          Angular 21 SPA (workspace: @ythril/client)
├── schema/          The space-schema vocabulary and validator, published for apps (workspace: @ythril-network/schema)
├── server/          Express 5 + TypeScript API (workspace: @ythril/server)
├── sidecars/        First-party sidecars (doc-render: PDF → page PNGs for the VLM extraction path)
├── testing/         Tests: integration, red-team-tests, standalone (most need no Docker), sync; docker-compose.test.yml
├── kubernetes/      K8s manifests (Ythril + ollama/whisper/unstructured sidecars, NetworkPolicies)
├── scripts/         Build, setup, test-time and maintenance scripts
├── tools/flow-checks/  Probes run against a running instance (axe-core accessibility scans)
├── config/          Runtime config (bind-mounted into container)
├── docs/            Project documentation
├── docker-compose.yml  Production compose
├── Dockerfile       Multi-stage build (client → server → production)
└── package.json     Root workspace manifest
```

npm workspaces: the root `package.json` declares `["schema", "server", "client"]`. Run `npm` commands from the repo root with `--workspace=` flags.

## Development setup

```bash
git clone https://github.com/ythril-network/Ythril.git
cd Ythril
npm install                 # all workspaces
npm run dev                 # API with hot-reload (tsx watch)
cd client && npm start      # in a second terminal: the Angular dev server with proxy
```

The Angular dev server proxies `/api`, `/mcp`, `/setup`, `/health`, and `/ready` to `localhost:3210` via `proxy.conf.json`. Note the port: `proxy.conf.json` targets **3210**, but `npm run dev` starts the API on its default port **3200**. Run the server on 3210 so the proxy can reach it:

```bash
PORT=3210 TRUST_PROXY=1 npm run dev
```

`TRUST_PROXY=1` is required when the server runs bare behind `ng serve`: the dev proxy adds an `X-Forwarded-For` header (`xfwd: true`), and with trust proxy off `express-rate-limit` rejects **every** API call with a 500 (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`).

For development you still need a MongoDB instance, and you must provide your own — the bundled `ythril-mongo` from `docker-compose.yml` publishes **no host ports** and sits on an `internal: true` network (a deliberate security hardening), so it is intentionally unreachable from the host. Point `MONGO_URI` at a developer-provided MongoDB instead, for example a local `mongod` on `127.0.0.1:27017`:

```bash
MONGO_URI=mongodb://127.0.0.1:27017/?directConnection=true PORT=3210 TRUST_PROXY=1 npm run dev
```

Or reuse the bundled container with a dev-only `docker-compose.override.yml` that publishes `27017` and drops the `internal` flag; keep it out of any deployed environment.

## Building

```bash
npm run build:server    # Compiles schema/src → schema/dist, then server/src → server/dist
npm run build:client    # Outputs to client/dist/browser/
npm run build           # Server then client
npm run docker:build    # docker compose build + prune cache
```

The server imports `@ythril-network/schema` from `schema/dist`, and its `prebuild` and `predev` compile the package first. A change to a schema body, a limit or a rule check is a change to `schema/src`; `server/src` re-exports it and defines none of it.

The Dockerfile is a three-stage build:

1. **client-builder** — installs client deps, runs `ng build --configuration production`
2. **builder** — installs server deps (incl. native bcrypt), compiles TypeScript
3. **production** — `node:22-slim`, copies compiled server + client SPA + embedding model, runs as non-root `node` user on port 3200

## Tests

Run `npm run preflight` first: it runs every structural gate that needs neither Docker nor the test database, plus the client suite, and stops at the first failing stage. `npm run preflight:static` is the shorter form for the moment between edits. [`testing-guide.md`](testing-guide.md) is the reference for everything else: how to run each suite, the test stack, skips and waits, and how CI is put together and cached.

A test run makes thousands of requests from one IP, so the rate limiters have to come off. These env vars do that, and they are honoured **only when `NODE_ENV !== 'production'`**:

| Variable | Disables |
|---|---|
| `SKIP_AUTH_RATE_LIMIT` | the login / TOTP limiter |
| `SKIP_GLOBAL_RATE_LIMIT` | the general API limiter |
| `SKIP_SYNC_RATE_LIMIT` | the peer-sync limiter |

The production check is not belt-and-braces: these limiters are the first throttle in front of admin TOTP verification, so a leaked value — a copy-pasted compose file, a shared `.env` — must not be able to switch them off on a live instance. No skip turns the second-factor lockout off: five wrong codes lock a token, whatever these say.

## Building the image from source

The `ythril` service in `docker-compose.yml` has no `build:` stanza, so a bare `docker compose up -d` runs the published image, not your working tree. To build from source, override the service:

```yaml
services:
  ythril:
    build: .
```

Or keep the `image:` line and run `docker compose up -d --build`.

---

Ythril takes no outside code; bug reports and ideas go to the [issue tracker](https://github.com/ythril-network/Ythril/issues).

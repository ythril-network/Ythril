# Hosting

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Hosting

### Containers

The Docker Compose stack runs two containers:

| Container | Role |
|-----------|------|
| `ythril` | Brain server — REST API, MCP endpoints, Angular web UI (port 3200) |
| `ythril-mongo` | MongoDB Atlas Local with `mongot` sidecar for `$vectorSearch` (default) |

On first start, MongoDB needs to elect a replica set primary (up to ~3 minutes). The server prints the startup banner when ready.

### MongoDB Flexibility

Ythril requires a MongoDB instance that supports the `$vectorSearch` aggregation stage for semantic recall.  Any of the following work:

| MongoDB flavour | `$vectorSearch` | Notes |
|---|---|---|
| `mongodb/mongodb-atlas-local` (default) | ✓ | Bundled in `docker-compose.yml`; zero-config for new deployments |
| Managed MongoDB Atlas (M10+) | ✓ | Set `MONGO_URI` to your Atlas connection string |
| MongoDB 8.2+ (community / enterprise) | ✓ | Native support — no `mongot` sidecar required |
| MongoDB < 8.2 (vanilla) | ✗ | `recall` tool disabled; all other features work |

**Using an existing MongoDB 8.2+ cluster** — remove the `ythril-mongo` service from `docker-compose.yml` and point `MONGO_URI` at your cluster. Include the database name in the URI path (recommended):

```yaml
environment:
  MONGO_URI: mongodb://mongodb-0.example.com:27017/ythril?directConnection=true
```

**Using managed Atlas** — provide the `mongodb+srv://` connection string with the database name:

```yaml
environment:
  MONGO_URI: mongodb+srv://user:pass@cluster0.example.mongodb.net/ythril?retryWrites=true
```

> **Database name:** Ythril reads the database name from the path component of `MONGO_URI`. If no database name is specified in the URI, it falls back to `"ythril"`. All operations — including dump/restore — use the resolved name.

On startup, Ythril probes for `$vectorSearch` support and logs the result:

```text
  ✓ $vectorSearch available (MongoDB 8.2.1)
```

or, if unavailable:

```text
  ✗ $vectorSearch not available (MongoDB 7.0.0) — semantic search (recall) will be disabled
    Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas
```

If `$vectorSearch` is unavailable, all non-search operations (storing memories, entities, edges, files, sync) continue to work normally.  Only the `recall` MCP tool returns an error until a supported MongoDB is connected.

### Startup Output

**First run:**

```text
  ythril  ·  first-run setup required

  Open http://localhost:3200 to get started
```

**Configured:**

```text
  ythril  ✓ ready  ·  http://localhost:3200
```

### Debug Logging

```bash
DEBUG=1 docker compose up
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `/config/config.json` | Path to config file inside container |
| `DATA_ROOT` | `/data` | Root directory for file storage |
| `MONGO_URI` | `mongodb://ythril-mongo:27017/ythril?directConnection=true` | MongoDB connection string — any `$vectorSearch`-capable MongoDB works. The database name in the URI is used for all operations. |
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `3200` | HTTP listen port |
| `CLIENT_DIST` | (resolved from the image layout) | Directory the built Angular client is served from. Set by the Dockerfile; override it only when running the server against a client build in a non-standard location — a local dev checkout, or an image you re-layered. |
| `MODEL_CACHE_DIR` | `/app/model-cache` in the image, else `<DATA_ROOT>/.model-cache` | Where the bundled in-process embedding model's weights are cached. Baked into the image so a cold start does not download them; the `DATA_ROOT` fallback is for running from source. Point it at a persistent volume if you strip the cache out of your image, or **every** boot re-downloads the model. |
| `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` / `YTHRIL_MODELS_OFFLINE` | `1` in the image, unset when running from source | Forbid fetching a model at runtime. Any of the three, set to anything other than `0`/`false`/`no`/empty, stops the in-process embedding model from reaching `huggingface.co`: a model that is not in `MODEL_CACHE_DIR` fails to load, with an error naming the cache and this flag, instead of being downloaded. The first two are the names the wider ecosystem uses (Python's `huggingface_hub` reads them, and `docker-compose.yml` already sets `HF_HUB_OFFLINE` on the `unstructured` sidecar); transformers.js reads none of them, so Ythril maps them itself. Set `HF_HUB_OFFLINE=0` in the image if you deliberately want to switch to a model it does not carry. |
| `DEBUG` | (unset) | Set to `1` for verbose logging |
| `MONGO_CONNECT_RETRY_MS` | `30000` | How long the **first** MongoDB connection may spend retrying before boot gives up. A container orchestrator's healthcheck can report MongoDB healthy while it is still finishing startup, so the first driver connection can have its socket reset mid-handshake — which used to kill the process outright. Only "not up yet" failures are retried (network errors, server selection, topology closed); bad credentials and a malformed URI fail immediately, because waiting cannot help and retrying would turn a clear error into a boot that appears to hang. Backoff is jittered so several instances starting together do not retry in lockstep. |
| `SHUTDOWN_DRAIN_MS` | `8000` | How long in-flight HTTP requests get to finish after SIGTERM before their connections are forced shut. On SIGTERM the server stops accepting new connections, waits for the running ones, then flushes config and closes MongoDB. The default is sized for **Docker's 10 s stop grace period** — the whole drain plus the flush has to fit inside it or the container is SIGKILLed mid-write anyway. Kubernetes allows 30 s by default, so raise this if your orchestrator gives you longer. |
| `SHUTDOWN_READY_GRACE_MS` | `2000` | How long to keep serving after `/ready` starts returning **503**, before the drain begins. On SIGTERM the server reports not-ready immediately so an orchestrator takes it out of rotation; this is the window for a readiness probe to notice. Kubernetes' default probe period is 10 s, so some probes will miss a 2 s window — raise it if your rolling updates still drop requests. **Set it to `0` on a single-instance deployment**: there is no load balancer to inform and the wait is pure delay. Comes out of the same stop-grace budget as `SHUTDOWN_DRAIN_MS`. `/health` (liveness) keeps returning 200 throughout — a liveness probe that fails on SIGTERM invites a SIGKILL mid-drain. |
| `RECALL_BUDGET_MS` | `25000` | End-to-end budget for one recall call. Every hop runs in series — embed the query, the per-type vector searches, the lexical channel, the cross-encoder — and each has its own timeout with nothing watching the total. This sits under the ~30 s a typical MCP client waits, so the server stops working before the caller stops listening. It is a **budget, not a hard abort**: the only hop it can cancel is the reranker, because that is the only optional one. |
| `RERANK_MIN_BUDGET_MS` | `3000` | Below this much remaining budget the reranker is **skipped** rather than started, and recall returns the fused order. Starting a cross-encoder pass that cannot finish burns time that was needed to return the answer; a slightly worse ranking delivered beats a perfect one the caller has already given up on. The skip is logged. |
| `METRICS_TOKEN` | (unset) | When set, `GET /metrics` requires this exact value as a Bearer token — the recommended path for Prometheus scrape configs. If unset, the endpoint falls back to requiring a valid admin PAT. |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting (overrides the `trustProxy` config key). Default `false` — `req.ip` comes from the socket. **Set this when running behind a reverse proxy**, to the exact number of proxy hops (e.g. `1`), *not* `true` (which trusts the whole `X-Forwarded-For` chain and is client-spoofable). Also accepts `loopback` or a comma-separated CIDR/IP list. Rate limiting and the audit log key on `req.ip`, so a wrong value here is a security setting. |
| `SYNC_ALLOW_PRIVATE_PEERS` | `false` | Allow sync **peer URLs** to resolve to private/reserved addresses (RFC-1918, CGNAT, IPv6 ULA) — for same-host or LAN networks (overrides the `allowPrivatePeers` config key). Default `false`: sync connects only to public peers, and any peer that tries to move its URL onto a private address is refused. Even when `true`, crown-jewel addresses (loopback, link-local / cloud IMDS `169.254.169.254`, unspecified) stay blocked. |
| `MCP_OAUTH_TOKEN_TTL_DAYS` | `90` | Lifetime (in days) of PATs minted by the MCP OAuth browser-connector flow. Tokens expire after this many days, so an abandoned connector leaves no permanent credential behind; the connector re-consents when its token lapses. Each connector holds **one** token that a fresh consent rotates (never accumulates), and the total connector-token count is capped. Set to `0` to disable expiry (tokens never expire) if you need long-lived connector credentials. |

### A Malformed Setting Stops the Boot

Every numeric setting in the table above is **validated at start-up**, before the config file is read. A value
that is present but not a whole number in range makes the instance refuse to start, naming every offender at once:

```text
[ERROR] Refusing to start: 2 environment settings are malformed.
[ERROR]   • SHUTDOWN_DRAIN_MS="8OOO" is not usable — it is not a number. It sets how long in-flight requests
          get after SIGTERM, and must be a whole number between 0 and 300000.
[ERROR]   • RECALL_BUDGET_MS="30_000" is not usable — it is not a number. …
```

An **empty** value means "not set" and uses the documented default, which is the usual way to clear a setting in a
compose file. Surrounding whitespace is ignored, so a YAML block scalar cannot break a value.

This is deliberately a refusal rather than a fallback, because **a typo is never a preference.** These were read
with an unchecked `Number()`, so a mistyped value became `NaN` — and `NaN` does not fail, it quietly changes
behaviour. Measured:

| a typo in | did | so |
|---|---|---|
| `SHUTDOWN_DRAIN_MS` | `setTimeout(fn, NaN)` fires after **0 ms** | the graceful drain did not drain: in-flight requests were cut off at SIGTERM |
| `MONGO_CONNECT_RETRY_MS` | `elapsed < NaN` is **false** | zero retries, so a MongoDB that was still starting killed the boot |
| `EMBEDDING_DIMENSIONS` | serialises as **`null`** | the vector index was created with a null dimension |
| `RECALL_BUDGET_MS` | every comparison **false** | the recall budget silently stopped applying |

Two of those are guarantees this guide documents, lost without a word. `PORT` was the one already safe — Node
refuses `listen(NaN)` outright — and that is now the behaviour of all of them.

### Data Persistence

All persistent data lives in named Docker volumes:

| Volume | Contents |
|--------|----------|
| `ythril-data` | File storage (`/data/files/{spaceId}/`), upload chunks, media/face-model files |
| `ythril-mongo-data` | Brain data: memories, entities, edges, tombstones |
| `ythril-mongo-configdb` | MongoDB replica set keyfile |

The `config/` directory is a host bind mount — `config.json`, `secrets.json`, and `schema-library.json` are plain files that survive any container lifecycle event.

> **Backup note:** All three files are required for a complete restore. `schema-library.json` holds the instance-level schema library; spaces using `$ref: "library:<name>"` will have broken validation if this file is missing after a restore.

### Config File Permissions

On startup, Ythril checks that `config.json` and `secrets.json` are owner-read/write only (`0600`). If the files have looser permissions (e.g. `0644`, `0666`), the server automatically tightens them to `0600` and logs a `SECURITY:` warning:

```text
SECURITY: config.json had mode 0644 — auto-fixed to 0600
```

If auto-fix fails (e.g. the process doesn't own the file), the server logs an error and exits. This is common with Docker bind mounts on WSL2, where host files appear world-writable inside the container — the auto-fix handles this case transparently.

```bash
docker compose down        # stops containers — data intact
docker compose up -d       # reattaches volumes — picks up where it left off
docker compose down -v     # ⚠ permanently deletes all named volumes
```

### Encryption at Rest

Ythril's state files — `config.json`, `secrets.json`, `schema-library.json`, `schema-catalogs.json` —
can be **encrypted at rest** so that a stolen file, or a co-tenant reading the volume on shared hardware,
is useless without the key. (This covers the app's own files; brain data in MongoDB is isolated per tenant
by running each instance against its own encrypted `mongod` — see [Running Multiple Brains on One Host](#running-multiple-brains-on-one-host).)

Provide a **master secret via the environment** (never written to disk) and encryption turns on
transparently:

| Variable | Meaning |
|---|---|
| `YTHRIL_MASTER_KEY` | 32 raw bytes as base64 or 64 hex chars — used directly. Generate: `openssl rand -base64 32`. |
| `YTHRIL_MASTER_PASSPHRASE` | Any passphrase; a per-file scrypt salt is stored in the encrypted file. Used only if `YTHRIL_MASTER_KEY` is unset. |
| `YTHRIL_REQUIRE_ENCRYPTED_AT_REST` (or config `requireEncryptedAtRest`) | Refuse to boot unless a master secret is configured. |

- Files use **AES-256-GCM** (authenticated); a wrong key or a tampered file fails to decrypt and the
  instance refuses to start rather than silently continue.
- **Automatic migration:** if a key is configured and a file is still plaintext (e.g. after upgrading),
  it is encrypted **in place** at the next boot — round-trip verified first, with no plaintext copy left
  behind. New installs write encrypted from the first save.
- **Back up the master secret.** Losing it makes the encrypted files unrecoverable — that is the point.
  Deliver it as a Docker/Kubernetes/systemd secret, not baked into an image.
- **What this does NOT cover**, stated here because the section title invites the wider reading:
  - **uploaded files** under `<data-root>/files/` are stored as they arrived;
  - **database backups** under `<data-root>/backups/` are plaintext NDJSON — a dump reads *through* `mongod`, so an
    encrypted `mongod` does not protect it either. See
    [POST /api/admin/data/backup](12-admin-api.md#post-apiadmindatabackup);
  - **brain data in MongoDB itself** — that is the encrypted-`mongod` job described below.

  Ythril writes everything in the first two categories `0600`/`0700` — files owner-read/write, directories
  owner-only — so it is not readable by other users on the host or by another container sharing the mount, and
  `requireEncryptedAtRest` deliberately does not claim otherwise. That covers uploads, the chunk staging area a
  resumable upload passes through, local backups, and offsite copies, from one definition in `util/fs-modes.ts`.

  **On upgrade this heals rather than migrating.** A `mode:` argument only applies when a file is created, so files
  that predate this keep their old permissions until something rewrites them — re-uploading, editing or moving a file
  tightens it. There is no boot-time walk of the files tree, because on a large instance that is exactly the
  expensive migration that ends up skipped. To tighten everything at once:

  ```bash
  # inside the container, or against the mounted volume on the host
  find /data/files /data/backups -type d -exec chmod 700 {} + -o -type f -exec chmod 600 {} +
  ```

```yaml
# docker compose — master key from a secret/env, kept out of the image
services:
  ythril:
    environment:
      YTHRIL_MASTER_KEY: "${YTHRIL_MASTER_KEY:?set a 32-byte base64 key}"
      YTHRIL_REQUIRE_ENCRYPTED_AT_REST: "true"
```

### Runtime Model Downloads

**The published image never fetches a model at runtime, and that is enforced rather than assumed.**

Ythril's in-process embedding model is baked into the image at `/app/model-cache`, and the image sets
`HF_HUB_OFFLINE=1`. Only one model is baked in — `nomic-ai/nomic-embed-text-v1.5`, the default — so this
matters the moment you change it.

Without the flag, the underlying library (`@huggingface/transformers`) allows remote model loading by
default. A cache **miss** is then a download from `huggingface.co`, which carries **your instance's IP
address and the model id it asked for** to a third party. Nothing configured it and nothing announced it.
That is the behaviour the flag turns off.

What each situation does now:

| situation | behaviour |
|---|---|
| the image, default model | loads from the baked cache — no network, ever |
| the image, a model id it does not carry | **fails to load**, with an error naming `MODEL_CACHE_DIR` and this flag |
| the image with `HF_HUB_OFFLINE=0` | downloads on a miss, and **logs a warning first** naming the host, the model, and the size |
| from source, empty cache | downloads on first use, with the same warning — this is how you populate a cache |

The flag does **not** disable the bundled model: the library consults its on-disk cache *before* deciding
local-versus-remote, so a populated `MODEL_CACHE_DIR` satisfies the load with downloads switched off.

To use a different local model on an offline instance, populate the cache rather than opening the egress:

```bash
# On a machine WITH internet. Same image, same cache layout the offline instance expects,
# so nothing has to be assembled by hand.
WARM='import("./server/dist/brain/embedding.js").then(m => m.warmEmbeddingModel())'

docker run --rm -v "$PWD/cache:/cache" -e MODEL_CACHE_DIR=/cache -e HF_HUB_OFFLINE=0 -e EMBEDDING_MODEL=<model-id> ghcr.io/ythril-network/ythril node -e "$WARM"

# Then mount ./cache at MODEL_CACHE_DIR on the offline instance, set EMBEDDING_MODEL to the
# same id, and leave HF_HUB_OFFLINE=1. The load is a cache hit and never touches the network.
```

Changing the embedding model **invalidates every existing vector**, so plan the
[reindex](04d-brain-ops-api.md#reindex-space) that has to follow it.

Other model-loading components are separate processes with their own controls: the vision model is pulled
by **Ollama** when you start it, and the speech model by the **faster-whisper** sidecar. Both are containers
you run, and both pull at *their* start-up rather than mid-request. The `unstructured` sidecar's layout
models are baked into its image and it runs with `HF_HUB_OFFLINE=1` on an internal network with no route out.

**Every sidecar ceiling is raisable from `.env`, and none of them requires editing `docker-compose.yml`.**
Each container that carries a memory, CPU or process limit reads it from a variable with a default:
`OLLAMA_*`, `WHISPER_*` and `UNSTRUCTURED_*` for the model and extraction services, and for the two
document sidecars `DOC_RENDER_MEM_LIMIT`, `DOC_RENDER_PIDS_LIMIT`, `DOC_RENDER_CPUS`,
`DOC_OFFICE_MEM_LIMIT`, `DOC_OFFICE_PIDS_LIMIT` and `DOC_OFFICE_CPUS`. A job that exceeds its memory ceiling is OOM-killed, which
surfaces as a failed caption, transcription or extraction rather than a hung stack — so if large or dense
documents are failing, that is the first thing to check. The full list with defaults is in
[`docs/dependencies.md`](../dependencies.md).

### Security Posture Check

At boot Ythril prints an aggregated **security posture** — one `✓`/`⚠`/`✗` line per check across transport
(TLS enforcement, peer scheme, `trustProxy`), encryption at rest, and MongoDB auth — so a weak setting is
visible in the logs instead of silently accepted. Admins can also fetch it live:

```http
GET /api/about/security      # admin token
→ { "checks": [ { "id": "transport.tls", "level": "warn", "message": "…" }, … ], "worst": "warn", "strict": false }
```

**Component liveness** is a separate, admin-only endpoint:

```http
GET /api/about/health        # admin token
→ { "level": "degraded", "down": ["doc-render"], "components": [ { "id": "doc-render", "configured": true, "reachable": false, "impact": "…" }, … ] }
```

`level` is `ok`, `degraded`, or `unknown`, and it is **reporting, never gating**:

- Everything probed here is **optional** — the render sidecars are opt-in, and the NLI judge ships with no endpoint at all. A component the operator never configured reports `configured: false` and does **not** count as a fault; otherwise the panel would be permanently yellow.
- A configured component that is unreachable is `degraded`, never "down". It degrades a feature, it does not stop the instance serving.
- `reachable: null` means the probe could not run, which is reported as `unknown` rather than folded into `degraded` — "we could not check" and "it is broken" want different responses.

**This is not `/ready`.** `/ready` is the orchestration probe and gates on MongoDB and vector search only. Adding an optional sidecar to it would let a dead render container pull a healthy instance out of the load balancer — turning a degraded feature into an outage.

Levels are `pass` / `warn` / `fail` (`fail` = actively broken, e.g. `requireEncryptedTransport` on without
`trustProxy`, so requests would 403). Set **`security.strict`** (config) or **`YTHRIL_SECURITY_STRICT=true`**
to make any `fail` finding abort boot — the aggregate "don't start if misconfigured" switch, on top of the
individual `require*` flags.

### Diagnosing a Misconfiguration

*New in 2.1.*

Most deployment problems here are **configuration that looks correct and is refused**, not crashes. The
instance is designed so you never have to guess which: three endpoints answer three different questions,
and every refusal names the setting that would permit it.

#### Start here, in this order

| Ask | Endpoint | Answers | Does **not** answer |
|---|---|---|---|
| 1. Is my config coherent? | `GET /api/about/security` | Which settings conflict, which are unused, which would break something | Whether anything is reachable |
| 2. Are my components reachable? | `GET /api/about/health` | Per-component `configured` / `reachable` / `impact` | Whether the instance should serve traffic |
| 3. Should this pod take traffic? | `GET /ready` | MongoDB + vector search only | Anything about sidecars or models — **by design** |

`/ready` deliberately ignores optional components. Folding a dead render sidecar into it would let a
degraded feature pull a healthy instance out of the load balancer.

##### What `/ready` returns, and why it says so little

`/ready` and `/health` are registered **before every authentication middleware** — they have to be, an orchestrator
cannot carry a token — so both are **public**. That is why a failing check reports a **code**, never the underlying
driver message:

```json
{
  "ready": false,
  "checks": {
    "mongodb": { "status": "error", "reason": "unreachable" },
    "vectorSearch": { "status": "ok" }
  }
}
```

| `reason` | Meaning | What to check |
|---|---|---|
| `unreachable` | wrong host or port, firewall, DNS failure, connection refused or reset | connectivity to MongoDB |
| `timeout` | reachable, but did not answer inside 2 s | load on the database |
| `auth_failed` | credentials rejected | the user/password in `MONGO_URI` |
| `not_primary` | connected to a secondary, so writes would fail | replica-set state |
| `unsupported` | the server answered but lacks something required (e.g. no vector search) | MongoDB flavour and version |
| `error` | nothing more specific matched | **the server log** |

**The full message is in the log**, once per transition — a Kubernetes probe runs every few seconds, so repeating
it on every failed poll would bury everything else:

```text
[WARN ] Readiness: mongodb is failing (unreachable) — getaddrinfo ENOTFOUND mongo-a.internal
[INFO ] Readiness: mongodb recovered
```

Before this, the driver's message was returned in the response and logged **nowhere** — so the detail went to
whoever probed the endpoint, including anyone who could reach it, and an operator watching the logs of a failing
pod saw silence. A code is also the more useful thing for a probe: it is stable enough to alert on, which a driver
message never was.

#### The single most useful habit: read the posture block

It prints at boot and is live at `GET /api/about/security`. Every line is written to be actionable — a
`warn` or `fail` names the setting, the observed value, and what changes if you act. Two conventions
worth knowing, because they are easy to misread:

- **"nothing is using the permission; unset it"** means exactly that: the flag is on and provably
  unnecessary. Acting on it is safe.
- **"not resolved here"** means the opposite of a verdict. The posture check is synchronous and does
  **not** resolve DNS — resolving at boot would hang the block on a slow resolver. An endpoint written as
  a hostname is reported as `(hostname, not resolved here)`, and on a cluster where everything is a
  `*.svc.cluster.local` name, *none* of them will be counted as private. **That is not evidence the
  permission is unused.** Only endpoints written as IP literals can be classified from config alone.

#### Symptom → where to look

| Symptom | First check | Usual cause |
|---|---|---|
| A model endpoint is refused with `Blocked SSRF target` | the `warn` line the guard logged | private address without `allowPrivateModelEndpoints` |
| Endpoint refused, and the address it names is `169.254.*` / loopback | same | a crown-jewel address — **no** flag permits these |
| Endpoint refused with `DNS returned no records` | cluster DNS | not a policy decision at all; the name did not resolve |
| Nobody can sign in after enabling OIDC | `oidc.issuer` in the posture block | private issuer without `oidc.allowPrivateIssuer` |
| MCP works with a bearer token, browser connectors will not authorize | `mcp.publicUrl` in the posture block | `publicUrl` unset → loopback issuer |
| A setting in the UI is read-only | `lockedByInfra` in `GET /api/admin/media-config` | an env var is pinning it |
| A value in your manifest has no effect | startup log | you set a legacy env var alias *and* its replacement |
| Every API call 403s behind a proxy | `transport.trustProxy` in the posture block | `requireEncryptedTransport` on without `trustProxy` |

#### Every egress refusal is logged

An SSRF refusal writes one `warn` line naming the target, the address it resolved to, and the setting
that would permit it — so a blocked endpoint is diagnosable from `kubectl logs`, not only from whatever
a dialog happened to show:

```text
WARN  Blocked SSRF target (vllm.models.svc.cluster.local resolves to blocked address 10.1.2.4)
      — if this address is meant to be reachable, set allowPrivateModelEndpoints
      (YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS=true) for a self-hosted model endpoint, or
      allowPrivatePeers for a sync peer
```

The line is redacted like any other, so a key in a query string is not echoed into your log collector.

Grep for `Blocked SSRF target` to see every refusal at once. If your endpoint fails and **nothing** is
logged, the failure is not the egress guard — look at `GET /api/about/health` instead.

#### Why one endpoint works and another on the same subnet does not

Two private addresses in the same cluster can behave differently, and that is not a bug in your network:

- **Render/conversion sidecars** (`CONVERSION_SIDECAR_URL`, doc-render) are reached with a plain `fetch`.
  They are declared infrastructure, expected to be private, and are not subject to the egress guard.
- **Model provider endpoints** — every slot in the egress matrix below — go through the SSRF-guarded
  fetch, because those URLs are admin-settable and become egress targets.

#### Egress matrix — which model endpoints send content, and what guards them

An endpoint is only as private as the host it points at. This table is what actually happens, per slot.
`Guard` is the SSRF-guarded fetch (DNS resolution, IP pinning, redirect re-validation, crown-jewel ranges
blocked; the private-address permission lifts only the private-address refusal).

**It is complete, and a test keeps it that way.** `Slot key` is the identifier the code uses, and
`testing/standalone/egress-matrix.test.js` asserts this table's key column equals the server's own
`EGRESS_SLOTS` — the same list the per-slot permission and the security posture enumerate. The reason for
a gate rather than diligence: this table had **seven** rows while the code had ten, and the omission was
not cosmetic. `DOC_VLM_URL` was missing from the list of guarded endpoints above while the document VLM
was reaching an off-instance host with no guard at all — the doc stated the invariant the code had
broken, and nothing compared the two.

| Slot | Slot key | Env | Sends | Guard | Acknowledgement |
|---|---|---|---|---|---|
| Embedding | `embedding` | `EMBEDDING_URL` | record + query text | yes, when the provider is `external` | — |
| Vision (captions) | `vision` | `VISION_BASE_URL` | uploaded images | yes, when the provider is `external` | — |
| Speech-to-text | `stt` | `STT_BASE_URL` | uploaded audio | yes, when the provider is `external` | — |
| Reranker | `rerank` | `RERANK_URL` | the query **and** the passages it matched | yes, unless the URL is local | — |
| Contradiction judge | `nli` | `NLI_URL` | pairs of stored records | yes, unless the URL is local | — |
| **Document VLM** | `docVlm` | `DOC_VLM_URL`, `DOC_VLM_MODEL` | **rendered page images** | yes, unless it is the bundled model | — |
| Document repair | `docRepair` | `DOC_REPAIR_URL`, `DOC_REPAIR_MODEL` | draft transcription + OCR text | yes, unless it is the bundled model | — |
| Document verify | `docVerify` | `DOC_VERIFY_URL`, `DOC_VERIFY_MODEL` | draft transcription + OCR text | yes, unless it is the bundled model | — |
| Assist model | `assist` | `DOC_ASSIST_URL` | draft transcription + OCR text | yes, always | **required** |
| External face model | `faceExternal` | `FACE_RECOGNITION_EXTERNAL_MODEL` | **face crops (biometric data)** | yes, always | **required** |

Six things worth reading twice:

- **A cross-encoder must be one trained for QUESTION-to-passage relevance, and a weaker sibling of the right model is a regression rather than a smaller gain.**
  Measured on one corpus, same instance, same questions, same budget — only the model changed:

  | reranker | first answer right | within three |
  |---|---|---|
  | none | 45.7% | 60.9% |
  | `BAAI/bge-reranker-base` | **27.4%** | 45.2% |
  | `cross-encoder/ms-marco-MiniLM-L-6-v2` | **53.8%** | 64.0% |

  A cross-encoder's score REPLACES the retrieval's ordering, which is right when it knows better and
  catastrophic when it does not. The failing model saturated — 0.9958 for the right passage against 0.9969
  for a wrong one — so a difference of 0.001 overturned a vector margin of 0.100, and it did that
  confidently on every query. The one that worked separated the same pair 0.99997 against 0.653.

  The model this guide recommends, `BAAI/bge-reranker-v2-m3`, is NOT the failing one and ranks that same
  pair correctly. The trap is reaching for a smaller relative of it: `bge-reranker-base` is trained for
  passage-to-passage similarity, and on question-shaped queries it rates everything about the right subject
  as equally relevant.

  So: use `bge-reranker-v2-m3`, or a model from the MS MARCO family if you want something small enough to
  be comfortable on a CPU. And **measure it against no reranker on your own corpus before leaving it on** —
  there is no signal in the API that says a reranker is making things worse, because from the outside a
  worse ordering looks exactly like an ordering.

- **A reranker must accept 100 passages in one request, and the common self-hosted server does not by
  default.** One recall sends up to a hundred candidates in a single call, because the over-fetch IS
  the reranking mechanism — a cross-encoder can only reorder what the vector search already found.
  `text-embeddings-inference` caps a client batch at **32** unless you start it with
  `--max-client-batch-size 512`, and Ythril's request comes back `413`. The search still answers, ordered by
  meaning alone, and looks entirely reasonable; the only signs are a `WARN` in the log and
  `rerank_unavailable` in the answer's `degraded` array. If reranking appears to do nothing, check that
  array first.

- The **document VLM, repair and verify slots inherit the vision endpoint** when their own base URL is
  unset — so pointing vision at an external provider points all three there, and page images follow.
- **Two slots demand an explicit egress acknowledgement** before they will run: the assist model, because
  it is the path that sends document content off the instance; and the external face model, because its
  payload is biometric. Consent is keyed off the endpoint being *usable*, not off a tick, so it cannot be
  side-stepped by configuring an endpoint and acknowledging nothing.
- "Unless the URL is local" means the bundled/sidecar shape — loopback, or a bare hostname with no dot
  (a compose or cluster service name). Anything else is egress. An unparseable URL is treated as **not**
  local, so a malformed endpoint gets the guard rather than a bare fetch.
- Each slot's private-address permission is **its own** (`allowPrivateModelEndpointsBySlot`, or
  `YTHRIL_ALLOW_PRIVATE_<SLOT>`), resolved per-slot → instance-wide → closed. The full precedence rules
  are with the assist-model settings under
  [Document Processing Configuration](05a-conversion-pipeline.md#document-processing-configuration).

So a green sidecar next to a refused model endpoint tells you cluster DNS and reachability are fine, and
the difference is policy. That is the point at which `allowPrivateModelEndpoints` is the answer.

#### First boot takes longer than you expect

A cold start does work that no later start repeats: creating vector and lexical search indexes for each
space, and — on the bundled configuration — loading the in-process embedding model.

- **Subsequent boots:** a few seconds to ready.
- **First boot:** commonly **30–90 s**, and legitimately several minutes on a slow disk, a cold image
  pull, or a MongoDB that is itself still starting.

Size `startupProbe.failureThreshold × periodSeconds` to cover that, and let `livenessProbe` start only
after the startup probe succeeds. A startup budget tuned to the warm-boot time turns a normal first boot
into a crashloop, which then looks like a failure to start rather than a probe that was too impatient.

> **Upgrading to 2.1 from 2.0.x fixes a much worse version of this.** 2.0.0 reshaped existing vector
> indexes on startup and *waited* for each one to report READY — serially, with a 60-second ceiling per
> index. On an instance with a dozen spaces that was **over an hour of blocking startup**, enough to blow
> a 60-minute `startupProbe` budget and have a perfectly healthy upgrade killed mid-migration.
>
> From 2.1, index builds are confirmed **in the background**: boot completes in seconds, affected spaces
> report `indexStatus: "building"`, and each flips to `ready` when its build finishes. Semantic recall on
> a space that is still building returns no results until it completes — the same behaviour a
> newly-created space has always had. `INDEX_READY_TIMEOUT_MS` (default 10 minutes) bounds how long the
> background check waits before marking a space `failed`; raise it for very large collections.
>
> **If you are upgrading a 2.0.x instance with many spaces, upgrade straight to 2.1** rather than
> restarting 2.0.x, and there is no need to raise the startup budget for it.

Note also that a newly created space returns immediately with `indexStatus: "building"` — it is writable
at once, but semantic recall stays empty until the index finishes. That is expected, not a fault.

### Running Multiple Brains on One Host

You can run any number of Ythril instances on a single server. Each is a fully
independent brain — they know nothing about each other until you explicitly connect
them into a sync network. This is a supported and common topology (e.g. one instance
per team, project, or tenant, all behind subdomains like `a.ythril.example.com` and
`b.ythril.example.com`).

The **only** requirement is that each instance gets its own copy of three pieces of
state. There is no instance ID baked into collection names or file paths, so isolation
comes entirely from pointing each instance at distinct storage:

| Axis | Env var | What collides if two instances share it |
|---|---|---|
| **Database** | `MONGO_URI` (database name in the path) | All knowledge collections. Spaces are stored as collections named `<spaceId>_memories`, `<spaceId>_entities`, etc. — there is **no** per-instance prefix, so two instances on the same database that both have a space called `default` read and write the *same* `default_memories`. |
| **Config directory** | `CONFIG_PATH` | `config.json`, `secrets.json`, `schema-library.json`, `schema-catalogs.json` all live in this directory. Sharing it means each instance's config writes overwrite the other's tokens, spaces, and networks. |
| **Data root** | `DATA_ROOT` | File **bytes** live on the filesystem under `<DATA_ROOT>/files/<spaceId>/` (plus upload chunks and media/face-model files) — **not** in MongoDB. Sharing this directory collides the file stores the same way a shared database collides collections. |

Plus a distinct published **port** per instance.

**Multi-tenant on shared hardware — isolate cryptographically, not just logically.** If the tenants on
one host don't trust each other (e.g. you resell Ythril), give **each instance its own `mongod` on its
own encrypted volume with its own key** (LUKS/dm-crypt, a cloud encrypted disk, or MongoDB Enterprise
at-rest encryption) — do **not** share one `mongod` across tenants. Then one tenant cannot decrypt
another's data even with full disk access, because it's a different key and a different process, and
semantic search stays fully intact (each instance queries its own plaintext-in-memory data). Combine
with [Encryption at Rest](#encryption-at-rest) for the app's own state files and
[`requireEncryptedTransport`](#transport-security-encryption-in-transit) for the wire. "Same host" is
not a trust boundary; a co-tenant on loopback is still untrusted. Application-level field encryption in
a *shared* `mongod` is deliberately **not** offered — it would break vector/text recall (you can't
cosine-compare or regex encrypted values), so isolation lives at the storage boundary instead.

> **Common pitfall — the silent `ythril` fallback.** Ythril takes the database name
> from the *path* of `MONGO_URI`. If the path is empty (e.g.
> `mongodb://mongo:27017/?directConnection=true`), it falls back to `"ythril"`. So if
> you point two instances at the same MongoDB server and neither URI names a database,
> **both silently land in the `ythril` database and corrupt each other's data** — with
> no error and no warning, because neither instance can see the other's collections
> until they clash. Always put an explicit, distinct database name in each
> `MONGO_URI`.

#### Option A — separate stacks (each with its own bundled MongoDB)

Simplest, fully isolated by construction. Each brain is its own Compose project with its
own `ythril-mongo` service and volumes:

```bash
# Brain A — default, port 3200
docker compose up -d

# Brain B — separate project + compose file, port 3201
docker compose -p ythril-b -f docker-compose.brain-b.yml up -d
```

Keep the `config/` bind mount and data volume separate per brain (the `-p` project name
namespaces the named volumes automatically; give each its own `config/` host directory).

#### Option B — one shared MongoDB, a database per instance

Run a single MongoDB server (or cluster) and give each Ythril instance its **own
database** on it. This is exactly as isolated as separate machines — the database
boundary is a hard wall — while sharing one `mongod` and its RAM/cache overhead.

```yaml
services:
  ythril-a:
    image: ghcr.io/ythril-network/ythril:latest
    environment:
      MONGO_URI: mongodb://shared-mongo:27017/brain-a?directConnection=true   # ← distinct DB
      CONFIG_PATH: /config/config.json
      DATA_ROOT: /data
    volumes:
      - ./config-a:/config      # ← distinct host directory
      - ythril-data-a:/data     # ← distinct named volume
    ports:
      - "3200:3200"

  ythril-b:
    image: ghcr.io/ythril-network/ythril:latest
    environment:
      MONGO_URI: mongodb://shared-mongo:27017/brain-b?directConnection=true   # ← distinct DB
      CONFIG_PATH: /config/config.json
      DATA_ROOT: /data
    volumes:
      - ./config-b:/config
      - ythril-data-b:/data
    ports:
      - "3201:3200"

volumes:
  ythril-data-a:
  ythril-data-b:
```

Note that the `CONFIG_PATH` and `DATA_ROOT` *values* can be identical (`/config`,
`/data`) — what makes them distinct is the volume or bind mount behind each, since every
container has its own filesystem. If you instead run instances as **bare processes** on
the host (no containers), give each a genuinely different `CONFIG_PATH` and `DATA_ROOT`
path.

The shared MongoDB must be `$vectorSearch`-capable (see [MongoDB Flexibility](#mongodb-flexibility));
one capable server backs every database.

#### Networking co-located instances together

Instances on the same host can still form a sync network with each other. Because peer
URLs are SSRF-validated, address peers by a **resolvable public hostname** (e.g.
`https://a.ythril.example.com`), not `localhost` or a private/loopback IP — those are
rejected at member-add time. See
[Join Troubleshooting: private or local URLs rejected](08-networks-api.md#join-troubleshooting-private-or-local-urls-rejected).

### Recovery After Downtime

Networked brains reconnect automatically. On the next sync cycle after coming back up, each brain requests everything after its last recorded watermark. Tombstones propagate deletions that happened during downtime. No manual reconnection step required.

### Security Headers

Ythril sets the following headers on every response:

| Header | Value | Purpose |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `Content-Security-Policy` | `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; font-src 'self'` | Blocks cross-origin embedding, plugin injection, base-tag hijacking, and any font fetched from a third party — the UI serves its own, so an air-gapped instance renders correctly and no operator's IP reaches a font CDN. Cross-origin embedding is possible only by explicitly allowlisting origins under `embed.allowedOrigins` — see [Theme API](15-about-and-embedding.md#enabling-cross-origin-embedding-opt-in) |
| `Referrer-Policy` | `no-referrer` | Strips referrer on outbound requests |
| `X-Request-Id` | UUID | Unique per-request ID. **Every log line the request's own work produces carries it**, so this value is what you grep the server log for. |

**Compression**: Ythril compresses its own responses (gzip/deflate, negotiated per request) — you do not
need to configure it on a proxy, and enabling it there as well only re-compresses what is already
compressed. Measured on the shipped bundle: `main-*.js` 18 169 -> 6 504 bytes, `/metrics` 18 491 -> 3 132
bytes. **Server-Sent Events are deliberately excluded** (`/api/brain/spaces/:id/events`, the About
heartbeat): a compressor holds bytes back until it can emit a block, which turns a live stream into
batches. If you enable compression on a proxy in front, exclude `text/event-stream` there too.

**Caching**: content-hashed build assets (`main-<hash>.js`, `chunk-<hash>.js`, `styles-<hash>.css`) are
served `public, max-age=31536000, immutable`. Everything else — `index.html` above all, and the unhashed
`assets/i18n/*.json` — is `no-cache`, which still permits a `304` but never a stale read. Do not add a
blanket `Cache-Control` on your proxy: caching `index.html` pins a browser to chunk hashes that the next
release deletes, and the browser then requests JavaScript and gets HTML.

**HSTS**: Since Ythril does not terminate TLS itself, `Strict-Transport-Security` should be set on your reverse proxy (Traefik, Nginx, Caddy).

**CORS**: No `Access-Control-*` headers are set. The Angular SPA is served from the same origin, so cross-origin browser requests are blocked by default. If you need CORS for a custom frontend, configure it on your reverse proxy.

### TLS Termination

Ythril listens on plain HTTP. Place a reverse proxy in front to terminate TLS.

#### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name brain.example.com;

    ssl_certificate     /etc/letsencrypt/live/brain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/brain.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Event streams (brain changes, the log tail, and an MCP call the server answers as one SSE
        # frame) — disable buffering, or a client sees nothing until the response ends
        proxy_buffering off;
        proxy_cache     off;
        proxy_read_timeout 86400s;
    }

    client_max_body_size 512M;
}
```

#### Caddy

```caddyfile
brain.example.com {
    reverse_proxy localhost:3200
    header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
}
```

Caddy provisions TLS certificates automatically via Let's Encrypt/ZeroSSL.

#### Traefik (Docker labels)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.ythril.rule=Host(`brain.example.com`)"
  - "traefik.http.routers.ythril.entrypoints=websecure"
  - "traefik.http.routers.ythril.tls.certresolver=letsencrypt"
  - "traefik.http.services.ythril.loadbalancer.server.port=3200"
  - "traefik.http.middlewares.ythril-hsts.headers.stsSeconds=63072000"
  - "traefik.http.middlewares.ythril-hsts.headers.stsIncludeSubdomains=true"
  - "traefik.http.routers.ythril.middlewares=ythril-hsts"
```

### Transport Security (encryption in transit)

Ythril is secure-by-default on the wire, and adds an instance-wide switch to make TLS mandatory.

**Sync peers must use HTTPS.** A network member / invite URL is rejected unless it is `https://`. This
is deliberately independent of address: a peer on loopback or a private range is still required to be
HTTPS, because on shared hardware "same host" is **not** a trust boundary — a co-tenant reachable over
loopback is still untrusted. (Address reachability is governed separately by `allowPrivatePeers`.)

- To permit plaintext `http://` peers on a network where every peer *and* co-tenant is trusted, set
  `allowInsecurePeers: true` (or env `SYNC_ALLOW_INSECURE_PEERS=true`). This is a clear, explicit opt-out;
  new peers are HTTPS-only without it. A peer added before this default that is still `http://` continues
  to sync but logs a one-time warning each boot until you fix its URL or opt in.

**`requireEncryptedTransport` — instance-wide "encrypted only".** Set `requireEncryptedTransport: true`
(or env `REQUIRE_ENCRYPTED_TRANSPORT=true`) to enforce TLS everywhere:

- every inbound request must have arrived over HTTPS — plaintext requests get `403` (the `/health`,
  `/ready`, and `/metrics` probes stay reachable so orchestration isn't broken);
- `http://` sync peers are hard-blocked at admission **and** connection time, overriding
  `allowInsecurePeers`.

> **Requires `trustProxy`.** When a reverse proxy terminates TLS, Ythril only knows a request was
> encrypted from the `X-Forwarded-Proto` header, which it trusts **only** once `trustProxy` is set to your
> proxy hop count. Enable `requireEncryptedTransport` together with a correct `trustProxy`, or every
> proxied request will look plaintext and be rejected.

⚠️ **`allowInsecurePlaintext` is retired and does nothing.** If you have it in `config.json`, remove it.

In early versions it opted the instance *in* to a boot warning when the host had a non-loopback interface.
That warning was replaced by the startup security posture, and the key was left behind with no reader —
while the posture line written for it claimed it "disabled the plaintext-exposure guard", describing a
guard that never existed under that name. Setting it or clearing it changes nothing either way;
**`requireEncryptedTransport` above is the control that rejects plaintext requests.**

The key is still accepted so an existing config keeps loading, and the posture now reports it as retired
rather than as a disabled guard.

**Multi-tenant on shared hardware.** Run each tenant as its own Ythril instance with its **own MongoDB on
its own encrypted volume/key** — do not share one `mongod` across tenants. That keeps cross-tenant data
cryptographically isolated (different key + process) while leaving semantic search fully intact, and it
pairs with `requireEncryptedTransport` for encryption in transit.

### Resource Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 1 core | 2+ cores |
| RAM | 1 GB | 4 GB (MongoDB uses available RAM for its WiredTiger cache) |
| Disk | 5 GB (OS + images) | Depends on data volume — plan for file storage + brain data + MongoDB journal |
| Network | Any | Low-latency link between syncing brains improves convergence time |

MongoDB Atlas Local runs a `mongot` sidecar for vector search. This adds ~300 MB RAM overhead on top of baseline `mongod` usage.

For multi-brain networks, each brain runs its own full stack. Scale vertically (more RAM/disk) rather than horizontally — each brain is an independent unit.

### Upgrading

1. Pull the latest image:

   ```bash
   docker compose pull        # if using a registry
   docker compose build       # if building from source
   ```

2. Restart the stack:

   ```bash
   docker compose up -d
   ```

Named volumes persist across upgrades. The server applies any pending MongoDB index changes on startup automatically. No manual migration scripts are needed.

**Breaking changes**, when they occur, will be listed in `CHANGELOG.md` with migration steps.

### Rolling Back

**The first boot on a new version rewrites `config.json`, and some of those rewrites drop a field an older
build reads.** So a rollback is not simply "run the previous image": that path exists, but it needs the copy of
`config.json` you took *before* upgrading.

The rewrites are one-time and idempotent, they are logged when they happen, and each one exists because a setting
moved. They are listed here so the consequence of going back is not a surprise:

| the boot migrates | dropping | so an older build |
|---|---|---|
| `mediaEmbedding.enabled` → per-class `levels` | `enabled` | defaults it back to **`true`**: an instance where media embedding was deliberately **off** starts sending uploads to the vision and speech models again |
| a space's `description` → `meta.purpose` | `description` | reads no space instructions, because the field it serves to MCP clients is gone |
| a provider API key in `mediaEmbedding.<vision\|stt\|nli\|rerank>.apiKey` → `secrets.json` | `apiKey` | sends no `Authorization` header to that provider, so an external vision / speech-to-text / NLI / rerank endpoint returns 401 and the feature stops. The key is NOT lost — it is in `secrets.json` (`0o600`) and can be pasted back into `config.json` for the older build. **New in 3.0**, and the reason is that `config.json` is the file operators copy, paste into issues, and mount as a ConfigMap. |
| `mediaEmbedding.ollamaUrl` / `visionModel` / `whisperUrl` / `whisperModel` → `vision.*` / `stt.*` | `ollamaUrl`, `visionModel`, `whisperUrl`, `whisperModel` | stops finding those four names and falls back to its BUILT-IN defaults — `http://ollama:11434` and `http://whisper:8000` — so it captions and transcribes against whatever answers there, with no error. The values are not lost: they are on `vision.*` / `stt.*`, which the older build also reads. **New in 3.0.** The env vars are a separate matter and 4.0 REMOVED the legacy spellings: `VISION_BASE_URL`, `STT_BASE_URL` and `STT_MODEL` are the names, and `OLLAMA_URL` / `WHISPER_URL` / `WHISPER_MODEL` now refuse the boot rather than resolving — see the rename note in the media-embedding guide for why refusing beats ignoring. **This matters for a rollback in one direction only:** the current names resolve in every 3.x build, so a manifest written for 4.0 runs on 3.x unchanged. A manifest still using the legacy names runs on 3.x and will not start on 4.0. |
| `mediaEmbedding.faceRecognition.enabled` → the image ladder | `faceRecognition.enabled` | applies its own default for face recognition rather than the choice that was recorded |
| every token gains a `rights` matrix **in memory** | **nothing** | keeps working, and `config.json` is not touched at all — the matrix is derived on each start and never written, so there is nothing here for a rollback to undo |
| a legacy `syncSchedule` shorthand → the cron expression it always meant | **nothing** | keeps syncing at exactly the same rate. This is the one row here with no rollback cost, and it is listed so you can tell it from the others: `"every 5m"` becomes `"*/5 * * * *"`, and every 3.x build tried a real cron expression FIRST, so it runs the rewritten value identically. **New in 4.0**, where sending a shorthand is refused with a `400` naming its cron form. A shorthand outside cron's range — `"every 90m"` — is NOT rewritten: it never resolved on any build, so that network has been on manual sync all along, and it is named in the startup log rather than rounded to a schedule nobody chose. |

The first three are silent in the old build — the field is simply absent, which reads as "never configured"
rather than "removed".

**`tokens[].rights` is not a file change at all, and this paragraph used to say it was.** The upgrade derives a
per-space rights matrix for every token from its legacy `admin`/`readOnly`/`spaces` fields — **in memory, on
every start, and it is never written to `config.json`.** The legacy fields stay in the file, and the copy an
operator takes before upgrading is byte-identical afterwards as far as tokens are concerned.

**They are not what enforcement reads, and this paragraph used to say they were.** `spaces`, `admin` and
`readOnly` left the token record in 3.1; 4.0 removed the last fallback to them, so a token reaching the
instance with no rights matrix now reaches nothing at all. Nothing is lost by that here, because the matrix
is derived from those same three fields on every start — which is why this is still a row about a rollback
costing nothing rather than a row about a migration.

It is kept in this table because it is the row people ask about: a rollback needs no token work, and there is
no shape change to explain.

**Corrected 2026-09-05, and the correction is worth stating.** This section said the matrix was written down.
The code did attempt that write on every boot — and it could never succeed, because the mechanism it used does
not exist in this codebase, so the attempt failed and was logged as a warning every time. So the hazard this
paragraph described has never existed on any instance. Writing it deliberately is separate future work, and
this table gains a row on the day it happens.

#### The procedure

```bash
# BEFORE upgrading — this file is the rollback, and it is 4 KB
docker compose cp ythril:/config/config.json ./config.json.pre-upgrade

# ... upgrade, and if it goes wrong:
docker compose down
docker compose cp ./config.json.pre-upgrade ythril:/config/config.json
# pin the previous tag in compose (or .env), then:
docker compose up -d
```

**Brain data in MongoDB needs no rollback of its own.** Documents only ever gain fields, and both the API and the
UI ignore ones they do not know, so an older build reads newer records — it simply does not show the newer fields.
The exception is anything created by a feature the old version lacks: a record whose `type` has no schema in the
old build is still stored and still returned, just unvalidated.

**Vector indexes are rebuilt on boot**, so a rollback that changes the embedding model or its dimensions costs a
reindex, not data. Check `GET /ready` before sending traffic — see [Runtime Model Downloads](#runtime-model-downloads)
if you also pinned a different model.

**Backup before upgrading:**

```bash
# Stop the stack to get a clean snapshot
docker compose stop

# Copy volumes
docker run --rm -v ythril-data:/src -v $(pwd)/backup:/dst alpine \
  sh -c "cp -a /src/. /dst/data/"
docker run --rm -v ythril-mongo-data:/src -v $(pwd)/backup:/dst alpine \
  sh -c "cp -a /src/. /dst/mongo/"

# Also back up config/ (bind mount — just copy)
# config.json, secrets.json, and schema-library.json (if present) are all required for a full restore.
cp -r config/ backup/config/

docker compose start
```

---

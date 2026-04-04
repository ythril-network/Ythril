# Ythril Integration Guide

> API and MCP reference for developers building on Ythril.

---

## Table of Contents

1. [Getting Ythril](#getting-ythril)
2. [Hosting](#hosting)
   - [TLS Termination](#tls-termination)
   - [Resource Requirements](#resource-requirements)
   - [Upgrading](#upgrading)
3. [Authentication](#authentication)
4. [Error Format](#error-format)
5. [Rate Limits](#rate-limits)
6. [Brain API](#brain-api) — memories, entities, edges, chrono, search, stats
7. [Files API](#files-api) — upload, download, chunked upload, move, delete
8. [Spaces API](#spaces-api) — create, list, delete, proxy spaces
9. [Tokens API](#tokens-api) — create, list, regenerate, revoke
10. [Networks API](#networks-api) — create, join, members, voting, sync history, fork
11. [Invite API](#invite-api) — RSA peer handshake
12. [Notify API](#notify-api) — peer events and sync triggers
13. [Sync API](#sync-api) — change-feed, batch upsert, Merkle
14. [MFA API](#mfa-api) — TOTP setup and verification
15. [Conflicts API](#conflicts-api) — view and resolve sync conflicts
16. [Setup API](#setup-api) — first-run setup
17. [Admin API](#admin-api) — config reload
18. [About API](#about-api) — instance info and logs
19. [Theme API](#theme-api) — external CSS theming
20. [MCP (Model Context Protocol)](#mcp-model-context-protocol) — AI tool integration
21. [Storage Quotas](#storage-quotas)
22. [Pagination](#pagination)

---

## Getting Ythril

### Container Images

Published images are available on two registries:

| Registry | Image | Pull command |
|----------|-------|-------------|
| GitHub Container Registry | `ghcr.io/ythril-network/ythril` | `docker pull ghcr.io/ythril-network/ythril:latest` |
| Docker Hub | `docker.io/ythril/ythril` | `docker pull ythril/ythril:latest` |

Tags follow semver: `:latest`, `:0.1.0`, `:0.1`, `:0`. All images are multi-arch (`linux/amd64`, `linux/arm64`).

### Quick Start

```bash
docker compose up -d
```

The included `docker-compose.yml` pulls the GHCR image and starts Ythril + MongoDB. On first run, open `http://localhost:3200` — you'll be redirected to the setup page.

Enter an instance label and complete setup:

```
POST http://localhost:3200/api/setup/json
{ "label": "My Ythril" }
```

This returns your admin token. Store it — it is shown once.

### Health Check

```
GET http://localhost:3200/health
→ { "status": "ok", "ts": "2026-03-26T10:00:00.000Z" }
```

### Base URL

All API paths in this guide are relative to `http://<host>:3200`. In production behind a reverse proxy, substitute your public URL.

---

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
| MongoDB < 8.2 (vanilla) | ✗ | `recall` / `recall_global` tools disabled; all other features work |

**Using an existing MongoDB 8.2+ cluster** — remove the `ythril-mongo` service from `docker-compose.yml` and point `MONGO_URI` at your cluster:

```yaml
environment:
  MONGO_URI: mongodb://mongodb-0.example.com:27017/?directConnection=true
```

**Using managed Atlas** — provide the `mongodb+srv://` connection string:

```yaml
environment:
  MONGO_URI: mongodb+srv://user:pass@cluster0.example.mongodb.net/?retryWrites=true
```

On startup, Ythril probes for `$vectorSearch` support and logs the result:

```
  ✓ $vectorSearch available (MongoDB 8.2.1)
```

or, if unavailable:

```
  ✗ $vectorSearch not available (MongoDB 7.0.0) — semantic search (recall) will be disabled
    Upgrade to MongoDB 8.2+, use Atlas Local, or connect to managed Atlas
```

If `$vectorSearch` is unavailable, all non-search operations (storing memories, entities, edges, files, sync) continue to work normally.  Only the `recall` and `recall_global` MCP tools return an error until a supported MongoDB is connected.

### Startup Output

**First run:**

```
  ythril  ·  first-run setup required

  Open http://localhost:3200 to get started
```

**Configured:**

```
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
| `MONGO_URI` | `mongodb://ythril-mongo:27017/?directConnection=true` | MongoDB connection string — any `$vectorSearch`-capable MongoDB works |
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `3200` | HTTP listen port |
| `DEBUG` | (unset) | Set to `1` for verbose logging |

### Data Persistence

All persistent data lives in named Docker volumes:

| Volume | Contents |
|--------|----------|
| `ythril-data` | File storage (`/data/{spaceId}/`) |
| `ythril-mongo-data` | Brain data: memories, entities, edges, tombstones |
| `ythril-mongo-configdb` | MongoDB replica set keyfile |

The `config/` directory is a host bind mount — `config.json` and `secrets.json` are plain files that survive any container lifecycle event.

### Config File Permissions

On startup, Ythril checks that `config.json` and `secrets.json` are owner-read/write only (`0600`). If the files have looser permissions (e.g. `0644`, `0666`), the server automatically tightens them to `0600` and logs a `SECURITY:` warning:

```
SECURITY: config.json had mode 0644 — auto-fixed to 0600
```

If auto-fix fails (e.g. the process doesn't own the file), the server logs an error and exits. This is common with Docker bind mounts on WSL2, where host files appear world-writable inside the container — the auto-fix handles this case transparently.

```bash
docker compose down        # stops containers — data intact
docker compose up -d       # reattaches volumes — picks up where it left off
docker compose down -v     # ⚠ permanently deletes all named volumes
```

### Running Multiple Brains

Each brain is an independent Compose stack. To run two on one machine:

```bash
# Brain A — default, port 3200
docker compose up -d

# Brain B — separate project, port 3201
docker compose -p ythril-b -f docker-compose.brain-b.yml up -d
```

Keep `config/` bind mounts separate per brain. Each goes through first-run setup independently and knows nothing about the other until explicitly networked.

### Recovery After Downtime

Networked brains reconnect automatically. On the next sync cycle after coming back up, each brain requests everything after its last recorded watermark. Tombstones propagate deletions that happened during downtime. No manual reconnection step required.

### Security Headers

Ythril sets the following headers on every response:

| Header | Value | Purpose |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `Content-Security-Policy` | `frame-ancestors 'self'` | Allows same-origin iframing (OIDC silent refresh, portal theming) while blocking cross-origin embedding |
| `Referrer-Policy` | `no-referrer` | Strips referrer on outbound requests |
| `X-Request-Id` | UUID | Unique per-request ID for tracing (logged server-side) |

**HSTS**: Since Ythril does not terminate TLS itself, `Strict-Transport-Security` should be set on your reverse proxy (Traefik, Nginx, Caddy).

**CORS**: No `Access-Control-*` headers are set. The Angular SPA is served from the same origin, so cross-origin browser requests are blocked by default. If you need CORS for a custom frontend, configure it on your reverse proxy.

### TLS Termination

Ythril listens on plain HTTP. Place a reverse proxy in front to terminate TLS.

**Nginx**

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

        # SSE (MCP transport) — disable buffering
        proxy_buffering off;
        proxy_cache     off;
        proxy_read_timeout 86400s;
    }

    client_max_body_size 512M;
}
```

**Caddy**

```caddyfile
brain.example.com {
    reverse_proxy localhost:3200
    header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
}
```

Caddy provisions TLS certificates automatically via Let's Encrypt/ZeroSSL.

**Traefik (Docker labels)**

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
cp -r config/ backup/config/

docker compose start
```

---

## Authentication

Every API request (except `/health`, `/setup`, and `/api/invite/apply`) requires a Bearer token:

```
Authorization: Bearer ythril_<base62-encoded-token>
```

Tokens are created during first-run setup or via `POST /api/tokens`. The plaintext token is shown **once** — store it securely.

### Token Scoping

| Token Type | Access |
|---|---|
| Full-access | All spaces, read + write |
| Space-scoped | Only endpoints for listed spaces; admin routes blocked |
| Read-only | Read/search only — all mutations (create, update, delete) blocked |
| Admin | Full-access + admin-only routes (networks, tokens, config) |

> A token **cannot** be both `admin` and `readOnly`.

### Auth Middleware Levels

| Middleware | Required |
|---|---|
| `requireAuth` | Any valid token |
| `requireAdmin` | Token with `admin: true` |
| `requireAdminMfa` | Admin token + MFA verified (if MFA enabled) |
| `requireSpaceAuth` | Token with access to the `:spaceId` in the URL |
| `denyReadOnly` | Applied on mutating routes — blocks `readOnly` tokens |

---

## Error Format

All errors return JSON:

```json
{ "error": "Human-readable message" }
```

Extended errors may include:

```json
{ "error": "Storage limit exceeded", "storageExceeded": true }
```

### Common Status Codes

| Code | Meaning |
|---|---|
| 400 | Bad request / validation failure |
| 401 | Missing or invalid token |
| 403 | Token lacks access to this resource |
| 404 | Resource not found |
| 409 | Conflict (duplicate ID) |
| 413 | Payload too large (Express body limit: 10 MB for JSON) |
| 429 | Rate limited — check `Retry-After` header |
| 507 | Storage quota hard limit exceeded |

---

## Rate Limits

| Scope | Limit | Applies To |
|---|---|---|
| Auth | 10 / min | Token creation, setup, invite/apply |
| Global | 300 / min | All authenticated endpoints |
| Sync | 2 000 / min | Sync API endpoints |
| Notify | 60 / min | `POST /api/notify` |
| Bulk wipe | 5 / min | `DELETE /api/brain/:spaceId/memories` |

Rate limit headers are included in responses:

```
RateLimit-Limit: 300
RateLimit-Remaining: 297
RateLimit-Reset: 1711381200
Retry-After: 42
```

Every response includes an `X-Request-Id` header (UUID) for log correlation.

---

## Brain API

Base path: `/api/brain`

> **Proxy spaces:** Read operations aggregate across all member spaces. Write operations require `?targetSpace=<member>` in the query string.

### Write a Memory

```
POST /api/brain/:spaceId/memories
```

```json
{
  "fact": "Kubernetes pods are ephemeral by design",
  "tags": ["k8s", "architecture"],
  "entityIds": []
}
```

**Response** `201`:

```json
{
  "_id": "a1b2c3d4-...",
  "spaceId": "general",
  "fact": "Kubernetes pods are ephemeral by design",
  "tags": ["k8s", "architecture"],
  "entityIds": [],
  "seq": 42,
  "createdAt": "2026-03-25T14:00:00.000Z",
  "updatedAt": "2026-03-25T14:00:00.000Z",
  "author": { "instanceId": "c6ff5d55-...", "instanceLabel": "My Ythril" }
}
```

**Constraints**: `fact` max 50 000 chars. `tags` must be an array of strings.

---

### Get a Memory by ID

```
GET /api/brain/:spaceId/memories/:id
```

**Response** `200`: Full `MemoryDoc` (same shape as write response).

---

### List Memories

```
GET /api/brain/:spaceId/memories?limit=100&skip=0
```

Optional filters:

| Parameter | Description |
|-----------|-------------|
| `tag` | Filter by tag (case-insensitive) |
| `entity` | Filter by linked entity ID |
| `limit` | Results per page (default 100, max 500) |
| `skip` | Offset for pagination |

Both `tag` and `entity` can be combined (AND logic). Results are sorted newest-first.

**Response** `200`:

```json
{
  "memories": [ ... ],
  "limit": 100,
  "skip": 0
}
```

Default limit: 100, max: 500. Use `skip` for offset pagination.

---

### Delete a Memory

```
DELETE /api/brain/:spaceId/memories/:id
```

**Response** `204` (no body).

---

### Wipe All Memories

```
DELETE /api/brain/:spaceId/memories
Content-Type: application/json

{ "confirm": true }
```

**Response** `200` `{ deleted: <count> }`. Rate-limited to 5 requests/minute.

---

### Semantic Search (Recall)

> **MCP-only.** This operation is exposed as the `recall` MCP tool, not as a REST endpoint. See the [MCP section](#mcp-model-context-protocol) for tool parameters.

Uses the built-in embedding model and MongoDB Atlas `$vectorSearch`. No extra configuration needed.

---

### Upsert an Entity

```
POST /api/brain/spaces/:spaceId/entities
```

```json
{
  "name": "Kubernetes",
  "type": "technology",
  "tags": ["infra", "containers"],
  "properties": { "cncf": true, "version": "1.32" }
}
```

**Response** `201`: Full entity doc. Upserts on `(spaceId, name, type)` — tags are merged (deduplicated union), properties are shallow-merged (new keys added, existing keys overwritten).

**Constraints**: `name` required string; `type` optional string (defaults to empty); `tags` optional array of strings; `properties` optional object where each value must be a string, number, or boolean.

---

### List Entities

```
GET /api/brain/spaces/:spaceId/entities?limit=50&skip=0
```

**Response** `200`:

```json
{
  "entities": [ ... ],
  "limit": 50,
  "skip": 0
}
```

Default limit: 50, max: 200.

---

### Delete an Entity

```
DELETE /api/brain/spaces/:spaceId/entities/:id
```

**Response** `204`.

---

### Upsert an Edge

```
POST /api/brain/spaces/:spaceId/edges
```

```json
{
  "from": "kubernetes",
  "to": "docker",
  "label": "depends_on",
  "weight": 0.9,
  "type": "causal"
}
```

**Response** `201`: Full edge doc.

| Field | Required | Description |
|-------|----------|-------------|
| `from` | yes | Source entity ID |
| `to` | yes | Target entity ID |
| `label` | yes | Relationship label (e.g. `depends_on`, `related_to`) |
| `weight` | no | Numeric weight (0–1). Defaults to none. |
| `type` | no | Free-form edge type string (e.g. `causal`, `hierarchical`). |

Upserts on `(spaceId, from, to, label)`.

---

### List Edges

```
GET /api/brain/spaces/:spaceId/edges?limit=50&skip=0
```

**Response** `200`:

```json
{
  "edges": [ ... ],
  "limit": 50,
  "skip": 0
}
```

---

### Delete an Edge

```
DELETE /api/brain/spaces/:spaceId/edges/:id
```

**Response** `204`.

---

### Create a Chrono Entry

```
POST /api/brain/spaces/:spaceId/chrono
```

**Body**:

```json
{
  "title": "Release v1.0",
  "kind": "milestone",
  "startsAt": "2026-06-01T00:00:00Z",
  "description": "First public release",
  "status": "upcoming",
  "confidence": 0.9,
  "tags": ["release"],
  "entityIds": [],
  "memoryIds": []
}
```

- `kind` — `event`, `deadline`, `plan`, `prediction`, `milestone`
- `status` — `upcoming` (default), `active`, `completed`, `overdue`, `cancelled`
- `confidence` — `0`–`1` (optional, useful for predictions)

**Response** `201` — the created `ChronoEntry`.

---

### Update a Chrono Entry

```
POST /api/brain/spaces/:spaceId/chrono/:id
```

**Body**: partial object with any updatable fields (`title`, `kind`, `status`, `startsAt`, `endsAt`, `confidence`, `tags`, `entityIds`, `memoryIds`, `description`).

**Response** `200` — the updated `ChronoEntry`.

---

### List Chrono Entries

```
GET /api/brain/spaces/:spaceId/chrono?limit=50&skip=0
```

**Response** `200`:

```json
{
  "chrono": [ ... ],
  "limit": 50,
  "skip": 0
}
```

---

### Delete a Chrono Entry

```
DELETE /api/brain/spaces/:spaceId/chrono/:id
```

**Response** `204`.

---

### Space Stats

```
GET /api/brain/spaces/:spaceId/stats
```

**Response** `200`:

```json
{
  "spaceId": "general",
  "memories": 1042,
  "entities": 156,
  "edges": 89,
  "chrono": 23
}
```

---

### Check Reindex Status

```
GET /api/brain/spaces/:spaceId/reindex-status
```

**Response** `200`:

```json
{ "spaceId": "general", "needsReindex": false }
```

Returns `true` when the embedding model has changed and memories need re-embedding.

---

### Reindex Space

```
POST /api/brain/spaces/:spaceId/reindex
```

Re-computes all embeddings with the current model. Long-running — may take minutes for large spaces.

**Response** `200`:

```json
{ "spaceId": "general", "reindexed": 1042, "errors": 0 }
```

---

## Files API

Base path: `/api/files`

> **Proxy spaces:** Read operations (GET) search across all member spaces. Write operations (POST, DELETE, PATCH, mkdir) require `?targetSpace=<member>` in the query string.

### Upload a File (raw bytes)

```
POST /api/files/:spaceId?path=reports/q1.pdf
Content-Type: application/octet-stream

<raw bytes>
```

Any file type is supported — documents, images, binaries, archives, etc. The `Content-Type` header is informational; Ythril stores the raw bytes as-is.

**Response** `201`:

```json
{ "path": "reports/q1.pdf", "sha256": "a1b2c3..." }
```

### Upload a File (JSON / base64)

```
POST /api/files/:spaceId?path=assets/diagram.svg
Content-Type: application/json

{
  "content": "PHN2ZyB4bWxucz0...",
  "encoding": "base64"
}
```

---

### Chunked Upload (Content-Range)

For files larger than 10 MB, split into chunks and send with `Content-Range`:

```
POST /api/files/:spaceId?path=large-file.zip
Content-Type: application/octet-stream
Content-Range: bytes 0-5242879/15728640
Authorization: Bearer ythril_…

<5 MB of raw bytes>
```

Intermediate chunks return **202**:

```json
{ "path": "large-file.zip", "received": 5242880 }
```

The final chunk (where `end === total - 1`) returns **201** with the full file hash:

```json
{ "path": "large-file.zip", "sha256": "a1b2c3..." }
```

Duplicate ranges are silently accepted (idempotent). The `maxUploadBodyBytes` config limit applies per-chunk, not per-file.

### Check Upload Progress

```
GET /api/files/:spaceId/upload-status?path=large-file.zip&total=15728640
```

**Response** `200`:

```json
{ "received": 5242880 }
```

Resume by sending the next chunk from the `received` offset. Stale chunk directories (older than 24 hours) are automatically cleaned up.

---

### Download a File

```
GET /api/files/:spaceId?path=reports/q1.pdf
```

Returns raw file bytes. Works with any file type — PDFs, images, archives, source code, etc. If `path` is a directory, returns a JSON listing.

---

### List Directory

```
GET /api/files/:spaceId?path=reports/
```

**Response** `200`:

```json
{
  "path": "reports/",
  "type": "dir",
  "entries": [
    { "name": "q1.pdf", "type": "file", "size": 204800 },
    { "name": "q1-data.xlsx", "type": "file", "size": 51200 },
    { "name": "charts", "type": "dir" }
  ]
}
```

---

### Create Directory

```
POST /api/files/:spaceId/mkdir?path=reports/charts
```

**Response** `201`:

```json
{ "created": "reports/charts" }
```

---

### Move / Rename

```
PATCH /api/files/:spaceId?path=reports/draft.docx
Content-Type: application/json

{ "destination": "reports/final.docx" }
```

**Response** `200`:

```json
{ "from": "reports/draft.docx", "to": "reports/final.docx" }
```

---

### Delete a File

```
DELETE /api/files/:spaceId?path=reports/q1.pdf
```

**Response** `204`.

To delete a directory, include `{ "confirm": true }` in the request body.

---

## Spaces API

Base path: `/api/spaces`

### List Spaces

```
GET /api/spaces
```

**Response** `200`:

```json
{
  "spaces": [
    { "id": "general", "label": "General", "builtIn": true }
  ],
  "storage": {
    "total": { "usedBytes": 52428800, "softLimitGiB": 150, "hardLimitGiB": 200 }
  }
}
```

---

### Create a Space

```
POST /api/spaces
```

```json
{
  "id": "research",
  "label": "Research Notes",
  "description": "Papers, notes, and findings from the AI research team.",
  "folders": ["papers", "notes"],
  "minGiB": 2
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | no | Lowercase `^[a-z0-9-]+$`, max 40 chars. Auto-generated if omitted. |
| `label` | yes | Human-readable display name, max 200 chars. |
| `description` | no | Max 2000 chars. Surfaced to MCP clients as space-level instructions. |
| `folders` | no | Pre-create these directories on disk at space creation time. |
| `minGiB` | no | Reserve minimum storage (positive number in GiB). |

**Response** `201`: the created space object.

---

### Create a Proxy Space

A proxy space is a virtual space that groups multiple real spaces into a single endpoint. Reads aggregate across all member spaces; writes require a `targetSpace` parameter to specify the destination.

```
POST /api/spaces
```

```json
{
  "id": "all-research",
  "label": "All Research",
  "description": "Aggregated view of biology and physics research spaces.",
  "proxyFor": ["bio-research", "physics-research"]
}
```

**Rules:**
- All `proxyFor` members must be existing real spaces (not proxies — nesting is not allowed).
- Proxy spaces are virtual: no DB collections or file directories are created.
- The calling token must have access to **all** member spaces.

**Read operations** (GET memories, entities, edges, files, recall, query) aggregate results across all member spaces transparently.

**Write operations** (POST memories, write_file, upsert_entity, etc.) require a `targetSpace` query parameter:

```
POST /api/brain/all-research/memories?targetSpace=bio-research
```

```json
{ "fact": "CRISPR efficiency improved by 40% with new guide RNA design." }
```

The `targetSpace` must be one of the proxy's `proxyFor` members. Omitting it on a write returns `400`.

**MCP**: When connected via MCP to a proxy space, read tools (`recall`, `query`, `read_file`, `list_dir`) aggregate automatically. Write tools (`remember`, `upsert_entity`, `write_file`, etc.) accept an optional `targetSpace` argument — required when the MCP endpoint is a proxy space.

---

### Update a Space

```
PATCH /api/spaces/:id
```

Update the `label` and/or `description` of an existing space. At least one field must be provided. Requires an admin token (+ TOTP if MFA is enabled).

```json
{
  "label": "Research Notes (Updated)",
  "description": "Updated description surfaced to MCP clients as space-level instructions."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `label` | no (at least one) | New display name, max 200 chars. |
| `description` | no (at least one) | New description, max 2000 chars. Surfaced to MCP clients as `instructions` during handshake. |

**Response** `200`: the updated space object.

> **MCP tool:** `update_space` — accepts the same `label` and `description` arguments. Requires the MCP session token to have `admin: true`.

---

### Delete a Space

```
DELETE /api/spaces/:id
Content-Type: application/json

{ "confirm": true }
```

**Response** `204`. If the space participates in a network, deletion requires a governance vote.

If cleanup partially fails (e.g. a collection drop or file deletion errors), the server returns `500` with error details. The space is **not** removed from config so the deletion can be retried. Check the response body for specifics:

```json
{ "error": "Space 'research' cleanup incomplete (2 error(s)). Space was NOT removed from config. ..." }
```

---

## Tokens API

Base path: `/api/tokens` — requires `admin` token.

### List Tokens

```
GET /api/tokens
```

**Response** `200`:

```json
{
  "tokens": [
    {
      "id": "tok_abc123",
      "name": "Admin",
      "prefix": "ythril_b",
      "createdAt": "2026-03-25T14:00:00.000Z",
      "lastUsed": "2026-03-25T15:30:00.000Z",
      "expiresAt": null,
      "spaces": null,
      "admin": true
    }
  ]
}
```

Note: `hash` is never exposed.

---

### Create a Token

```
POST /api/tokens
```

```json
{
  "name": "MCP Agent",
  "spaces": ["general", "research"],
  "admin": false,
  "readOnly": false,
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

**Response** `201`:

```json
{
  "token": { "id": "...", "name": "MCP Agent", "prefix": "ythril_x", ... },
  "plaintext": "ythril_xK9mPq..."
}
```

> **The `plaintext` field is shown once.** Store it immediately.

---

### Regenerate a Token

```
POST /api/tokens/:id/regenerate
```

Issues a new plaintext credential for an existing token record. The old value is invalidated.

**Response** `200`:

```json
{ "plaintext": "ythril_newValue..." }
```

---

### Revoke a Token

```
DELETE /api/tokens/:id
```

**Response** `204`.

---

## Networks API

Base path: `/api/networks` — requires `admin` token.

### List Networks

```
GET /api/networks
```

**Response** `200`:

```json
{
  "networks": [
    {
      "id": "net-uuid",
      "label": "Team Sync",
      "type": "closed",
      "spaces": ["general"],
      "members": [
        {
          "instanceId": "peer-uuid",
          "label": "Peer Brain",
          "url": "https://peer.example.com",
          "direction": "both"
        }
      ]
    }
  ]
}
```

---

### Create a Network

```
POST /api/networks
```

```json
{
  "label": "Team Sync",
  "type": "closed",
  "spaces": ["general"],
  "votingDeadlineHours": 24,
  "syncSchedule": "*/5 * * * *"
}
```

**Network types**: `closed` (unanimous vote), `democratic` (majority), `club` (proposer only), `braintree` (tree hierarchy), `pubsub` (auto-join publisher/subscriber, push-only).

**Response** `201`: the created network object.

---

### Delete a Network

```
DELETE /api/networks/:id
```

Broadcasts `member_departed` to all peers. **Response** `204` on success, or `200` with `{ ok: true, warnings: [...] }` if some peer notifications failed.

---

### Update a Network

```
PATCH /api/networks/:id
```

```json
{ "syncSchedule": "*/10 * * * *", "label": "Renamed" }
```

---

### Add a Member (Manual)

```
POST /api/networks/:id/members
```

```json
{
  "instanceId": "peer-instance-uuid",
  "label": "Remote Brain",
  "url": "https://remote.example.com",
  "token": "ythril_peerToken...",
  "direction": "both"
}
```

In `closed`/`democratic` networks this opens a voting round.
In `club` networks the member is added immediately.
In `braintree` networks all ancestors up to the root must approve.
In `pubsub` networks the subscriber is added immediately with `direction` forced to `push` (publisher pushes to subscriber) regardless of the request body value.

---

### Join via Invite Key

```
POST /api/networks/:id/join
```

```json
{
  "inviteKey": "the-shared-key",
  "instanceId": "my-uuid",
  "label": "My Brain",
  "url": "https://me.example.com",
  "token": "ythril_myToken..."
}
```

---

### Cast a Vote

```
POST /api/networks/:id/votes/:roundId
```

```json
{ "vote": "yes" }
```

Accepted values: `yes`, `veto`.

---

### Generate an Invite Key

```
POST /api/networks/:id/invite-key
```

**Response** `201`:

```json
{ "inviteKey": "generated-key-string" }
```

---

### Revoke an Invite Key

```
DELETE /api/networks/:id/invite-key
```

**Response** `204`.

---

### Join Remote (RSA Handshake)

```
POST /api/networks/join-remote
```

```json
{
  "handshakeId": "uuid",
  "inviteUrl": "https://remote.example.com/api/invite/apply",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "networkId": "net-uuid",
  "myUrl": "https://me.example.com"
}
```

Executes the full 3-step RSA handshake server-side. No plaintext tokens cross the wire.

---

### Sync History

```
GET /api/networks/:id/sync-history?limit=20
```

**Response** `200`:

```json
{
  "history": [
    {
      "_id": "...",
      "networkId": "...",
      "triggeredAt": "2026-03-26T12:00:00.000Z",
      "completedAt": "2026-03-26T12:00:02.500Z",
      "status": "success",
      "pulled": { "memories": 5, "entities": 2, "edges": 1, "files": 0 },
      "pushed": { "memories": 3, "entities": 0, "edges": 0, "files": 1 },
      "errors": []
    }
  ]
}
```

`limit` defaults to 20, max 100. Ordered most-recent-first. The last 100 records per network are retained; older entries are pruned automatically.

---

### Fork a Network

```
POST /api/networks/:id/fork
```

```json
{
  "label": "My fork",
  "type": "closed",
  "votingDeadlineHours": 24,
  "spaces": ["space-id-1"]
}
```

Creates a new independent network from your local copy of the data.

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Name for the new network |
| `type` | No | `closed` (default) or `club` |
| `votingDeadlineHours` | No | Defaults to source value, or 24 |
| `spaces` | Conditional | Required if ejected; optional if still a member |

**Scenarios:**

- **Still a member** — spaces and deadline inherited from source; can be overridden.
- **Ejected** — source config is deleted on `member_removed`; `spaces` must be supplied explicitly.
- **Unknown ID** — `404`.

The fork gets a fresh UUID, no members, no pending rounds. You become the root.

---

### Remove a Member

```
DELETE /api/networks/:id/members/:instanceId
```

In `closed`/`democratic` networks this opens a removal voting round (**202**). In `club` networks the member is removed immediately (**204**). In `braintree` networks the ancestor path must vote; if the subject is a direct child, the round auto-concludes.

**Response** `204` (immediate removal) or `202`:

```json
{ "status": "vote_pending", "roundId": "round-uuid" }
```

---

### Reparent Self (Braintree)

Called by a braintree child node on itself after completing an RSA handshake with a grandparent. Records a temporary reparent so the node syncs through the grandparent while its original parent is offline.

```
POST /api/networks/:id/reparent-self
```

```json
{
  "newParentInstanceId": "grandparent-uuid",
  "newParentLabel": "Grandparent Brain",
  "newParentUrl": "https://grandparent.example.com",
  "tokenForNewParent": "ythril_peerToken...",
  "originalParentInstanceId": "original-parent-uuid"
}
```

**Response** `200`:

```json
{
  "status": "reparented",
  "newParentInstanceId": "grandparent-uuid",
  "originalParentInstanceId": "original-parent-uuid"
}
```

Only valid for `braintree` networks. Returns `400` for other types.

---

### Adopt Member (Braintree)

Called on the grandparent to make a temporary reparent permanent. The member's parent is officially changed.

```
POST /api/networks/:id/members/:instanceId/adopt
```

No request body.

**Response** `200`:

```json
{
  "status": "adopted",
  "instanceId": "child-uuid",
  "parentInstanceId": "grandparent-uuid"
}
```

Returns `409` if the member is not in a temporary reparent state.

---

### Revert Parent (Braintree)

Called on the grandparent when the original parent comes back online. Restores the member to its original parent and removes the direct grandparent link.

```
POST /api/networks/:id/members/:instanceId/revert-parent
```

No request body.

**Response** `200`:

```json
{
  "status": "reverted",
  "instanceId": "child-uuid",
  "parentInstanceId": "original-parent-uuid"
}
```

Returns `409` if the member is not in a temporary reparent state.

---

## Invite API

Base path: `/api/invite` — unauthenticated endpoints (rate-limited).

### Generate Invite

```
POST /api/invite/generate
Authorization: Bearer <admin-token>
```

```json
{ "networkId": "net-uuid" }
```

**Response** `201`:

```json
{
  "handshakeId": "uuid",
  "networkId": "net-uuid",
  "inviteUrl": "https://me.example.com/api/invite/apply",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "expiresAt": "2026-03-25T15:00:00.000Z"
}
```

---

### Apply (Unauthenticated — called by joining brain)

```
POST /api/invite/apply
```

```json
{
  "handshakeId": "uuid",
  "networkId": "net-uuid",
  "instanceId": "joiner-uuid",
  "instanceLabel": "Joiner Brain",
  "instanceUrl": "https://joiner.example.com",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n..."
}
```

**Response** `200`:

```json
{
  "encryptedTokenForB": "base64...",
  "rsaPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "instanceId": "inviter-uuid",
  "instanceLabel": "Inviter Brain",
  "networkId": "net-uuid",
  "networkLabel": "Team Sync",
  "networkType": "closed",
  "spaces": ["general"]
}
```

All tokens are RSA-OAEP-SHA256 encrypted — never plaintext over the wire.

---

### Finalize

```
POST /api/invite/finalize
```

```json
{
  "handshakeId": "uuid",
  "encryptedTokenForA": "base64..."
}
```

**Response** `200`:

```json
{ "status": "joined", "instanceId": "joiner-uuid", "networkId": "net-uuid" }
```

---

### Check Invite Status

```
GET /api/invite/status/:handshakeId
```

**Response** `200`:

```json
{ "status": "pending", "expiresAt": "2026-03-25T15:00:00.000Z" }
```

---

## Notify API

Base path: `/api/notify`

### Send Event (peer-to-peer)

```
POST /api/notify
```

```json
{
  "networkId": "net-uuid",
  "instanceId": "sender-uuid",
  "event": "sync_available"
}
```

Events: `vote_pending`, `member_departed`, `member_removed`, `space_deletion_pending`, `sync_available`, `ping`.

**Response** `204`.

---

### List Events

```
GET /api/notify?networkId=net-uuid&limit=50
```

---

### Trigger Sync

```
POST /api/notify/trigger
```

```json
{ "networkId": "net-uuid" }
```

Triggers an immediate sync cycle for the given network.

**Response** `200`:

```json
{ "status": "ok", "networkId": "net-uuid" }
```

---

## Sync API

Base path: `/api/sync` — used by the sync engine between peers. All endpoints require auth + sync rate limit.

### GET /api/sync/memories

```
GET /api/sync/memories?spaceId=general&sinceSeq=0&limit=200&full=true
```

Cursor-based pagination. Returns `{ items, nextCursor }`. Pass `nextCursor` as `cursor` in the next request.

### GET /api/sync/entities

Same pattern as memories.

### GET /api/sync/edges

Same pattern as memories.

### GET /api/sync/chrono

Same pattern as memories.

### GET /api/sync/tombstones

```
GET /api/sync/tombstones?spaceId=general&sinceSeq=0
```

### POST /api/sync/tombstones

Push tombstones to a peer.

```json
{ "tombstones": [ { "_id": "...", "type": "memory", "seq": 42, ... } ] }
```

### POST /api/sync/batch-upsert

Push changes to a peer in bulk.

```
POST /api/sync/batch-upsert?spaceId=general&networkId=net-uuid
```

```json
{
  "memories": [ ... ],
  "entities": [ ... ],
  "edges": [ ... ]
}
```

### POST /api/sync/memory

Push a single memory.

### GET /api/sync/manifest

File manifest for a space (used by file sync).

```
GET /api/sync/manifest?spaceId=general
```

### GET /api/sync/file

Download a specific file from a peer.

```
GET /api/sync/file?spaceId=general&path=docs/notes.md
```

### POST /api/sync/file

Upload a file to a peer.

### GET /api/sync/merkle

```
GET /api/sync/merkle?spaceId=general
```

**Response** `200`:

```json
{ "root": "sha256-hex-string", "counts": { "memories": 100, "entities": 20, "edges": 10 } }
```

### GET /api/sync/gossip

Network gossip exchange (vote round propagation).

### POST /api/sync/file-tombstones

Push file deletion tombstones to a peer.

### GET /api/sync/file-tombstones

Fetch file deletion tombstones from a peer.

---

## MFA API

Base path: `/api/mfa` — requires admin token.

### Check MFA Status

```
GET /api/mfa/status
```

**Response** `200`:

```json
{ "enabled": false }
```

---

### Setup MFA

```
POST /api/mfa/setup
```

**Response** `201`:

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauth": "otpauth://totp/ythril:admin?secret=JBSWY3DPEHPK3PXP&issuer=ythril"
}
```

Scan the `otpauth` URI as a QR code in any TOTP app.

---

### Verify OTP Code

```
POST /api/mfa/verify
```

```json
{ "code": "123456" }
```

**Response** `200`:

```json
{ "valid": true }
```

---

### Disable MFA

```
DELETE /api/mfa
```

**Response** `204`.

---

## Conflicts API

Base path: `/api/conflicts`

### List Conflicts

```
GET /api/conflicts?spaceId=general
```

---

### Get Conflict

```
GET /api/conflicts/:id
```

---

### Resolve a Conflict

```
POST /api/conflicts/:id/resolve
```

```json
{
  "action": "keep-local",
  "rename": "report-v2.pdf",
  "targetSpaceId": "archive"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `action` | yes | One of: `keep-local`, `keep-incoming`, `keep-both`, `save-to-space` |
| `rename` | no | New filename for `keep-both`, or destination path for `save-to-space` |
| `targetSpaceId` | when `save-to-space` | Space to copy the incoming file into |

| Action | Result |
|--------|--------|
| `keep-local` | Deletes the conflict copy, keeps your file |
| `keep-incoming` | Replaces your file with the conflict copy |
| `keep-both` | Keeps both files; optionally renames the conflict copy |
| `save-to-space` | Copies the conflict file to another space, removes the conflict |

**Response** `200`:

```json
{ "status": "resolved" }
```

---

### Bulk Resolve Conflicts

```
POST /api/conflicts/bulk-resolve
```

```json
{
  "ids": ["conflict-id-1", "conflict-id-2"],
  "action": "keep-local"
}
```

Accepts the same `action`, `rename`, and `targetSpaceId` fields as single resolve. Applies the action to all listed conflicts.

**Response** `200`:

```json
{
  "resolved": 2,
  "failed": []
}
```

---

### Dismiss a Conflict

```
DELETE /api/conflicts/:id
```

Removes the conflict record without touching any files.

**Response** `204`.

---

## Setup API

### Health Check (unauthenticated)

```
GET /health
```

**Response** `200`:

```json
{ "status": "ok", "ts": "2026-03-25T14:00:00.000Z" }
```

---

### Prometheus Metrics (unauthenticated)

```
GET /metrics
```

Exposes a [Prometheus-compatible](https://prometheus.io/docs/instrumenting/exposition_formats/) metrics endpoint for production monitoring. No authentication required — Prometheus scrapers work without Bearer tokens.

**Response** `200` — `text/plain; version=0.0.4; charset=utf-8`:

```
# HELP ythril_http_requests_total Total HTTP requests by method, route pattern, and status code
# TYPE ythril_http_requests_total counter
ythril_http_requests_total{method="GET",route="/health",status_code="200"} 42
...
```

**Metrics exposed:**

| Metric | Type | Description |
|---|---|---|
| `ythril_http_requests_total` | counter | Total requests by method, route, status code |
| `ythril_http_request_duration_seconds` | histogram | Request latency by method and route |
| `ythril_http_request_size_bytes` | histogram | Request body size |
| `ythril_http_response_size_bytes` | histogram | Response body size |
| `ythril_memories_total` | gauge | Total memories by space |
| `ythril_entities_total` | gauge | Total entities by space |
| `ythril_edges_total` | gauge | Total edges by space |
| `ythril_chrono_entries_total` | gauge | Total chrono entries by space |
| `ythril_spaces_total` | gauge | Number of configured spaces |
| `ythril_embedding_duration_seconds` | histogram | Time to compute a single embedding |
| `ythril_embedding_queue_depth` | gauge | Pending embedding operations |
| `ythril_reindex_in_progress` | gauge | 1 if a reindex is running, 0 otherwise |
| `ythril_storage_used_bytes` | gauge | Storage used in bytes by area (brain, files, total) |
| `ythril_storage_limit_bytes` | gauge | Configured storage limits by area and tier (soft, hard) |
| `ythril_auth_attempts_total` | counter | Auth attempts by result (success, invalid) |
| `ythril_tokens_active` | gauge | Number of active (non-expired) tokens |
| `ythril_mcp_connections_active` | gauge | Current SSE connections |
| `ythril_mcp_tool_calls_total` | counter | Tool invocations by tool name and space |
| `ythril_sync_cycles_total` | counter | Sync cycles by network and status |
| `ythril_sync_items_pulled_total` | counter | Items received by type |
| `ythril_sync_items_pushed_total` | counter | Items sent by type |
| `ythril_sync_duration_seconds` | histogram | Time per sync cycle |

Default Node.js process metrics (`nodejs_*`, `process_*`) are also included via [prom-client](https://github.com/siimon/prom-client)'s `collectDefaultMetrics()`.

**Kubernetes example** (Prometheus Operator `ServiceMonitor`):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ythril
spec:
  selector:
    matchLabels:
      app: ythril
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

---

### Check Setup Status (unauthenticated)

```
GET /api/setup/status
```

**Response** `200`:

```json
{ "configured": false }
```

---

### Complete Setup (JSON)

```
POST /api/setup/json
```

```json
{
  "label": "My Ythril"
}
```

The `label` names this brain instance.

**Response** `201`:

```json
{
  "token": { "id": "...", "name": "Admin", "admin": true, ... },
  "plaintext": "ythril_initialAdminToken..."
}
```

---

## Admin API

### Reload Config

```
POST /api/admin/reload-config
Authorization: Bearer <admin-token>
```

Re-reads `config.json` from disk. Useful after manual edits. Any spaces added to the config since the last load are automatically initialized (MongoDB collections, indexes, vector search index, and file directories created). The built-in `general` space is ensured to exist.

**Response** `200`:

```json
{ "ok": true }
```

---

## About API

Base path: `/api/about` — requires auth.

### Instance Info

```
GET /api/about
```

**Response** `200`:

```json
{
  "instanceId": "a1b2c3d4-...",
  "instanceLabel": "My Brain",
  "version": "0.1.0",
  "uptime": "3d 14h 22m",
  "mongoVersion": "7.0.15",
  "diskInfo": { "total": 107374182400, "used": 53687091200, "available": 53687091200 }
}
```

### Server Logs

```
GET /api/about/logs?lines=200
```

**Response** `200`:

```json
{
  "lines": [
    "[2026-03-26T08:00:00.000Z] [INFO ] Server started on port 3200",
    "..."
  ]
}
```

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| `lines` | 200 | 1000 | Number of recent log lines (from in-memory ring buffer) |

---

## Theme API

Base path: `/api/theme` — unauthenticated (public).

The theme endpoint supports portal-style embedding where an outer shell injects branding into Ythril.

### Get Theme

```
GET /api/theme
```

**Response** `200`:

```json
{ "cssUrl": null }
```

Or, when a theme is configured:

```json
{ "cssUrl": "https://cdn.example.com/brand.css" }
```

### Configuration

Add a `theme` block to `config.json`:

```json
{
  "theme": {
    "cssUrl": "https://cdn.example.com/brand.css"
  }
}
```

The `cssUrl` must be a valid HTTPS URL (HTTP is allowed only for `localhost` during development). The URL is validated at runtime — invalid or non-HTTPS URLs are silently rejected.

### How It Works

1. **Static CSS** — on startup, the Angular SPA fetches `/api/theme`. If `cssUrl` is non-null, a `<link rel="stylesheet">` is injected into `<head>` before the app renders.
2. **Runtime tokens via `postMessage`** — the embedding page can send CSS custom property overrides to the Ythril iframe:

```js
iframe.contentWindow.postMessage({
  type: 'ythril:theme',
  tokens: {
    '--primary': '#0066cc',
    '--background': '#f5f5f5'
  }
}, 'https://your-ythril-host');
```

Only `--`-prefixed CSS custom properties are accepted. Standard CSS properties (e.g. `color`, `background`) are silently filtered out to prevent injection.

The `postMessage` handler validates `event.origin` — only same-origin messages are accepted.

### Security

- `cssUrl` is restricted to HTTPS (except `localhost` for development).
- `postMessage` origin is checked against `self`.
- Only CSS custom properties (`--*`) are applied from runtime tokens.
- The `Content-Security-Policy: frame-ancestors 'self'` header allows same-origin iframing while blocking cross-origin embedding.

---

## MCP (Model Context Protocol)

Ythril exposes an MCP server via SSE for AI agent integration. Each connection is scoped to a single space.

### Space Instructions

If a space has a `description`, it is sent to the MCP client as `instructions` during the server handshake. This tells the AI agent what the brain space contains before it calls any tools — no need for the agent to "discover" the space's purpose by reading data first.

### Read-Only Tokens

When connecting with a `readOnly` token, mutating tools (`remember`, `update_memory`, `delete_memory`, `upsert_entity`, `upsert_edge`, `create_chrono`, `update_chrono`, `write_file`, `delete_file`, `create_dir`, `move_file`, `sync_now`) are **hidden** from `tools/list` and rejected with an error if called directly. Read-only tools (`recall`, `recall_global`, `query`, `get_stats`, `list_chrono`, `read_file`, `list_dir`, `list_peers`) work normally.

### Connecting

```
GET /mcp/:spaceId
Authorization: Bearer <token>
Accept: text/event-stream
```

Returns an SSE stream with a `sessionId`.

### Sending Tool Calls

```
POST /mcp/:spaceId/messages?sessionId=<sessionId>
Authorization: Bearer <token>
Content-Type: application/json
```

### Available Tools

| Tool | Description |
|---|---|
| `remember` | Store a memory with optional tags and entity links |
| `update_memory` | Update an existing memory's fact, tags, or entity links |
| `delete_memory` | Delete a memory by ID |
| `recall` | Semantic search within the current space |
| `recall_global` | Semantic search across all accessible spaces |
| `query` | Structured MongoDB filter query (read-only) — supports `memories`, `entities`, `edges`, `chrono`, and `files` collections |
| `get_stats` | Return counts of memories, entities, edges, chrono entries, and files |
| `upsert_entity` | Create or update a named entity (with optional properties) |
| `upsert_edge` | Create or update a directed relationship |
| `create_chrono` | Create a chrono entry (event, deadline, plan, prediction, milestone) |
| `update_chrono` | Update an existing chrono entry |
| `list_chrono` | List chrono entries, optionally filtered by status, kind, or tags |
| `read_file` | Read a text file from the space file store |
| `write_file` | Write a text file to the space file store (optional `description` and `tags` stored as metadata) |
| `list_dir` | List directory contents |
| `delete_file` | Delete a file |
| `create_dir` | Create a directory |
| `move_file` | Move or rename a file/directory |
| `list_peers` | List all configured peer instances |
| `sync_now` | Trigger immediate sync (all networks or specific peer) |

### Example: remember

```json
{
  "method": "tools/call",
  "params": {
    "name": "remember",
    "arguments": {
      "fact": "Traefik v3 requires CRD patches for allowSlashesInPath",
      "tags": ["traefik", "gotcha"],
      "entities": ["Traefik"]
    }
  }
}
```

### Example: recall

```json
{
  "method": "tools/call",
  "params": {
    "name": "recall",
    "arguments": {
      "query": "Traefik routing configuration",
      "topK": 5,
      "tags": ["portal-backend"]
    }
  }
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | Natural language search query |
| `topK` | `number` | — | Max results to return (default `10`) |
| `tags` | `string[]` | — | Optional tag filter — only memories bearing **all** of these tags are returned. Mirrors the REST `?tag=` parameter and is useful for scoping a semantic search to a specific service or ADR (e.g. `["portal-backend"]`) |

`recall_global` accepts the same `tags` parameter and applies the filter across all searched spaces.

### Example: update_memory

```json
{
  "method": "tools/call",
  "params": {
    "name": "update_memory",
    "arguments": {
      "id": "a1b2c3d4-...",
      "fact": "Kubernetes pods are ephemeral by design (applies to all workload types)",
      "tags": ["k8s", "architecture", "workloads"]
    }
  }
}
```

All fields are optional — only provided fields are updated (partial update). If `fact` changes, re-embedding is triggered automatically. Requires a non-read-only token.

### Example: delete_memory

```json
{
  "method": "tools/call",
  "params": {
    "name": "delete_memory",
    "arguments": {
      "id": "a1b2c3d4-..."
    }
  }
}
```

Returns confirmation with the deleted ID. Creates a tombstone for sync propagation. Requires a non-read-only token.

### Example: get_stats

```json
{
  "method": "tools/call",
  "params": {
    "name": "get_stats",
    "arguments": {}
  }
}
```

Response:

```json
{
  "spaceId": "general",
  "memories": 1042,
  "entities": 156,
  "edges": 89,
  "chrono": 23
}
```

Works with any valid token (including read-only). For proxy spaces, returns aggregated counts across all member spaces.

### Example: query

```json
{
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": {
      "collection": "memories",
      "filter": { "tags": "traefik" },
      "limit": 20
    }
  }
}
```

**Valid `collection` values:**

| Value | Contents |
|-------|----------|
| `memories` | Memory facts with tags, entity links, and embeddings |
| `entities` | Named entities in the knowledge graph |
| `edges` | Directed relationship edges between entities |
| `chrono` | Chronological entries (events, deadlines, plans, predictions, milestones) |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `collection` | `string` | ✅ | One of the four values above |
| `filter` | `object` | ✅ | MongoDB filter document |
| `projection` | `object` | — | Fields to include (`1`) or exclude (`0`) |
| `limit` | `number` | — | Max documents (default `20`, max `100`) |
| `maxTimeMS` | `number` | — | Query timeout in ms (max `30000`) |

**Security**: The `query` tool rejects `$where`, `$function`, and deeply nested filters (>8 levels). Only safe read-only operators are allowed.

### MCP Client Configuration

For AI agents (Claude, Cursor, etc.), add to your MCP config:

```json
{
  "mcpServers": {
    "ythril": {
      "url": "http://localhost:3200/mcp/general",
      "headers": {
        "Authorization": "Bearer ythril_yourTokenHere"
      }
    }
  }
}
```

---

## Storage Quotas

Configured in `config.json` under `storage`:

```json
{
  "storage": {
    "brain": { "softLimitGiB": 50, "hardLimitGiB": 100 },
    "files": { "softLimitGiB": 100, "hardLimitGiB": 200 },
    "total": { "softLimitGiB": 150, "hardLimitGiB": 200 }
  }
}
```

| Condition | Behaviour |
|---|---|
| Below soft limit | Normal operation |
| Above soft limit | Write succeeds, response includes `storageWarning: true` |
| Above hard limit | Write rejected with `507` and `storageExceeded: true` |

---

## Pagination

### Offset Pagination (Brain API)

All list endpoints accept `limit` and `skip`:

```
GET /api/brain/general/memories?limit=100&skip=200
```

### Cursor Pagination (Sync API)

Sync endpoints return a `nextCursor` for efficient sequential reads:

```
GET /api/sync/memories?spaceId=general&sinceSeq=0&limit=200
→ { "items": [...], "nextCursor": "eyJzZXEiOjIwMH0" }

GET /api/sync/memories?spaceId=general&cursor=eyJzZXEiOjIwMH0&limit=200
→ { "items": [...], "nextCursor": null }
```

When `nextCursor` is `null`, all data has been consumed.


---

## OIDC (OpenID Connect) Authentication

Ythril supports an optional OIDC provider as an **additional** authentication path alongside PATs. When enabled, browser users can sign in using their corporate identity (Keycloak, Entra ID, Okta, Auth0, …) without a separately managed PAT.

### Configuration

Add an `oidc` block to `config.json`:

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://keycloak.example.com/realms/my-realm",
    "clientId": "ythril",
    "audience": "ythril",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin":    { "claim": "realm_access.roles", "value": "ythril-admin" },
      "readOnly": { "claim": "realm_access.roles", "value": "ythril-readonly" },
      "spaces":   { "claim": "ythril_spaces" }
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `enabled` | Yes | Set `true` to activate OIDC. All other fields are ignored when `false`. |
| `issuerUrl` | Yes | IdP realm URL. The well-known discovery document is fetched from `{issuerUrl}/.well-known/openid-configuration`. |
| `clientId` | Yes | OAuth2 client ID registered at the IdP. |
| `audience` | No | Expected `aud` claim. Defaults to `clientId`. |
| `scopes` | No | Scopes to request. Defaults to `["openid", "profile", "email"]`. |
| `claimMapping` | No | Maps IdP claims to Ythril permissions (see below). |

### Claim Mapping

`claimMapping` controls how JWT claims are translated to Ythril permissions:

| Key | Description |
|---|---|
| `admin` | When the rule matches, the session has admin access. |
| `readOnly` | When the rule matches, the session has read-only access. |
| `spaces` | The claim value is used as the list of allowed space IDs (must be a JSON string array). |

Each rule has:
- `claim` — dot-notation path inside the JWT payload (e.g. `"realm_access.roles"`).
- `value` (optional) — the claim must equal this value, or be an array containing it. When omitted, the claim simply needs to be truthy.

### Bearer Token Dispatch

| Bearer value | Validation path |
|---|---|
| Starts with `ythril_` | PAT — bcrypt verification (unchanged) |
| Anything else | JWT — JWKS signature + `iss`/`aud`/`exp` verification, then claim mapping |

PATs continue to work without any changes when OIDC is enabled.

### Login Flow (Browser)

When OIDC is enabled, the login page **auto-redirects** to the IdP — no manual click required.

1. User navigates to `/login`. The SPA fetches `/api/auth/oidc-info` and detects OIDC is enabled.
2. Browser fetches the IdP discovery document and redirects to the authorization endpoint.
3. User authenticates at the IdP.
4. IdP redirects back to `/oidc-callback?code=…&state=…`.
5. The Angular app exchanges the authorization code for tokens directly at the IdP token endpoint (PKCE — no client secret in the browser).
6. The resulting access token (JWT) is stored in `localStorage` and used for all subsequent API calls.

To bypass SSO auto-redirect and use a PAT instead, navigate to `/login?local`.

### Keycloak Setup

1. Create a new client in your realm with **Client authentication: OFF** (public client).
2. Set **Valid redirect URIs** to `https://your-ythril-host/oidc-callback`.
3. Add a mapper for `ythril_spaces` (if using space scoping): **User attribute → Token claim** mapping.
4. Set `issuerUrl` to `https://keycloak.host/realms/<realm>`.

After saving, run `POST /api/admin/reload-config` to apply the OIDC settings without a restart.

### Entra ID (Azure AD) Setup

1. In the Azure portal, go to **App registrations → New registration**.
2. Set **Redirect URI** to `https://your-ythril-host/oidc-callback` (type: **SPA**).
3. Under **Authentication**, ensure **Access tokens** and **ID tokens** are checked under Implicit grant and hybrid flows. Leave the **SPA** redirect URI in place — PKCE is used automatically.
4. Note the **Application (client) ID** — this is your `clientId`.
5. The `issuerUrl` is `https://login.microsoftonline.com/<tenant-id>/v2.0`.
6. Set `audience` to the Application (client) ID (Entra sets `aud` to the client ID by default).
7. To map roles, create **App roles** and assign users/groups. Use `claimMapping.admin.claim: "roles"` and `claimMapping.admin.value: "ythril-admin"`.
8. For space scoping, add an optional claim or use directory extensions to emit a `ythril_spaces` claim.

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0",
    "clientId": "YOUR_CLIENT_ID",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin": { "claim": "roles", "value": "ythril-admin" },
      "readOnly": { "claim": "roles", "value": "ythril-readonly" },
      "spaces": { "claim": "ythril_spaces" }
    }
  }
}
```

### Okta Setup

1. In the Okta admin console, go to **Applications → Create App Integration → OIDC → Single-Page Application**.
2. Set **Sign-in redirect URI** to `https://your-ythril-host/oidc-callback`.
3. Under **Assignments**, assign the users or groups who should have access.
4. Note the **Client ID** from the application's General tab.
5. The `issuerUrl` is `https://your-org.okta.com` (or `https://your-org.okta.com/oauth2/default` if using a custom authorization server).
6. To map admin/readOnly, create groups (e.g. `ythril-admin`, `ythril-readonly`) and configure a **Groups claim** in the authorization server: `claim name: groups`, `filter: Matches regex ythril-.*`.

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://your-org.okta.com/oauth2/default",
    "clientId": "YOUR_CLIENT_ID",
    "scopes": ["openid", "profile", "email", "groups"],
    "claimMapping": {
      "admin": { "claim": "groups", "value": "ythril-admin" },
      "readOnly": { "claim": "groups", "value": "ythril-readonly" },
      "spaces": { "claim": "ythril_spaces" }
    }
  }
}
```

### Auth0 Setup

1. In the Auth0 dashboard, go to **Applications → Create Application → Single Page Application**.
2. Set **Allowed Callback URLs** to `https://your-ythril-host/oidc-callback`.
3. Note the **Client ID** and **Domain** from the application settings.
4. The `issuerUrl` is `https://your-domain.auth0.com/`.
5. Set `audience` to your Auth0 API identifier if you have created a custom API; otherwise omit it.
6. To map roles, use **Auth0 Actions** (Login flow) to inject custom claims into the access token:

```js
// Auth0 Action — Login / Post Login
exports.onExecutePostLogin = async (event, api) => {
  const ns = 'https://ythril.example.com/';
  api.accessToken.setCustomClaim(ns + 'roles', event.authorization?.roles ?? []);
  api.accessToken.setCustomClaim(ns + 'spaces', event.user.app_metadata?.ythril_spaces ?? []);
};
```

```json
{
  "oidc": {
    "enabled": true,
    "issuerUrl": "https://your-domain.auth0.com/",
    "clientId": "YOUR_CLIENT_ID",
    "audience": "YOUR_API_IDENTIFIER",
    "scopes": ["openid", "profile", "email"],
    "claimMapping": {
      "admin": { "claim": "https://ythril.example.com/roles", "value": "ythril-admin" },
      "readOnly": { "claim": "https://ythril.example.com/roles", "value": "ythril-readonly" },
      "spaces": { "claim": "https://ythril.example.com/spaces" }
    }
  }
}
```

> **Note:** Auth0 requires namespaced custom claims (a URL prefix). Replace `https://ythril.example.com/` with your own namespace.

After saving any IdP configuration, run `POST /api/admin/reload-config` to apply the changes without a restart.

### Security Notes and Limitations

- **No server-side token revocation for OIDC.**  JWTs are validated statelessly (signature + `exp`).  Once issued by the IdP, a token is valid until it expires.  To revoke access, disable or remove the user at the IdP and set short token lifetimes (5–15 minutes recommended).
- **Silent token refresh.**  The SPA automatically schedules a background token refresh 60 seconds before the access token expires.  A hidden iframe is created with `prompt=none`; if the IdP session is still valid the user stays logged in with no interruption.  If the IdP session has also expired (or the IdP does not support `prompt=none`) the next API call returns 401 and the browser is redirected to the login page.  Configure your IdP's access token lifetime to balance UX vs security (5–15 minutes is a reasonable default).  This mechanism requires `Content-Security-Policy: frame-ancestors 'self'`, which the server sets by default.
- **`admin` and `readOnly` cannot both match.**  If both claim rules match the same JWT, `admin: true` takes precedence and `readOnly` is ignored.  Design your IdP roles to be mutually exclusive.
- **Spaces claim controls visibility.**  When a `spaces` claim is present in the JWT, the OIDC session can only see and modify those spaces.  If the claim is missing or not an array, the session has access to all spaces (same as a PAT with no `spaces` allowlist).  Users who cannot see expected spaces should check with their administrator that the IdP is emitting the correct claim values.
- **Config validation.**  When `oidc.enabled` is `true`, `issuerUrl` and `clientId` are required.  The server validates the OIDC config block at startup and on `reload-config` — a malformed block will prevent the server from starting.
- **Config reload required.**  Any change to the `oidc` block requires `POST /api/admin/reload-config` or a container restart to take effect.  The OIDC discovery document and JWKS key set are cached in memory and flushed on reload.

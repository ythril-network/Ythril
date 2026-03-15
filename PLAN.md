# Ythril — Plan

**Status:** Draft / Planning  
**Created:** 2026-03-12

---

## Overview

`ythril` is a self-contained private data and brain management stack. It runs as a Docker Compose application that any user can host on any machine. It is pluggable into any MCP client (Claude Desktop, VS Code Copilot, any OpenAI-compatible chat — anything that speaks MCP).

**Design goals:**
- Zero platform dependencies — no identity provider, no cluster, no platform-specific knowledge required to run
- Pluggable into any MCP client that speaks HTTP+SSE
- Complete private data management: brain (memory/entity graph), files, and structured queries
- **Multi-device:** connect your server ythril and your laptop ythril → one brain, one fileshare
- **Collaborative:** deliberately connect with another person → shared brain and fileshare, same mechanism
- **Spaces:** logically isolated areas within one brain (e.g. health, finance) — each has its own file root, MongoDB collections, and MCP endpoint; data cannot cross space boundaries
- **Brain networks:** groups of ythril brains that share specific spaces — gossip-based member discovery, no central coordinator
- Self-managed auth, storage quotas, and settings — no server-side admin needed
- Open-source — no platform-specific knowledge baked in; anyone can self-host

---

## Compose Stack

```yaml
services:
  ythril:
    image: ghcr.io/ythril/ythril:latest
    ports: ["3200:3200"]
    volumes:
      - /your/host/path:/data        # ← user edits this one line
      - ./config:/config
    environment:
      CONFIG_PATH: /config/config.json
    restart: unless-stopped

  ythril-mongo:
    image: mongo:7.0
    volumes:
      - ythril-mongo-data:/data/db
    restart: unless-stopped

volumes:
  ythril-mongo-data:
```

`ythril` is the only externally visible service. `ythril-mongo` is an implementation detail of `ythril` — consumers connect to `ythril`'s MCP and HTTP endpoints, never to MongoDB directly.

---

## Auth — PAT Model

Multiple named tokens per instance. Works like GitHub PATs.

### Token lifecycle

```
POST /api/tokens           create token → returns plaintext once, stores bcrypt hash
GET  /api/tokens           list tokens: [{ id, name, createdAt, lastUsed, expiresAt }]
DELETE /api/tokens/:id     revoke token (immediate; existing sessions using it are rejected)
```

- **First-run**: setup UI sets a **settings password** (bcrypt-hashed, stored in `secrets.json`). After setup, tokens are created exclusively via the settings UI, which is authenticated by that password via a session cookie. No token is generated at setup time — `/setup` is unauthenticated; `/settings` is password-protected; all API and MCP endpoints require a PAT Bearer token.
- **Name**: user-provided label (e.g. "my portal", "VS Code Copilot", "laptop ythril sync")
- **Expiry**: optional ISO 8601 date. Omit = no expiry.
- **Storage**: array of `{ id, name, hash, createdAt, lastUsed, expiresAt, spaces? }` in `config.json`. `hash` = bcrypt of 32-byte random token. Plaintext never persisted. `spaces` is an optional allowlist of space IDs; omitted = access to all spaces.
- **Token format**: `ythril_<base62(32 random bytes)>` — prefix makes them greppable in secrets managers. **Never logged** — `Authorization` header is redacted to `Bearer [redacted]` in all log output before writing.
- **Auth header**: `Authorization: Bearer <token>` on all API and MCP requests.
- **Rate limiting**: token creation and first-run setup endpoints are rate-limited to 10 requests / minute per IP. `/api/notify` is rate-limited to 60 requests / minute per sender `instanceId`. All other authenticated endpoints apply a soft global rate limit (configurable; default 300 req/min per token).

### First-run setup

No `config.json` → on startup, a one-time **setup code** is generated and printed to stdout: `[ythril] Setup code: XXXX-XXXX-XXXX` (16 hex chars, random). `GET /` redirects to `/setup`. The setup form requires the user to enter the setup code before submitting — this prevents an attacker who hits the URL first from owning the instance. The setup endpoint becomes 404 after first run; the setup code is discarded from memory immediately after use.

Setup form fields:
- Setup code (required, verified server-side)
- Instance label (e.g. "My Brain")
- Settings password (required; bcrypt-hashed and stored in `secrets.json`; used to authenticate the settings UI)

On submit: write `config.json` and `secrets.json` (both mode `0600`). No token is created at this point. User is redirected to `/settings` to log in and create their first token from there. `/setup` returns 404 after first run.

---

## Spaces

A **space** is a named, logically isolated container within a single ythril brain. Each space owns:
- a file root at `/data/{spaceId}/` — with a standard set of subdirectories auto-created on space creation
- MongoDB collections: `{spaceId}_memories`, `{spaceId}_entities`, `{spaceId}_edges`
- a dedicated MCP endpoint: `/mcp/{spaceId}`

No file or brain operation can cross space boundaries. A tool call on `/mcp/health` cannot touch `finance` files or collections — isolation is enforced at the routing and storage layer, not by convention.

### Default space: `general`

The `general` space is created automatically on first run. All tool calls and file operations in a plain instance without additional spaces operate in `general`. Behaviorally, a single-space ythril is identical to the original design.

### Standard folder structure

When a space is created, ythril creates the following under `/data/{spaceId}/`:

```
{spaceId}/
  incoming/      ← drop zone for unprocessed input
  processed/     ← files after processing/review
```

The folder names are configurable at creation time. `incoming` and `processed` are the defaults, not hardcoded. Additional subdirectories can be added freely after creation through the normal file tools.

### MCP endpoint per space

Each space is registered as a completely independent MCP server:

| Space | MCP endpoint |
|-------|--------------|
| `general` | `http://ythril:3200/mcp/general` |
| `health` | `http://ythril:3200/mcp/health` |
| `finance` | `http://ythril:3200/mcp/finance` |

The tool names (`remember`, `recall`, `read_file`, etc.) are identical in every space. The space context is determined by which endpoint the client registered — there is no `space` parameter on individual tools. This means: an AI client given only `/mcp/health` has no awareness of, and no access to, any other space.

### Space configuration (`config.json`)

`minGiB` and `flex` live directly on each space entry, alongside the space definition.

```jsonc
{
  "spaces": [
    {
      "id": "general",
      "label": "General",
      "builtIn": true,
      "folders": ["incoming", "processed"],
      "flex": 1                          // no floor; 1 share of flex pool
    },
    {
      "id": "health",
      "label": "Health Data",
      "builtIn": false,
      "folders": ["incoming", "processed"],
      "minGiB": 5,                        // guaranteed 5 GiB
      "flex": 1                          // 1 share of flex pool
    }
  ]
}
```

### Management API

```
GET    /api/spaces              list spaces with stats (memory count, file count, disk usage)
POST   /api/spaces              create space: { id, label, folders?: string[] }
DELETE /api/spaces/:id          initiate space deletion vote (see below) — only available to network members
```

**Space deletion is a governed vote**, not a unilateral action:
1. Any network member calls `DELETE /api/spaces/:id` — this opens a deletion vote across all networks that include this space.
2. For Braintree networks, the request is passed upstream to the root before the vote opens; the root initiates the round. Intermediate nodes relay it; they do not block it.
3. Once the vote opens, all members receive a notification via the notify channel (`event: "space_deletion_pending"`) in addition to gossip discovery.
4. Before casting a vote, every member is given the opportunity to **transfer the space's data** to another brain (export + import into a different space on their own instance). The vote UI shows a "Transfer before voting" affordance with a deadline reminder.
5. Vote pass conditions follow the network's governance type (same as invite/removal rounds). For Closed networks: unanimous. For Democratic: majority, no vetoes.
6. **Pass**: the space and all its data (files + collections + indexes) are deleted on all instances that voted yes. Members who voted veto retain their copy — they have explicitly declined deletion and become the sole owners of that data going forward.
7. **Fail or deadline reached**: deletion dismissed; space remains on all instances.
8. **Solo instance** (no networks): `DELETE /api/spaces/:id` falls back to the original direct confirmation: `body { confirm: true }`. No vote is needed.

### Open questions — Spaces

- **A-1: Per-space storage quotas** — ✅ DECIDED: `minGiB` (reserved floor) + `flex` weight (proportional share of remaining capacity after all minimums). Effective min on reconfiguration = `max(configuredMin, currentUsage)`. Global `total` remains the hard container.
- **A-2: Per-space token scoping** — ✅ DECIDED: tokens may carry an optional `spaces` allowlist. A token with no allowlist has access to all spaces (existing behaviour). A token with `"spaces": ["health"]` is rejected on any request targeting a different space. Stored in the token record in `config.json`.
- **A-3: Cross-space recall** — ✅ DECIDED: both. `recall_global` is a dedicated MCP tool that searches across all spaces the token has access to (read-only; respects token space allowlist). Queries all space indexes **in parallel** (Promise.all), merges results by score, returns top-K overall. Performance implication: N concurrent `$vectorSearch` queries — acceptable for typical space counts (≤5); documented in the UI for large deployments. The `general` space is the fallback write target. **No message broker (e.g. RabbitMQ):** ythril has zero external dependencies by design; parallel async HTTP/MongoDB calls are sufficient for the expected concurrency; a broker would contradict the self-contained deployment model.
- **A-3a: Name of the fallback space** — ✅ DECIDED: `general`.

---

## MCP Tool Surface

Fully MCP-spec compliant. Works with any MCP client that speaks HTTP+SSE.

Each space has its own independent MCP endpoint at `/mcp/{spaceId}`. The tools below are available in every space. When a client is registered against a space endpoint, all operations are automatically scoped to that space — tool signatures do not include a `space` parameter.

### Brain tools

| Tool | Input | Description |
|------|-------|-------------|
| `remember` | `fact: string`, `entities?: string[]`, `tags?: string[]` | Embed + store memory using the configured embedding model; upsert entities into graph. Stamps `author` and `seq` on every document. |
| `recall` | `query: string`, `topK?: number` | Embed query → `$vectorSearch` on memories → `$graphLookup` on entity edges → ranked results |
| `query` | `collection: string`, `filter: object`, `projection?: object`, `limit?: number`, `maxTimeMS?: number` | Read-only structured query against ythril-mongo user collections; collection allowlist enforced; filter validated against operator whitelist; `maxTimeMS` defaults to 5000 ms to prevent runaway scans. |

### File tools

| Tool | Input | Description |
|------|-------|-------------|
| `read_file` | `path: string` | Read file contents (text); sandboxed to configured root |
| `write_file` | `path: string`, `content: string` | Write/overwrite file; creates parent dirs |
| `list_dir` | `path?: string` | List directory entries with name, type, size, modified |
| `delete_file` | `path: string` | Delete file or empty directory |
| `create_dir` | `path: string` | Create directory tree |
| `move_file` | `from: string`, `to: string` | Move or rename file/directory |

**`query` filter whitelist:** `$where`, `$function`, `$accumulator` and all JS-executing operators are rejected. Allowed: comparison (`$eq $ne $gt $gte $lt $lte $in $nin`), logical (`$and $or $not $nor`), element (`$exists $type`), array (`$all $elemMatch $size`). `maxTimeMS` defaults to 5 000 ms; caller may reduce but not increase it beyond a server-side cap (default 30 000 ms).

### Embedding model

The embedding model is configured in `config.json` under `"embedding"`. ythril calls an **OpenAI-compatible `/v1/embeddings` endpoint** — this can be a local model server (e.g. LM Studio, Ollama) or a remote API.

```jsonc
{
  "embedding": {
    "baseUrl": "http://localhost:1234/v1",  // OpenAI-compatible endpoint
    "model": "nomic-embed-text-v1.5",     // model identifier passed to the API (locked — changing requires full re-index)
    "dimensions": 768,                     // output vector dimensions (must match index)
    "similarity": "cosine"                 // index similarity metric: cosine | dotProduct | euclidean
  }
}
```

**Defaults:** if no embedding config is present, ythril uses `http://localhost:11434/v1` (Ollama default) with `nomic-embed-text-v1.5` (768 dimensions, cosine). This model runs fully offline on CPU and requires no API key — consistent with the zero-platform-dependency design goal.

**Index creation:** on space creation, ythril creates a MongoDB `$vectorSearch` index with the configured `dimensions` and `similarity` values. The index name is `{spaceId}_memories_embedding`.

**Model change:** changing `model` or `dimensions` in config **requires a full re-embedding** of all memories in all spaces. ythril detects a mismatch between the stored `embedding.model` recorded on the collection vs the configured model and refuses to accept `recall` calls until the user triggers a re-index from Settings → Storage. Re-indexing is a background job; `recall` returns an error during re-indexing.

### Edge schema

All edges in `{spaceId}_edges` use a consistent structure:

```jsonc
{
  "_id": "<uuid>",
  "from": "<entityId>",   // source entity _id
  "to": "<entityId>",     // target entity _id
  "label": "string",      // relationship type, e.g. "knows", "related_to"
  "weight": 1.0,          // optional numeric strength
  "createdAt": "<iso>",
  "seq": 0,               // monotonic sequence number per instance (see sync)
  "author": { "instanceId": "...", "instanceLabel": "..." }
}
```

Entities in `{spaceId}_entities`:

```jsonc
{
  "_id": "<uuid>",
  "name": "string",
  "type": "string",        // e.g. "person", "place", "concept"
  "tags": [],
  "createdAt": "<iso>",
  "seq": 0,
  "author": { "instanceId": "...", "instanceLabel": "..." }
}
```

All three document types (memories, entities, edges) carry `createdAt` and `seq` — required for incremental sync.

| Tool | Input | Description |
|------|-------|-----------|
| `list_peers` | — | List registered sync peers with last-sync status |
| `sync_now` | `peerId?: string` | Trigger manual sync (all peers or one); `peerId` is validated as an exact match against a registered network member ID — never used as a URL or passed to any network call directly; returns sync summary |


---

## File Management — HTTP API + UI

File upload/download is HTTP, not MCP (binary transfer, not LLM interaction).

```
GET    /api/files/*path                Download file (Content-Disposition: attachment) or list dir as JSON
POST   /api/files/*path                Upload file (multipart/form-data + Content-Range for chunked); creates parent dirs
DELETE /api/files/*path                Delete file or directory (recursive with body { force: true })
PATCH  /api/files/*path                Move/rename: body { destination: string }

GET    /api/conflicts                  List unresolved conflicts [{id, path, local, incoming}] — filtered to spaces the token has access to
POST   /api/conflicts/:id/resolve      Resolve: { action: "keep-local"|"keep-incoming"|"keep-both"|"discard-incoming", rename?: string }
```

**File upload limits:** a configurable `maxUploadBodyBytes` (default: 5 GiB) is enforced at the HTTP layer **per individual chunk request** before any file processing. The server returns HTTP 413 if a single request exceeds this limit. There is no per-file size limit — arbitrarily large files (including multi-GiB video) are supported by splitting them into multiple chunks via `Content-Range`; the UI does this automatically. Total file size is only bounded by the configured storage quota.

**File manager UI** at `/files`:
- Directory tree sidebar + main pane listing
- Upload via drag-and-drop or file picker (chunked automatically for large files)
- Download / Delete / Rename / Move via context menu
- Breadcrumb navigation
- File preview for text, images, PDFs
- Conflict badge in navbar when unresolved conflicts exist → links to `/conflicts`

**Conflict resolution UI** at `/conflicts`:
- List of unresolved conflicts: file path, local version (size, modified, instance name), incoming version (size, modified, instance name)
- Per-conflict actions: Keep local · Keep incoming · Keep both (with optional rename of either) · Discard incoming
- Bulk resolve: apply a default strategy to all selected conflicts

---

## Brain Management — HTTP API + UI

```
GET    /api/brain/memories        List memories (paginated, filterable by tag/entity)
DELETE /api/brain/memories/:id    Delete a specific memory
DELETE /api/brain/memories        Wipe all memories (requires body { confirm: true })
GET    /api/brain/entities        List entities (paginated)
DELETE /api/brain/entities/:id    Delete entity + its edges
GET    /api/brain/stats           Count memories, entities, edges; index status
```

**Brain UI** at `/brain`:
- Memory list with search, tag filter, entity filter
- Entity graph viewer (simple node/edge visualization)
- Bulk delete with confirmation

---

## Settings UI

Available at `/settings`. Sections:

**Tech stack:** Angular. Ythril components are standalone (no NgModule).

### 1. Tokens
- Table: name, created, last used, expiry, revoke button
- "New token" form: name, optional expiry → shows plaintext once

### 2. Storage
- Used / allocated for files (disk usage of `/data`)
- Used / allocated for brain data (MongoDB data dir size)
- Set soft and hard quotas per area
- Hard quota: `write_file` and `remember` reject with structured error when exceeded
- Soft quota: warning shown in UI + tool response includes `"storageWarning": true`

### 3. Sync
- Active networks table: label, type, scoped spaces, member count, last sync time, pending votes badge
- Per-network drill-down: member list (label, URL, last sync, status), pending vote indicator, Leave button
- Sync schedule: cron expression per network (empty = manual only; human-readable preview, e.g. "every hour")
- Trigger sync now per network
- Sync history log (last N results per network)
- Conflict badge in nav (also visible from Files page) showing count of unresolved conflicts → links to `/conflicts`

### 4. About
- Instance label, ythril version, uptime
- ythril-mongo version
- Disk info
- Log viewer (last N lines of ythril stdout)

### 5. Spaces
- Table: id, label, memory count, file count, disk used, created date, delete button
- "New space" form: id (lowercase slug), label, optional custom folder names (default: `incoming`, `processed`)
- Delete confirmation modal: shows item counts, warns data is unrecoverable

### 6. Networks
- "Create network" form: label, type (Closed / Democratic / Club / Braintree), scoped spaces, voting deadline → generates invite key (shown once)
- "Join network" form: existing member URL + invite key → submit join request → waiting state until vote passes or fails
- Pending votes banner: list of open votes on your instance with Yes / Veto buttons per candidate
- Invite key management: rotate (invalidates old key), view current key

---

## Multi-Instance Sync

All syncing between ythril instances happens through **networks** (see [Brain Networks](#brain-networks) below). There is no separate "peer" concept — one person with multiple devices, two people collaborating, a tree-shaped organisation — all of these are modelled as networks of the appropriate type.

When two instances are connected, data is merged into one shared space. There is no per-origin filtering on `recall`; the user controls scope by controlling network membership.

### Author attribution

Every memory document and every entity carries:
```json
{ "author": { "instanceId": "<random-uuid-generated-at-first-run>", "instanceLabel": "my server ythril" } }
```
This is **provenance only** — displayed in the Brain UI next to each memory, available in `recall` results for context. It is not used as a filter; `recall` searches the whole graph regardless of origin. `instanceId` is a random UUID generated once at first run and stored in `config.json`; it is entirely independent of the instance label. Label is display-only and can be changed without affecting identity.

### Entity identity

Two instances may each have an entity named `"Alice"` with different `_id`s. The system does **not** auto-merge them — this is the same situation as mentioning Alice on two different days in a single instance. Semantic search surfaces both if they are relevant; the LLM resolves whether they refer to the same real-world entity. Explicit merge is a user action (future: Brain UI "merge entities" affordance).

### Sync protocol (HTTP, ythril-to-ythril)

ythril authenticates **outbound** to a peer using the peer's token. All outbound connections to peer URLs enforce strict TLS certificate validation by default. A per-peer `skipTlsVerify: true` flag may be set in `secrets.json` for private-CA or self-signed setups, but the UI displays a security warning on any peer with this enabled and it must never be the default. (given to ythril by the peer owner when registering the peer) is stored in a separate `secrets.json` file, which is:
- Never written to `config.json`
- Created with mode `0600` at first write
- Excluded from any export, backup, or debug-info endpoints

The member record in `config.json` stores only `tokenHash` (for inbound validation when the peer syncs back). The `secrets.json` structure for outbound credentials:

```jsonc
{
  "peerTokens": {
    "<instanceId>": "ythril_..."  // plaintext token for outbound requests to this peer
  }
}
```

ythril authenticates to its peer using the peer's token, calling the peer's HTTP API:

```
# File sync
GET  /api/sync/manifest?since=<isoTimestamp>   returns {path, sha256, size, modified}[] for files changed since timestamp; omit for full manifest
GET  /api/files/*path                          download specific file
POST /api/files/*path                          upload file to peer

# Brain sync (incremental, paginated)
GET  /api/sync/memories?sinceSeq=<n>&limit=<n>&cursor=<token>   returns { items: [{_id, seq, deletedAt?}], nextCursor } — IDs + seq only, no content
GET  /api/sync/memories/:id                    download full memory document (skip if deletedAt present — apply tombstone)
POST /api/sync/memories                        upsert memory document on peer; if incoming deletedAt > local updatedAt, apply tombstone (delete local + persist tombstone)
GET  /api/sync/entities?sinceSeq=<n>&limit=<n>&cursor=<token>   paginated entity IDs + seq
POST /api/sync/entities                        upsert entity
GET  /api/sync/edges?sinceSeq=<n>&limit=<n>&cursor=<token>      paginated edge IDs + seq
POST /api/sync/edges                           upsert edge

# Tombstones (explicit deletion propagation)
GET  /api/sync/tombstones?sinceSeq=<n>         { memories: [{_id, seq, deletedAt}], entities: [...], edges: [...] }
```

**Incremental sync:** each instance maintains a per-space monotonic `seq` counter, incremented on every write and delete. Sync agents pass the last known `seq` received from each peer; only records with `seq > lastKnown` are transferred. First sync (or after long absence) passes `sinceSeq=0` for a full catch-up.

**Deletion propagation:** deleting a brain document writes a tombstone `{ _id, type, seq, deletedAt, author }` to `{spaceId}_tombstones`. Tombstones are never themselves deleted — they are the authoritative deletion record. On receiving a tombstone during sync, the recipient deletes the live document (if present) and stores the tombstone. This prevents resurrection of deleted memories.

**File manifest:** uses `sha256` (not MD5) as the content hash. `modified` (mtime) is included for informational display only — it is never used as a conflict signal; only hash mismatch triggers conflict detection.

**Brain conflict resolution:**
- Identity: same `_id` on two instances = same logical document (intentional, from prior sync)
- Update conflict: same `_id`, different content — resolved by `seq`: higher seq wins. If seq is equal (independent concurrent edits), the incoming version is treated as a *co-author revision*: both are stored, with the incoming content forked as a new document carrying `{ forkOf: <original_id>, author: <incoming_author> }`. The UI shows forks alongside the original; user may merge or discard.
- Deletion vs update: a tombstone (`deletedAt`) overrules any live document with equal or lower `seq`. A live document with higher `seq` than the tombstone wins — deletion is overruled by a newer update.

### Notify channel

```
POST /api/notify    { networkId, instanceId, event: "vote_pending" | "member_departed" | "space_deletion_pending" }
     → 204 No Content (authenticated; same network-scoped token used for sync)
```

No data is transferred. Recipient checks for pending votes or topology changes on their next scheduled sync. Used direction-agnostically — a leaf can notify its ancestors without needing to push data to them.

- [x] **DECIDED S-1: conflict resolution for files** — On conflict (both instances modified the same file since last sync), the incoming version is renamed `<basename>_<iso-ts>_<instanceName>.<ext>` and kept alongside the local file. No data is silently overwritten. A `/conflicts` UI lists all unresolved conflicts; user chooses: keep local, keep incoming, keep both (with optional rename), or discard incoming. Bulk-resolve with a default strategy also available.
- [x] **DECIDED S-2: sync scheduling** — Cron expression per peer from v1. Stored in peer config as `{ "schedule": "0 * * * *" }`. Empty/omitted = manual-only. UI exposes a cron input with a human-readable preview (e.g. "every hour") in Settings → Sync peer form.
- [x] **DECIDED: peer auth for sync direction "Both"** — Each side registers the other independently using its own token. No shared secret. Symmetric sync is simply two independent registrations, each with its own directional config. Applies to `closed`, `democratic`, and `club` networks only. Braintree members always use `direction: "push"` — data flows parent → child; no reverse registration.
- [x] **DECIDED S-3: large file handling** — Chunked upload with resume from v1. `POST /api/files/*path` supports `Content-Range` header; server accumulates chunks under a temp path and assembles on receipt of the final chunk. Resume: client re-sends from last acknowledged offset.

---

## Hub (multi-brain UI)

When multiple ythril brains run on the same machine (each on its own port with its own config and MongoDB), a **hub** provides a unified administration UI without a new backend service.

The hub is a static config file listing known local brains:

```jsonc
// hub.json (optional, co-located with config/)
{
  "brains": [
    { "label": "Personal",  "url": "http://localhost:3200" },
    { "label": "Work",      "url": "http://localhost:3201" }
  ]
}
```

The settings UI reads `hub.json` (served as a static asset) and renders a brain switcher in the header. Selecting a brain navigates the settings context to that brain’s origin — each brain authenticates independently with its own settings password. No proxy, no central auth, no new process.

If `hub.json` is absent, the UI shows only the current brain (single-brain mode, default).

---

## Brain Networks

### Data ownership philosophy

Every ythril instance is sovereign. Its owner is a **true owner** of the data on that instance — this is a physical fact, not a policy. When you accept another instance into a network with you, you accept shared ownership of the data that flows between you. The network structure controls who can join, but it can never control what members do with data on their own machines.

- **Any member can leave at any time**, unilaterally, without permission. On leaving, a departure message is gossiped to the network; other members stop syncing. The leaver keeps all data they had at the moment of departure.
- **Off-grid**: a departing member may start their own network from their copy of the data — they become the root of a new tree.
- The root of a Braintree may **not** prevent a leaf from leaving with data. By accepting a leaf into the network, you accepted shared ownership.
- **Network-voted removal (force-leave)**: a member can be ejected by a vote of the remaining members, using the same governance structure as an invite. The removed member is disconnected from the network — other members stop syncing with them. The removed member **keeps all data on their own instance**; this is physically unavoidable and explicitly accepted. Voting someone out of the network does not delete anything from their machine.
- **Force-delete does not exist.** There is no mechanism to delete data from another member's instance. The two are categorically different: network membership (who syncs with whom) is governable; what someone does with data on their own machine is not.

### Network types

All types share the same mechanics for both **joining** and **network-voted removal**: an invite key (for joins) or a removal proposal (for ejection) triggers a voting round with a deadline, and the result either executes the action or is dismissed.

| Type | Pass condition | Veto right | Applies to |
|------|---------------|------------|------------|
| **Closed** | All current members vote yes | Implicit (any no = fail) | Join + removal. Unanimous on both. For personal multi-device (solo member), every join and removal is instant self-approval. |
| **Democratic** | ≥ 50% vote yes **and** zero vetoes | Explicit | Join + removal. Majority decides; any single member can block either direction. |
| **Club** | The member who issued the key (join) or proposed the removal votes yes alone | None | Join: only the inviter decides. Removal: only the proposer decides (one person can eject). Consider implications before using Club for collaborative groups. |
| **Open** | Automatic on valid key presentation | None | Join only. Recognised as dangerous — excluded from v1 scope. |
| **Braintree** | All members on the path from root to the relevant node vote yes | Implicit per ancestor | Join: ancestors of the inviting node. Removal: ancestors of the node being removed. |

### Voting and deadline

#### Join round

1. A member issues an **invite key** and shares it (+ their URL) with the candidate out-of-band
2. The candidate calls `POST /api/networks/:networkId/join` with the key → a voting round opens
3. All eligible voters are notified on their next gossip cycle; they see a pending vote in Settings → Networks
4. Each voter casts Yes or Veto via their own UI
5. Votes propagate through the gossip network; any member can relay others' votes
6. **Pass**: pass conditions met before deadline → candidate added to member list, receives full member list, begins syncing
7. **Fail or deadline reached**: key is invalidated; candidate is not added; a new key must be issued for any future attempt

#### Removal round

1. Any member calls `POST /api/networks/:networkId/members/:instanceId/remove` → a removal voting round opens
2. All eligible voters are notified via gossip; they see a pending removal vote in Settings → Networks
3. Each voter casts Yes or Veto
4. Votes propagate via gossip
5. **Pass**: pass conditions met before deadline → the target member is removed from the member list; all remaining members stop syncing with them; the removed instance is notified of its ejection on their next attempted sync
6. **Fail or deadline reached**: removal dismissed; the member remains
7. The removed member **keeps all data on their own instance** and may go off-grid or join/found another network

The voting deadline is configured per network (default: 48 h). There are no push notifications — members discover pending votes on the next sync cycle. The UI should make pending votes visually prominent.

### Invite key

```
ythrilnetwork_<base62(32 random bytes)>
```

- One active invite key per network at a time; rotating issues a new key and immediately invalidates the old one
- Keys are only valid during an active voting round; an unused key becomes valid when a candidate presents it (opening the round)
- After a round concludes (pass or fail), the key is consumed; a fresh key is required for the next candidate
- The key is NOT an ongoing credential — after joining, member-to-member authentication uses normal PAT tokens
- **Storage**: invite keys are bcrypt-hashed at rest in `config.json`, identical to PAT handling. The plaintext is shown once in the UI and never persisted.

### Network configuration (`config.json`)

```jsonc
{
  "networks": [
    {
      "id": "a1b2c3d4",
      "label": "Personal devices",
      "type": "closed",
      "spaces": ["general"],
      "votingDeadlineHours": 48,
      "members": [
        { "instanceId": "...", "label": "server", "url": "https://...", "tokenHash": "...", "direction": "both", "children": [] },
        { "instanceId": "...", "label": "laptop",  "url": "https://...", "tokenHash": "...", "direction": "both", "children": [] }
      ]
    }
  ]
}
```

For `braintree` networks, `direction` is always `"push"` (parent → child). A Braintree member config also carries `parentInstanceId`:

```jsonc
// Braintree member record (direction is always "push", never "both" or "pull")
{ "instanceId": "...", "label": "Node A", "url": "https://...", "tokenHash": "...", "direction": "push", "parentInstanceId": "<root-id>", "children": ["<leaf-a1-id>"] }
```

For all other network types (`closed`, `democratic`, `club`) `direction` is `"both"` — sync is symmetric.

### Scope

A network is scoped to one or more spaces at creation time. Only scoped spaces are synced within the network; all other spaces remain private. Scope is fixed at creation and cannot be changed after the first member joins.

### Gossip protocol

Piggybacked on the regular sync cycle. Two things are exchanged after each data sync:

```
# Member list propagation
GET  /api/sync/networks/:networkId/members
     → [{ instanceId, label, url, lastSeen, direction, children: string[], parentInstanceId? }]
POST /api/sync/networks/:networkId/members
     ← announce members you know about

# Vote propagation
GET  /api/sync/networks/:networkId/votes
     → [{ roundId, type: "join"|"remove", subjectInstanceId, subjectLabel, deadline, votes: [{ instanceId, vote }] }]
POST /api/sync/networks/:networkId/votes/:roundId
     ← submit or relay this instance's vote { vote: "yes" | "veto" }
```

No central coordinator. Membership and votes propagate through the graph within one sync cycle per hop.

**Gossip poisoning protection:** a member record is only accepted as authoritative from the instance it describes. When instance B relays a record claiming to be about instance A, ythril compares it against the last directly-received record from A. Any field that differs from A's own last-known record (URL, tokenHash, children, direction) is flagged as a conflict and held for manual review rather than silently applied. A member can only update their own record.

### Braintree topology

In a Braintree network, members form a directed tree rooted at the creator. Each member has a `parentInstanceId`. A new leaf is approved by all ancestors on the path from the inviting node up to the root.

**Data flows parent → child only (push).** A child never pushes data back to its parent. A node only ever receives data that its parent already has — there is no upward propagation. Node A and Node B share only what the Root has already written or received; they have no direct connection to each other. `direction` is always `"push"` for every member in a Braintree network — no member ever has `"both"` or `"pull"`.

```
  Root (founder)
    ├── Node A
    │     ├── Leaf A1   ← joining requires Root + Node A to vote yes
    │     └── Leaf A2
    └── Node B
          └── Leaf B1   ← joining requires Root + Node B to vote yes
```

Leaves can leave at any time and go off-grid. The root has no technical ability to prevent this.

### Topology coverage

Topologies fall out of tree structure and multi-network membership alone — no separate pull concept needed. Any communication pattern reduces to one of:

| Pattern | How it maps |
|---------|-------------|
| Full mesh | Any non-Braintree network; gossip naturally produces all-to-all |
| Tree | Braintree |
| Pub-sub (star) | Braintree with depth 1; root is `push`-only toward leaves |
| Chain (linear) | Braintree with width 1 per node |
| Aggregator / Leech | A leaf node that is simultaneously a leaf in multiple separate Braintree networks; receives from all, local recall merges everything — no directional config needed |
| Broadcast / Archive | Braintree with depth 1, width 1; source is push-only |
| DAG (multiple parents) | Multi-network membership; data from all synced spaces merges into local collections; `recall` is always local |
| Hub-and-spoke (restricted inter-spoke) | Not modelled. Use separate networks. |

**Key insight**: `direction` is binary — `push` or `both`. There is no `pull`. Sender always controls data flow; a receiver can never demand data from a sender who doesn't want to send. Network type governs *who is allowed in*; direction governs *whether a member pushes at all*.

### Sync direction per membership

Every member record carries a `direction` field:
- `both` (default) — bidirectional, full peer
- `push` — this instance pushes to the network but does not accept inbound sync from it (archive / one-way publisher mode)

`pull` is not supported. The sender always controls data flow. A receiver can never demand data from a sender who doesn't want to send — inverting that would undermine the data ownership model. An aggregator that wants data from multiple sources joins those sources' networks as a regular member (`both`) — it gets the data because the senders push.

- **N-1: Merkle integrity** — ✅ DECIDED: opt-in per network. When enabled (`"merkle": true` in network config), each space maintains a running Merkle root over its memory set; the root is exchanged at sync time and members reject syncs where the remote root diverges from expected. Disabled by default.
- **N-4: Open network type** — ✅ DECIDED: not implemented, not planned. Rationale: an open network has no join gate, which makes it trivially exploitable — bots can flood the brain with garbage, coordinated actors can manipulate shared memory at scale, and there is no meaningful way to distinguish a legitimate member from an attacker. ythril's data ownership model is built on explicit bilateral consent at every join; the Open type directly contradicts that foundation. Community forks may implement it, but ythril will not ship it and will not provide an internal extension point that makes it easy to add.
- **N-5: Braintree topology verification** — ✅ DECIDED: bidirectional edge ownership. `parentInstanceId` alone (child-declared) is insufficient because push/both routing already requires the parent to maintain an authoritative list of its children. Edges are therefore co-declared: the parent holds `children: [instanceId, ...]` in its member record; the child holds `parentInstanceId`. Gossip propagates both. An edge is valid only when both sides agree. If a child claims a parent that does not list that child, the edge is rejected and flagged as inconsistent; the parent’s record is authoritative. This prevents position forgery without requiring cryptographic keypairs.
- **N-6: Voting UX without push** — ✅ DECIDED: deadline is configurable by the inviting brain owner; default 48 h; stored on the vote record. Syncs remain scheduled-only — no forced sync is triggered by a pending vote. A separate lightweight notify channel is required (see N-8); without it, a leaf’s vote cannot reach ancestors in a push tree before the deadline.
- **N-8: Notify channel design** — ✅ DECIDED: `POST /api/notify` requires a valid network-scoped token (the same token used for sync). No data payload — body contains only `{ networkId, instanceId, event: "vote_pending" | "member_departed" }`. Unauthenticated requests are rejected with 401. This prevents external actors from using the notify endpoint to probe network membership or trigger spurious syncs.
- **N-7: Orphaned subtree on departure** — ✅ DECIDED: option C — auto re-parent. When a node leaves, it fires a notification via the notify channel (N-8) to all known network members before disconnecting. On receiving the notification, each parent that had the departing node as a child registers its grandchildren as direct children (adding them to its own `children[]` record). Gossip propagates the updated topology in the next sync cycle. If the departing node leaves without notice (crash / off-grid), orphaned nodes enter a suspended state until the next sync reaches the root and the inconsistency is detected — at which point the root auto-adopts them.

---

## Space Allocation

Each space can declare a `minGiB` (reserved floor) and a `flex` weight (proportional share of remaining capacity). The `storage.total` is the container.

**Allocation model:**
1. Sum all `minGiB` values across spaces. This is the reserved pool.
2. Remaining capacity = `total.hardLimitGiB` − reserved pool = *flex pool*.
3. Each space's flex ceiling = `minGiB` + (`flex` / sum-of-all-flex) × flex pool.
4. A space that has not yet reached its `minGiB` is the equivalent of CSS `min-width`; flex distributes the leftover proportionally.
5. A space with no `flex` has a hard ceiling of exactly its `minGiB`.

**Reconfiguration rule:** effective `minGiB` = `max(configuredMinGiB, currentUsageGiB)`. Lowering `minGiB` below current usage silently clamps to current usage; the UI shows a warning. This prevents a reconfiguration from immediately placing a space into violation.

Quotas stored in `config.json`:

```jsonc
{
  "storage": {
    "total": { "softLimitGiB": 150, "hardLimitGiB": 200 }, // required if any quota is set
    "files": { "softLimitGiB": 50,  "hardLimitGiB": 100 }, // optional per-area (across all spaces)
    "brain": { "softLimitGiB": 5,   "hardLimitGiB": 10  }  // optional per-area (across all spaces)
  }
  // per-space minGiB/flex live on each space entry in the "spaces" array (see §Spaces)
}
```

`total` is the required anchor. Per-area limits (`files`, `brain`) are global across all spaces and optional. Per-space allocation (`minGiB`, `flex`) is also optional; omitting both means no per-space limit.

- **No limit by default** (omitted = unlimited). User opts in to limits.
- **Hard limit**: write operations (`write_file`, `remember`) check current usage before proceeding; reject with HTTP 507 / MCP structured error if exceeded.
- **Soft limit**: warning injected into MCP tool response metadata + displayed in settings UI.
- **Usage check**: computed at write time from `/data` `du` + MongoDB `dbStats`. Real-time on every write — no cache.

### Storage decisions

- [x] **DECIDED Q-1: quota scope** — Total combined quota is **mandatory** (the anchor); per-area quotas (files + brain separately) are **optional** and user-configured. Whichever limit — total or per-area — is hit first triggers the enforce response. The Settings → Storage UI exposes all three fields; only `total` is required to enable quota enforcement.
- [x] **DECIDED Q-2: quota enforcement granularity** — Real-time per-write check. `du` + `dbStats` called synchronously on every write operation before proceeding. No cached usage value. Accuracy over performance.

---

## Deployment

Edit the `volumes:` path to point at your file storage root. Everything else is ready to run.

```yaml
# docker-compose.yml
services:
  ythril:
    image: ghcr.io/ythril/ythril:latest
    ports: ["3200:3200"]
    volumes:
      - /your/host/path:/data        # ← edit this to your storage root
      - ./config:/config
    environment:
      CONFIG_PATH: /config/config.json
    restart: unless-stopped

  ythril-mongo:
    image: mongo:7.0
    volumes:
      - ythril-mongo-data:/data/db
    restart: unless-stopped

volumes:
  ythril-mongo-data:
```

Once running, complete first-run setup at `http://localhost:3200/setup` (enter the setup code printed to stdout) to generate your first token. Expose the service via a reverse proxy of your choice (nginx, Traefik, Caddy, etc.) with TLS.

**File permissions:** `config.json` and `secrets.json` are created and maintained at mode `0600` (owner read/write only). ythril will refuse to start if either file is world-readable.

**TLS:** ythril does not terminate TLS itself — use a reverse proxy. On startup, ythril checks whether it is reachable via HTTP (no TLS) on a non-loopback address. If so, it logs a prominent `[WARN] Running without TLS on a non-localhost address. All data including brain content and tokens will be transmitted in plaintext.` warning. To suppress: set `allowInsecurePlaintext: true` in `config.json` (explicit opt-in, not the default).

---

## MCP Client Integration

ythril exposes a standard MCP HTTP+SSE endpoint. Register it in any MCP-capable client or portal:

1. Complete first-run setup → create a token
2. In your MCP client: add a new server with the ythril URL and `Authorization: Bearer <token>`
3. The client discovers ythril's tools at registration time (`tools/list`) — enable the ones you want
4. Brain and file tools are now available in chat

ythril has no special integration requirements — it behaves like any other MCP server.

---

## Security

Security controls are cross-cutting and apply across all phases. These are requirements, not optional hardening.

| ID | Area | Control |
|----|------|---------|
| SEC-1 | Sync credentials | Outbound peer tokens stored in `secrets.json` (plaintext, `0600`), never in `config.json`. `config.json` stores only `tokenHash` for inbound validation. |
| SEC-2 | MongoDB injection | `query` tool filter validated against operator whitelist before reaching driver. `$where`, `$function`, `$accumulator` and all JS-executing operators rejected. `maxTimeMS` enforced (default 5 s; hard cap 30 s) to prevent runaway scans. |
| SEC-3 | Instance identity | `instanceId` is a random UUID generated once at first run, stored in `config.json`. Independent of instance label; label is display-only. |
| SEC-4 | Rate limiting | Auth/setup: 10 req/min per IP. `/api/notify`: 60 req/min per sender instanceId. General authenticated: 300 req/min per token (configurable). |
| SEC-5 | Invite keys at rest | Bcrypt-hashed in `config.json`, identical to PAT handling. Plaintext shown once in UI; never persisted. |
| SEC-6 | Destructive confirmation | All destructive endpoints accept `{ confirm: true }` in the request **body** only. Query-string confirmation is not accepted. |
| SEC-7 | Upload size cap | `maxUploadBodyBytes` (default 5 GiB) enforced per chunk request at HTTP layer. No per-file limit — large files are chunked via `Content-Range`. Returns 413 if single chunk exceeds limit. |
| SEC-8 | File permissions | `config.json` and `secrets.json` created and maintained at mode `0600`. ythril refuses to start if either file is world-readable. |
| SEC-9 | TLS warning | ythril warns loudly on startup if serving on a non-loopback address without TLS. Suppressed only via explicit `allowInsecurePlaintext: true` in config. |
| SEC-10 | Peer TLS validation | Outbound peer connections enforce strict certificate validation by default. Per-peer `skipTlsVerify: true` is available but displayed as a security warning in the UI. |
| SEC-11 | Gossip poisoning | A member record is only applied as authoritative when received directly from the instance it describes. Relayed records that contradict the last directly-received record are held for manual review. |
| SEC-12 | Space-scoped endpoints | Every endpoint that returns data (including `/api/conflicts`) filters results to the token's `spaces` allowlist. |
| SEC-13 | First-run race | A one-time setup code is printed to stdout at first start and required to complete `/setup`. Prevents an external actor from claiming the instance. |
| SEC-14 | Log redaction | `Authorization` header is redacted to `Bearer [redacted]` in all log output. No token plaintext is ever written to logs. |
| SEC-15 | Path traversal | All path inputs are URL-decoded and unicode-normalised (NFC) before sandbox resolution. Decode-then-resolve order is mandatory. |
| SEC-16 | peerId SSRF | `sync_now` `peerId` is validated as an exact match against the registered member list. Never used as a URL directly. |

---

## Decisions

| # | Area | Decision |
|---|------|----------|
| S-1 | Sync — conflict resolution | ✅ Rename-and-notify: `<file>_<iso-ts>_<instance>.<ext>`; user resolves in `/conflicts` UI |
| S-2 | Sync — scheduling | ✅ Cron expression per peer from v1; empty = manual only |
| S-3 | Sync — large files | ✅ Chunked upload with `Content-Range` + resume support from v1 |
| Q-1 | Storage — quota scope | ✅ Total combined required; per-area optional; whichever hits first is enforced |
| Q-2 | Storage — enforcement | ✅ Real-time per-write check; no cache |
| U-1 | Frontend tech stack | ✅ Angular; standalone components (no NgModule) |
| A-1 | Spaces — per-space quotas | ✅ `minGiB` floor + `flex` weight; effective min = `max(configured, currentUsage)` on reconfiguration |
| A-2 | Spaces — per-space token scoping | ✅ Optional `spaces` allowlist on token; omitted = all spaces; stored in token record |
| A-3 | Spaces — cross-space recall tool | ✅ `recall_global` searches all token-accessible spaces; `general` is the fallback write target |
| A-3a | Spaces — name of fallback space | ✅ `general` |
| N-1 | Networks — Merkle integrity | ✅ Opt-in per network (`"merkle": true`); default off |
| N-2 | Networks — invite key lifecycle | ✅ One active key per network; consumed after each round (pass or fail); new key required per candidate |
| N-3 | Networks — member roles / removal | ✅ No roles. Force-leave: any member may be ejected by network vote (same governance rules as invite). Force-delete: not possible. Removed member keeps their data. |
| N-4 | Networks — Open type in scope | ✅ Excluded. No join gate = bot flooding + memory manipulation at scale. Contradicts bilateral consent model. Not planned. |
| N-5 | Networks — Braintree topology verification | ✅ Bidirectional edge ownership: parent holds `children[]`, child holds `parentInstanceId`; both must agree; parent’s record is authoritative |
| N-6 | Networks — voting UX without push | ✅ Deadline configurable by inviter (default 48 h); syncs scheduled-only; notify channel required (see N-8) |
| N-7 | Networks — orphaned subtree when relay node leaves Braintree | ✅ Auto re-parent: departing node notifies via N-8; parents register grandchildren as direct children; crash/silent departure → suspended until next gossip detects inconsistency |
| N-8 | Networks — notify channel for direction-agnostic vote signalling | ✅ `POST /api/notify`; requires network-scoped token; body: `{ networkId, instanceId, event }`; no data payload |
| DE-1 | Sync — incremental (high-watermark) | ✅ Per-space monotonic `seq` counter; `sinceSeq` cursor on all sync endpoints; first sync passes 0 |
| DE-2 | Sync — deletion propagation | ✅ Tombstones in `{spaceId}_tombstones`; never deleted; propagated via sync; tombstone overrules live doc if seq ≥ live seq |
| DE-3 | Brain — vector index spec | ✅ MongoDB `$vectorSearch` index; `{spaceId}_memories_embedding`; dimensions + similarity from config; mismatch blocks recall until re-index |
| DE-4 | Brain — embedding model | ✅ OpenAI-compatible `/v1/embeddings` endpoint; default: Ollama `nomic-embed-text-v1.5` (768d, cosine, fully offline) |
| DE-5 | Sync — pagination | ✅ `limit` + opaque `cursor` on all brain sync list endpoints |
| DE-6 | Sync — file hash algorithm | ✅ SHA-256 |
| DE-7 | Sync — mtime reliability | ✅ `modified` is informational only; hash is the sole conflict signal |
| DE-8 | Brain — query scan protection | ✅ `maxTimeMS` default 5 s; hard cap 30 s; configurable downward by caller |
| DE-9 | Sync — brain conflict model | ✅ Higher seq wins; equal-seq concurrent edits fork with `forkOf` link; tombstone overrules live doc unless live seq is higher |
| DE-10 | Brain — `recall_global` performance | ✅ Parallel `$vectorSearch` across all space indexes; merge by score; documented for large deployments |
| DE-11 | Sync — createdAt + seq on entities/edges | ✅ All three document types carry `createdAt` and `seq` |
| DE-12 | Brain — edge schema | ✅ `{ _id, from, to, label, weight?, createdAt, seq, author }` |
| DE-13 | Spaces — space deletion governance | ✅ Governed vote (same flow as invite); upstream passthrough to root in Braintree; transfer affordance before vote; veto = retain own copy; solo instance falls back to direct confirm |

---

## Project Structure

```
ythril/
├── docker-compose.yml
├── Dockerfile                    # multi-stage: client build → server build → runtime
├── .dockerignore
├── .gitignore
├── LICENSE
├── package.json                  # npm workspaces root
├── tsconfig.base.json            # shared TS options (strict, target ES2022, moduleResolution NodeNext)
├── README.md
├── PLAN.md
├── config/
│   └── config.example.json       # committed template; config.json + secrets.json are gitignored
├── server/                       # Node.js TypeScript backend
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # entry point: HTTP server startup, file-permission checks, TLS warning
│       ├── app.ts                # Express setup: middleware registration, route mounting
│       ├── config/
│       │   ├── loader.ts         # read/write config.json and secrets.json; 0600 enforcement
│       │   └── types.ts          # Config, SecretsFile, Space, Network TypeScript types
│       ├── auth/
│       │   ├── middleware.ts     # Bearer token extraction, validation, space-allowlist enforcement
│       │   └── tokens.ts         # PAT create/list/revoke; bcrypt hash/verify
│       ├── setup/
│       │   └── routes.ts         # /setup endpoint (first-run only; 404 after completion)
│       ├── spaces/
│       │   └── spaces.ts         # space CRUD; MongoDB collection + $vectorSearch index init; quota hooks
│       ├── brain/
│       │   ├── embedding.ts      # OpenAI-compatible /v1/embeddings HTTP client (native fetch)
│       │   ├── memory.ts         # remember/recall; $vectorSearch + $graphLookup; seq stamping
│       │   ├── entities.ts       # entity upsert/list/delete
│       │   ├── edges.ts          # edge upsert/delete
│       │   └── tombstones.ts     # tombstone write, read, apply-on-receive (seq comparison)
│       ├── files/
│       │   ├── sandbox.ts        # URL-decode → NFC normalise → path.resolve → boundary check
│       │   ├── files.ts          # file CRUD; chunked upload assembly; SHA-256 hash
│       │   └── conflicts.ts      # file conflict records CRUD
│       ├── sync/
│       │   ├── scheduler.ts      # node-cron; per-network sync job management
│       │   ├── manifest.ts       # GET /api/sync/manifest; since-timestamp + SHA-256 diffing
│       │   ├── brain-sync.ts     # GET/POST /api/sync/{memories,entities,edges,tombstones}
│       │   └── network-sync.ts   # GET/POST /api/sync/networks/:id/{members,votes}
│       ├── networks/
│       │   ├── networks.ts       # network CRUD; scope enforcement
│       │   ├── voting.ts         # voting round engine; pass/fail evaluation per governance type
│       │   ├── gossip.ts         # member list merge; poisoning protection (relay vs direct)
│       │   └── notify.ts         # POST /api/notify handler; network-scoped token auth
│       ├── mcp/
│       │   ├── router.ts         # /mcp/:spaceId routing; space resolution; MCP session lifecycle
│       │   ├── brain-tools.ts    # remember, recall, recall_global, query
│       │   ├── file-tools.ts     # read_file, write_file, list_dir, delete_file, create_dir, move_file
│       │   └── sync-tools.ts     # list_peers, sync_now
│       ├── api/
│       │   ├── tokens.ts         # /api/tokens routes
│       │   ├── files.ts          # /api/files routes
│       │   ├── brain.ts          # /api/brain routes
│       │   ├── spaces.ts         # /api/spaces routes
│       │   ├── networks.ts       # /api/networks routes
│       │   ├── sync.ts           # /api/sync routes
│       │   └── conflicts.ts      # /api/conflicts routes
│       ├── db/
│       │   └── mongo.ts          # MongoDB connection singleton; typed collection factory
│       ├── quota/
│       │   └── quota.ts          # real-time du + dbStats; soft warning + hard reject (507)
│       ├── rate-limit/
│       │   └── middleware.ts     # express-rate-limit config: auth/setup, notify, global tiers
│       └── util/
│           ├── seq.ts            # per-space atomic seq counter (MongoDB findOneAndUpdate)
│           └── log.ts            # logger wrapper; Authorization header redaction
└── client/                       # Angular frontend
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.app.json
    ├── angular.json
    └── src/
        ├── index.html
        ├── main.ts
        ├── styles.css
        └── app/
            ├── app.config.ts     # provideRouter, provideHttpClient, provideAnimations
            ├── app.routes.ts     # route definitions
            ├── core/
            │   ├── auth.service.ts    # token storage; HTTP interceptor; logout
            │   └── api.service.ts     # typed HTTP client wrappers
            ├── pages/
            │   ├── setup/
            │   │   └── setup.component.ts
            │   ├── files/
            │   │   ├── file-manager.component.ts   # CDK drag-and-drop; chunked upload progress
            │   │   └── conflicts.component.ts
            │   ├── brain/
            │   │   ├── brain.component.ts           # memory list, search, tag/entity filter
            │   │   └── entity-graph.component.ts    # node/edge SVG visualisation
            │   └── settings/
            │       ├── settings.component.ts
            │       ├── tokens.component.ts
            │       ├── storage.component.ts
            │       ├── sync.component.ts
            │       ├── spaces.component.ts
            │       └── networks.component.ts
            └── shared/
                ├── confirm-dialog.component.ts
                └── token-display.component.ts  # one-time plaintext token display (clears on navigate)
```

---

## Libraries

> **Version guidance:** pins below are the known-stable major versions at the time of writing (March 2026). Confirm the latest patch at bootstrap time with `npm install <pkg>@latest` and lock the resolved semver in `package-lock.json`.

### Runtime requirement

**Node.js 22 LTS** (active LTS through October 2027). Node 22 ships native `fetch`, `--watch`, and the V8 version required for the TypeScript target (`ES2022`). Node 20 is acceptable (LTS until April 2026) but Node 22 is the target.

### Server

| Package | Version | Notes |
|---------|---------|-------|
| `express` | `^5` | 5.2.1 — stable since Sept 2024. |
| `@modelcontextprotocol/sdk` | `latest` | Pin after install; protocol is still evolving. |
| `mongodb` | `^7` | 7.1.0 — driver v7 required for `$vectorSearch` (aligns with `mongo:7.0` server in docker-compose). |
| `bcrypt` | `^6` | 6.0.0 — current stable. Still uses DefinitelyTyped (`@types/bcrypt`). |
| `uuid` | `^13` | 13.0.0 — ESM-only from v12 onward; compatible with `moduleResolution: NodeNext`. |
| `node-cron` | `^4` | 4.2.1 — current stable. |
| `express-rate-limit` | `^8` | 8.3.1 — current stable; bundles its own TypeScript types. |
| `zod` | `^4` | 4.3.6 — v4 shipped; use it. |
| `multer` | `^2` | 2.1.1 — current stable. Still uses DefinitelyTyped (`@types/multer`). |

**No ORM.** MongoDB native driver only — schema is owned by ythril; no abstraction layer needed.  
**No embedding client SDK.** Embedding calls use native `fetch` (Node 22) against the OpenAI-compatible endpoint — zero additional dependency.  
**No message broker.** Parallel `Promise.all` across `$vectorSearch` is sufficient for `recall_global` at this scale.

#### Server dev dependencies

| Package | Version | Notes |
|---------|---------|-------|
| `typescript` | `^5` | v5.x is current; strict mode on. |
| `tsx` | `^4` | Run TS directly (`tsx watch src/index.ts`) in development. |
| `@types/express` | `^5` | Match express major. |
| `@types/bcrypt` | `^5` | DefinitelyTyped types for bcrypt. |
| `@types/multer` | `^1` | DefinitelyTyped types for multer. |
| `@types/node` | `^22` | Match Node LTS major. |
| `eslint` | `^9` | Flat config (v9 default). |
| `@typescript-eslint/parser` | `^8` | ESLint v9 compatible. |
| `@typescript-eslint/eslint-plugin` | `^8` | Matches parser. |

### Client

Angular follows a 6-month release cycle. As of March 2026 the current major is **v21** (released November 2025); v19 and v20 remain on LTS.

| Package | Version | Notes |
|---------|---------|-------|
| `@angular/core` et al. | `^21` | Standalone components (no NgModule) only. |
| `@angular/cdk` | `^21` | Drag-and-drop for file upload zone; must match `@angular/core` major. |

**No UI component library.** Minimal custom styles only — no Material, PrimeNG, or Bootstrap. Keeps the bundle lean and eliminates upstream breaking-change risk.  
**Entity graph visualisation:** plain SVG with Angular bindings. If complexity warrants it, `@swimlane/ngx-graph` can be added — not a pre-committed dependency.

### .gitignore

```gitignore
# Dependencies
node_modules/

# Build output
dist/
.angular/

# Runtime config — never committed; use config/config.example.json as template
config/config.json
config/secrets.json

# Env files
.env
.env.*
!.env.example

# OS / editor noise
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp
*.swo

# Logs
*.log
npm-debug.log*

# TypeScript build info
*.tsbuildinfo
```

`config/config.example.json` is committed with every supported field populated with placeholder values and inline comments. Users copy it to `config/config.json` to get started.

---

## Implementation Phases

### Phase 1 — Core (runnable, MCP-compliant)
- [x] Compose stack scaffold (`ythril` + `ythril-mongo`)
- [x] First-run setup: generate setup code to stdout; setup form collects code + instance label + settings password; `config.json` + `secrets.json` written at `0600`; startup check rejects world-readable files; redirect to `/settings` after setup
- [x] Random `instanceId` UUID generated at first run, stored in config
- [x] Embedding config: OpenAI-compatible `/v1/embeddings` endpoint; default Ollama `nomic-embed-text-v1.5` 768d cosine
- [x] MongoDB `$vectorSearch` index creation on space init; mismatch detection + re-index background job
- [x] Per-space monotonic `seq` counter; increment on every write and delete
- [x] Edge + entity schema with `createdAt`, `seq`, `author`
- [x] Tombstone collection `{spaceId}_tombstones`
- [x] PAT token CRUD API (`/api/tokens`)
- [x] All MCP tools: `remember`, `recall` (parallel for recall_global), `query` (operator whitelist + maxTimeMS), `read_file`, `write_file`, `list_dir`, `delete_file`, `create_dir`, `move_file`
- [x] `/tools/list` and `/tools/call` MCP endpoints (HTTP+SSE)
- [x] Sandbox path enforcement: URL-decode + unicode-normalise before resolution
- [x] `Authorization` header redaction in all log output
- [x] Rate limiting middleware: auth/setup 10/min per IP; global 300/min per token
- [x] TLS non-loopback warning on startup
- [x] Health endpoint: `GET /health`

### Phase 2 — Settings UI + File Manager
- [ ] File manager at `/files`: browse, upload, download, delete, rename
- [x] `maxUploadBodyBytes` enforced at HTTP layer (HTTP 413 before processing)
- [x] Destructive endpoints accept confirm in body only (not query string)
- [x] Space allowlist enforced on `/api/conflicts` and all data-returning endpoints
- [x] Settings UI at `/settings`: password-authenticated (bcrypt verify + session cookie); token CRUD (create, list, revoke); storage display; space management

### Phase 3 — Brain UI + Storage Quotas
- [x] Brain UI at `/brain`: memory list, entity viewer, bulk delete
- [x] Storage quota config + enforcement (soft + hard)
- [x] Settings UI: storage section with used/limit display

### Phase 4 — Sync
- [x] Network CRUD API (`/api/networks`): create, list, leave
- [x] Invite key generation: bcrypt at rest, shown once; join request flow
- [x] `secrets.json` for outbound peer credentials (`0600`; never in `config.json`)
- [x] Peer TLS: strict cert validation by default; per-peer `skipTlsVerify` flag with UI warning
- [x] `sync_now` peerId validated against member list (no direct URL use)
- [x] Rate limit on `POST /api/notify`: 60/min per sender instanceId
- [x] Gossip poisoning protection: relay-vs-direct-record conflict held for review
- [x] Incremental sync: `sinceSeq` cursor on all brain sync endpoints; `since` timestamp on file manifest
- [x] Paginated brain sync endpoints (`limit` + opaque `cursor`)
- [x] Tombstone sync: `GET /api/sync/tombstones?sinceSeq=<n>`; tombstone application on receive
- [x] File manifest uses SHA-256; `modified` advisory only
- [x] Brain conflict resolution: seq-wins; co-author fork on equal-seq; tombstone vs live-doc precedence
- [x] Brain sync (memories, entities, edges)
- [ ] Gossip: member list exchange piggybacked on sync cycles
- [ ] Settings UI: networks section (sync schedule, trigger, history log)
- [ ] `list_peers` + `sync_now` MCP tools (operate on networks)

### Phase 5 — Spaces
- [x] Space CRUD API (`/api/spaces`)
- [x] Space deletion vote flow: upstream passthrough to Braintree root; notify channel event `space_deletion_pending`; transfer affordance; veto = retain own copy
- [x] Auto-create file directories + MongoDB collections + `$vectorSearch` indexes on space creation
- [x] Per-space MCP endpoint routing (`/mcp/:spaceId`)
- [x] Enforce space isolation on all file and brain operations
- [x] Settings UI: spaces section

### Phase 6 — Network Governance
- [x] Voting round engine: open round on join request, collect votes via gossip, evaluate pass/fail conditions per network type
- [ ] Vote propagation in gossip protocol
- [x] Invite key lifecycle: issue → open round → consumed on result
- [x] Network types: Closed, Democratic, Club, Braintree
- [ ] Braintree: ancestor path resolution + per-ancestor vote collection
- [ ] Leave flow: unilateral departure + departure gossip broadcast
- [ ] Removal flow: removal round via vote; notify ejected instance on next sync attempt; ejected member keeps data
- [ ] Off-grid / fork: departing or ejected member can create a new network from their data
- [x] Per-membership sync direction (`both` / `push`); enforce at sync time
- [x] `POST /api/notify` endpoint; network-scoped token auth; `vote_pending` + `member_departed` events
- [ ] Settings UI: pending votes banner, create / join / leave flows
- [ ] Merkle root per space (opt-in via network `merkle` flag)

---

## TODO

Items are ordered by dependency — each group unlocks the next.

### 1. Gossip completion (unlocks vote propagation + UI history)
- [ ] Engine calls `POST /api/sync/networks/:networkId/members` on each peer during sync cycles to push own member record (gossip member list exchange piggybacked on sync)

### 2. Vote propagation (unlocks Braintree ancestor votes + votes UI)
- [ ] Engine calls `GET /api/sync/networks/:networkId/votes` on each peer during sync; relays new votes via `POST /api/sync/networks/:networkId/votes/:roundId`

### 3. Leave + removal flows (unlocks off-grid/fork)
- [ ] Leave flow: broadcast `member_departed` notify event to all peers before removing the network locally (DELETE `/api/networks/:id` currently does no broadcast)
- [ ] Removal flow: after remove vote concludes and passes, send `member_removed` notify event to ejected instance; return `401 {"error":"ejected"}` on any subsequent sync attempt from that instanceId

### 4. Braintree governance (depends on vote propagation)
- [ ] Resolve ancestor path up root via `parentInstanceId` chain on join requests; collect per-ancestor votes before opening the local round

### 5. Off-grid / fork (depends on leave + removal)
- [ ] `POST /api/networks/:id/fork` — creates a new standalone or closed network seeded from current space data, available to a departing or ejected member

### 6. Merkle root (independent)
- [ ] Compute SHA-256 tree over space seq watermarks + file manifest hashes; expose via `GET /api/sync/merkle?spaceId=&networkId=`; engine compares roots during sync and flags divergence when network `merkle` flag is set

### 7. `sync_now` MCP tool (independent)
- [ ] Add `sync_now` tool to `mcp/router.ts`: accepts `peerId` (instanceId), validates against member list, triggers one sync cycle, returns outcome

### 8. File manager UI (independent)
- [ ] Server-rendered HTML UI at `/files` over the existing `/api/files` HTTP API: directory listing, upload form, download link, delete, rename

### 9. Settings UI: networks (depends on gossip completion + sync_now)
- [ ] Networks section on `/settings`: list networks, per-network sync schedule config, manual "Sync now" trigger, last-sync timestamp, consecutive failure count

### 10. Settings UI: votes (depends on vote propagation + leave/removal flows)
- [ ] Open votes banner on main `/settings` page (count of pending rounds across all networks)
- [ ] Per-network create / join / leave flows in the networks section

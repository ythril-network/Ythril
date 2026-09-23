# Brain Stats, Maintenance & Bulk Operations

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Brain Stats, Maintenance & Bulk Operations

### Space Stats

```http
GET /api/brain/spaces/:spaceId/stats
```

**Response** `200`:

```json
{
  "spaceId": "general",
  "facts": 1042,
  "entities": 156,
  "edges": 89,
  "chrono": 23,
  "files": 31,
  "embedQueue": { "pending": 0, "processing": 0, "failed": 0 }
}
```

**`embedQueue` — how much of this space is not searchable yet.** Writes do not wait for the embedding
model; a background worker embeds each record moments later. Until it does, the record exists but is
**absent from recall** rather than ranked lower, because both retrieval channels need the vector.

| field | meaning |
|---|---|
| `pending` | queued, not started. Normally 0, briefly non-zero after a burst of writes or a sync pull |
| `processing` | in flight right now |
| `failed` | gave up after retrying with backoff. **A non-zero value that does not clear is the signal that something is wrong** — usually an unreachable or misconfigured embedding endpoint |

Use it to answer "is this space ready to search". A steady `pending` that never drains, or any lasting
`failed`, means recall is quietly returning less than the space contains. Rewriting a record requeues it,
which is the way back from `failed` without an operator touching the queue.

For a proxy space the numbers are its **members'**, summed — matching the record counts above.

---

### Space Activity

Is this space earning its keep? `stats` says how much is *in* a space; this says whether anyone is getting
anything *out* of it.

```http
GET /api/brain/spaces/:spaceId/activity?hours=24
```

`hours` defaults to 24 and is clamped to 1…2160 (90 days, the bucket retention). A proxy space reports its
members' rows.

**Response** `200`:

```json
{
  "spaceId": "reporting",
  "hours": 24,
  "spaces": [
    {
      "space": "reporting",
      "calls": 412,
      "recall": 380,
      "answered": 41,
      "writes": 12,
      "meanMs": 63,
      "maxMs": 1840,
      "over1s": 3,
      "meanTopScore": 0.31,
      "lastUsedAt": "2026-08-01T14:00:00.000Z"
    }
  ]
}
```

**Read `recall` and `answered` together — that is the point of the endpoint.** 380 queries and 41 answers is
not a popular space; it is a space people keep failing to get an answer out of, and a call count alone cannot
tell the two apart. `meanTopScore` is the mean best-hit score across **answered** recalls only, so it stays
inside 0…1 and is `null` when nothing was answered (rather than `0`, which would read as "answers are bad"
instead of "there were none").

`meanMs` is over all classes of call, `over1s` counts those slower than a second, and `maxMs` is a true
maximum. **There is no percentile**, deliberately: a mean stored per hour cannot be recombined into a p95, so
a p95 here would either be a fabrication or require keeping every sample.

| field | counts |
|---|---|
| `recall` | `recall`, `query` and `similar` — demand on the brain |
| `writes` | anything that changed a record or added a file, including curation (resolving a conflict, merging a duplicate) |
| `calls` | all four classes: recall, reads, writes and file traffic |

Operator work on the instance — creating a space, casting a network vote, rotating a token — is **not**
counted, even though those requests carry a space id. Counting them would credit a brand-new empty space with
activity it never had.

Buckets are hourly and in UTC, kept for 90 days. A window with no calls returns an empty `spaces` array.

---

### Space Activity — every space at once (admin)

```http
GET /api/admin/space-activity?hours=168
Authorization: Bearer ythril_…   # admin token
```

Same row shape as the per-space endpoint, for **all** spaces in one response, busiest first.

```json
{
  "hours": 168,
  "retentionDays": 90,
  "spaces": [
    { "space": "reporting", "calls": 412, "recall": 380, "answered": 41, "meanTopScore": 0.31, "…": "…" },
    { "space": "handbook",  "calls": 95,  "recall": 88,  "answered": 84, "meanTopScore": 0.72, "…": "…" }
  ]
}
```

**Two endpoints on purpose.** This one is admin-only because it is inherently cross-space — a space-scoped
token has no business learning how heavily every other space is used, and the per-space route above exists
for exactly that caller. And it is one request rather than N: calling the per-space endpoint once per row is
a front-end N+1, which on a sixty-five-space instance means sixty-five requests to draw one table.

**A space with no traffic in the window is absent, not zero-filled.** The caller already knows which spaces
exist; what it cannot know is which ones the window covers, so the absence carries the information. It also
keeps a never-asked space from being ranked as though it answered badly — those are different problems with
different fixes (find out why nothing queries it, versus fill the gap it cannot answer).

`hours` defaults to 168 (7 days) and is clamped to `retentionDays × 24`. A week rather than a day is the
useful default here: usefulness is a question about a habit, and a space queried every Monday looks dead in a
24-hour window.

---

### Check Reindex Status

```http
GET /api/brain/spaces/:spaceId/reindex-status
```

**Response** `200`:

```json
{ "spaceId": "general", "needsReindex": false }
```

Returns `true` when the embedding model has changed and facts need re-embedding.

---

### Reindex Space

```http
POST /api/brain/spaces/:spaceId/reindex
```

Re-computes **all** embeddings with the current model. **Runs asynchronously** — the call returns immediately and the job proceeds in the background (it may take minutes for large spaces). Poll `GET /api/brain/spaces/:spaceId/reindex-status` for progress.

> **Not the same as the backfill, and this is the pair people pick wrong.** [`POST /api/spaces/:id/reembed`](06-spaces-api.md#re-embed-backfill) touches only records that have **no** vector, is awaited, and returns counts — it is the way back from `suppressEmbeddings`. This one rewrites every vector in the space, which is what you want after changing embedder or model and a great deal of work if you only meant to fill a gap. Tools: `space_reindex` and `space_reembed`.

**Response** `200` — the job was *accepted*; `reindexed`/`errors` are always `0` here (the real counts land on the status endpoint), and `status` is `"started"`:

```json
{ "spaceId": "general", "reindexed": 0, "errors": 0, "status": "started" }
```

Returns `409 { "error": "Reindex already in progress" }` if one is already running — **instance-wide, not
per space.** One reindex runs at a time across the whole instance, and a second request is *refused rather
than queued*. An operator who fired thirteen at once got one `200` and twelve `409`s; a loop that counts only
non-200s as failures would report thirteen dispatched having dispatched one. **Retry on 409** is the correct
client, and it self-paces.

Returns `400` with the member spaces named if `:spaceId` is a **proxy**:

```json
{ "error": "'team' is a proxy space and has no index of its own. Reindex its members instead: qa, research.",
  "proxyFor": ["qa", "research"] }
```

A proxy has no index of its own — its members do. This used to answer `200` and re-embed those members, which
the caller was usually reindexing individually as well, so everything under the proxy was embedded twice.
`GET /api/spaces` carries `proxyFor` on any space that has one, so a client can skip proxies without
discovering this by trying.

> **Reindexing does NOT repair "search returns nothing".** It re-computes the embeddings *stored on*
> your records. Recall queries those vectors through a separate `$vectorSearch` index, and that index
> can be missing while every record still holds a perfectly good embedding — after restoring a backup,
> or if the database search process was not ready when the instance started. Reindexing every record
> in the space will not create it. Use the rebuild endpoint below.

### Reorder spaces

```http
POST /api/spaces/reorder
```

```json
{ "ids": ["general", "research", "photos"] }
```

Admin + MFA. Sets the display order of spaces in the UI's sidebar and space pickers. `ids` must name **every** space you
want ordered — a space whose id is absent keeps its existing position relative to the ones you did name.

| Field | Required | Description |
|-------|----------|-------------|
| `ids` | ✅ | Space ids in the desired order, 1–40 characters each, at least one entry |

**Response** `200`: the reordered spaces as `{ id, label, builtIn, folders, … }`. `400` if any id names no space — the
whole call is rejected rather than partially applied, so a typo cannot silently reorder a subset.

---

### Which tokens can reach a space

```http
GET /api/brain/spaces/:spaceId/token-access
```

**Admin only** (on top of the space's own read right), because it enumerates the instance's tokens. Powers the Overview
tab's token-access matrix.

**Response** `200`:

```json
{
  "tokens": [
    { "name": "ci-writer", "level": "full", "allSpaces": false, "peer": false, "expiresAt": null }
  ]
}
```

| Field | Meaning |
|---|---|
| `level` | `admin`, `readOnly`, or `full` |
| `allSpaces` | `true` when the token has no space allow-list, so it reaches every space |
| `peer` | `true` for a token belonging to a peer instance rather than a person or client |

It returns the **minimum** the matrix needs and **never** a hash, a prefix, or any other secret material. A token reaches
this space when it has no allow-list or lists this space; `schemaLibrary` tokens have no space access at all and never
appear.

---

### Media embedding queue for a space

```http
GET /api/brain/spaces/:spaceId/embedding-queue/media
```

The **media** half of the queue — file chunks produced by the conversion pipeline. For brain records (facts, entities,
edges, chrono) see [Vectorless records](#vectorless-records--the-embed-queue-for-brain-records), which is a separate
collection with a separate worker.

> **The `/media` segment is new in 3.1, and this path was `/embedding-queue` with nothing after it.** The
> namespace always had two halves — `/records` for brain records, and the bare path for media — but only one
> of them said which it was, so "no qualifier means files" was true and knowable only from this paragraph.
> Both halves are named now.
>
> **This is a breaking change with no alias.** Update the path; the response is unchanged.

**Response** `200`:

```json
{
  "pending": 3, "processing": 1, "complete": 412, "failed": 2,
  "failedSample": [ … ], "failedByReason": [ { "reason": "ffmpeg exited 1", "count": 2 } ]
}
```

Summed across member spaces for a proxy space. `failedByReason` is grouped across the whole fleet before truncation, so a
proxy's grouping describes its members rather than whichever one was read first.

---

### Retry every failed media job in a space

```http
POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed
```

Re-queues **all** failed media jobs in the space (and across members for a proxy). Requires `files: write`.

**Response** `202`: `{ "retried": 7 }`.

Retry-all is offered here and deliberately **not** for brain records: a media failure is usually about the worker, where a
brain record's failure is usually about that record. See the per-record retry above.

---

### Vectorless records — the embed queue for brain records

A brain record is written and its vector is computed **after** the response. If the embedder is unreachable or the text
chokes it, the record is **stored** and a job records the failure — it is not dropped. But a record without a vector is
**invisible to `recall` and to `query`'s semantic path**: the vector search cannot return it, and the lexical fallback
needs an embedding to score. These two endpoints are how you find those records and get them embedded.

This is the **record** half of the queue. `GET /embedding-queue` (without `/records`) is the **media** half — file chunks
from the conversion pipeline. They are separate collections with separate workers.

```http
GET /api/brain/spaces/:spaceId/embedding-queue/records
```

| Query param | Description |
|-------------|-------------|
| `status` | `pending`, `processing`, or `failed`. Omit for all three. An unknown value is a `400`, never a silently ignored filter |
| `limit` | Default `50`, max `200`. `0`, a negative, or a non-integer is a `400` |
| `skip` | Rows to discard before the page (default `0`). A negative or non-integer is a `400` |

**Response** `200`:

```json
{
  "counts": { "pending": 2, "processing": 0, "failed": 1 },
  "jobs": [
    {
      "recordType": "fact",
      "recordId": "3f2c…",
      "spaceId": "general",
      "status": "failed",
      "attempts": 5,
      "maxAttempts": 5,
      "lastError": "embedding model unreachable",
      "createdAt": "2026-08-13T09:12:04.311Z",
      "updatedAt": "2026-08-13T09:18:47.902Z"
    }
  ]
}
```

`counts` aggregates **every** job in the space; `jobs` is one page of them. Page with `skip` — without it a space reporting
`failed: 500` would have no way to reach failure #201, and the point of this endpoint is that its failures are actionable.
`limit` and `skip` are echoed so a draining loop can tell what was applied, and a `skip` past the end returns an empty
`jobs` array with the counts intact, which is how the loop terminates.

Newest-first by `updatedAt`, with the record id breaking ties so the order is **total** and pages cannot overlap. `attempts === maxAttempts` with `status: "failed"` means the queue has **given up** — it
will not retry on its own, and the record stays unfindable until you retry it or rewrite it. Each row carries its own
`spaceId`, which for a **proxy space** is the member space the record actually lives in — that is the space to retry it
in. `counts` is returned whether or not you filtered, so a caller can filter to `failed` and still see the whole picture.

Requires `knowledge: read`. Deliberately readable by a token that cannot write: an operator who cannot fix the queue
still needs to be able to see it.

---

### Retry one record's embedding

```http
POST /api/brain/spaces/:spaceId/embedding-queue/records/retry
```

```json
{ "recordType": "fact", "recordId": "3f2c…" }
```

| Field | Description |
|-------|-------------|
| `recordType` | `fact`, `entity`, `edge`, `chrono`, or `file`. Anything else is a `400` |
| `recordId` | The record's `_id`, as the listing reports it. Required |
| `targetSpace` | Required when `:spaceId` is a **proxy** space: the member space holding the record |

Resets the job to `pending`, clears `attempts` and `lastError`, and wakes the worker. The record's stored text is
untouched — this re-embeds what is already there rather than re-writing it.

**Response** `202`:

```json
{ "result": "ok", "recordType": "fact", "recordId": "3f2c…", "spaceId": "general" }
```

| `result` | Status | Meaning |
|---|---|---|
| `ok` | `202` | Re-queued. The worker will pick it up; it has not embedded yet |
| `processing` | `200` | A worker already holds this job. **Left alone** rather than reset, so the run in progress is not interrupted. Not an error |
| `not_found` | `404` | No job for that record — either it embedded successfully, or the record is gone |

Per record rather than "retry all failed": a brain record's failure is usually about *that record* (an oversized fact, a
property the embedder choked on), where a media failure is usually about the worker. Retrying a thousand records that
will each fail again hides the problem. If a whole space needs re-embedding — after changing the embedding model, for
instance — use [Reindex Space](#reindex-space) instead.

Requires `knowledge: write`. Audited as `brain.retry_embedding`, with the failure it was retried from in the snapshot: a
successful retry clears `lastError`, so the audit entry is the only place the original reason survives.

Both endpoints are also MCP tools — `list_embed_jobs` and `retry_embed_record`. See [MCP](16-mcp.md).

---

### Reset a space's recorded usage

```http
POST /api/spaces/:spaceId/activity/reset
```

Deletes the hourly usage buckets behind the Overview **usage** panel for this space. Admin + MFA, scoped to the
space — clearing a usage record changes no fact, entity, edge or file, so it is an administrative act on the
space's own bookkeeping rather than a knowledge write, and it sits with the other destructive space operations.

**Response** `200`:

```json
{ "ok": true, "spaceId": "general", "cleared": 412 }
```

`cleared` is how many hourly buckets were removed. It is in the response because afterwards the panel reads zero
either way, and nothing on screen distinguishes a reset from a space that was genuinely idle. Audited as
`space.activity.reset` for the same reason — so that answer survives the request.

In-memory counters are flushed first. Without that, up to a minute of already-counted traffic would land in
Mongo moments later and the panel would appear to un-reset itself.

**Irreversible.** The buckets are deleted, not hidden. Note that usage is *already* transient — buckets carry a
90-day TTL — so this brings forward a deletion the store would have done anyway rather than destroying a
permanent record.

Returns `404` if no space has that id.

---

### Rebuild search indexes

```http
POST /api/spaces/:spaceId/rebuild-indexes
```

Recreates the space's `$vectorSearch` indexes. Needs the `admin` rung on the space's **`knowledge`** area,
plus MFA, and is recorded in the audit log as `space.indexes.rebuild`. It rewrites what recall searches rather
than any type definition, which is why the area is `knowledge` and not `schema` — the same move applied to
`POST /reindex` and `POST /:id/reembed` in 4.4. Also available in the UI at **Settings → Spaces → Danger Zone →
Rebuild search indexes**.

**Runs asynchronously** — the call returns as soon as the build is submitted. **Recall returns empty
for that space until the build completes**, which is why it sits in the danger zone; no records are
modified.

```json
{ "ok": true, "spaceId": "general", "status": "rebuilding" }
```

Returns `404` when the space does not exist.

You should rarely need this: indexes are built when a space is created, retried on startup if the
database search process is slow to come up, and rebuilt automatically after a restore. It exists
because an index going missing is otherwise **silent** — an empty result set is indistinguishable from
"no matches", and `/ready` reports `vectorSearch: ok` regardless, since it probes the capability
rather than each space's indexes.

---

### Bulk Write

```http
POST /api/brain/spaces/:spaceId/bulk
Content-Type: application/json
```

Batch-upsert facts, entities, edges, and/or chrono entries in a single HTTP call. All four arrays are
optional. Processing order: **facts → entities → chrono → edges last**, so an edge can name a record of any
kind that the same call created.

**An id you send ADDRESSES an existing record; it never becomes a new record's identity.** Identities are
minted here — a supplied id would make you a co-author of our primary key, and across a sync two instances
deriving ids from one key would collide by design. So an id you invent for a new record names nothing, and
since references on this door are shape-checked and not existence-checked, an edge naming it is accepted and
stored dangling.

**To connect records this call creates, use a `$ref` correlation key** — `{"$ref": "post-1"}` on an item and
`"$ref:post-1"` where it is referenced. See
[A batch that connects what it creates](04-brain-api.md#a-batch-that-connects-what-it-creates) for the full
rules, including what a key means on a space that uses link records.

**An item also carries its own `link*` fields and `edges`**, the same ones its single-record endpoint takes
and through the same code. Those name records that already exist; a `$ref` in an item's `edges` is refused
and points you at the top-level array, which runs late enough to resolve one. A connection that cannot be
honoured is reported against the item's index and the record is not written. See
[An item carries its own relationships](04-brain-api.md#an-item-carries-its-own-relationships).

Each array is capped at 500 entries. Per-item validation failures are recorded in `errors` without aborting the remaining items.

**Request body:**

```json
{
  "facts":  [ { "fact": "Oceans cover 71% of the Earth's surface.", "tags": ["science"] } ],
  "entities":  [ { "name": "Earth", "type": "planet", "tags": ["science"] } ],
  "edges":     [ { "from": "<entity-id-A>", "to": "<entity-id-B>", "label": "orbits" } ],
  "chrono":    [ { "title": "Launch day", "type": "milestone", "startsAt": "2026-01-01T00:00:00Z" } ]
}
```

Each item accepts the same fields as its corresponding individual endpoint (`POST /facts`, `POST /entities`, `POST /edges`, `POST /chrono`), with one exception: **an entity's `type` is required in bulk** (an item missing it is skipped with `"missing required field: type"`), whereas the single `POST /entities` defaults `type` to empty.

**The body takes those four keys and no others, and a retired name is refused by name.** `{"memories": […]}` — the 4.x spelling — answers `400` naming `facts` as the replacement, and any other unrecognised top-level key answers `400` listing the four that are accepted. The same applies to a retired field **on an item**: `entityIds`, `memoryIds` and `chronoIds` are each refused with their `linkEntities` / `linkFacts` / `linkChronos` replacement. Until 5.1 an unknown key was carried in and never read, so a batch built against 4.x answered `207` with nothing inserted and an empty `errors` array — indistinguishable from a body that legitimately wrote nothing.

**Response** `207`:

```json
{
  "inserted":    { "facts": 1, "entities": 1, "edges": 0, "chrono": 1 },
  "updated":     { "facts": 0, "entities": 0, "edges": 1, "chrono": 0 },
  "connections": { "links": 2, "edges": 1 },
  "errors":      [
    { "type": "edge", "index": 0, "reason": "missing required field: from" }
  ]
}
```

- `inserted` — count of new documents written per type.
- `updated` — count of existing documents merged per type (entities are upserted by `id` when supplied; edges are upserted by their natural key `(from, to, label)`).
- `connections` — what the ITEMS' own `link*` and `edges` fields attached. **A different question from `inserted.edges`**, which counts the top-level `edges` array: that one is a collection you wrote, these are relationships hung off records you wrote. Folded together the number could not be reconciled against the payload you sent. `links` is the rows that were added; `edges` is the upserts, and this door does not tell a new one from an updated one for an item's own edges.
- `errors` — per-item failures (`type`, zero-based `index`, human-readable `reason`). Valid items are still written even when errors are present.

Entity items in the `entities` array accept an optional `id` field (UUID v4). If `id` is supplied, the entity with that ID is updated (or created with that ID). If `id` is omitted, a new entity is always inserted. See [Upsert an Entity](04b-graph-api.md#upsert-an-entity) for full identity semantics.

**Schema validation:** When the target space has `validationMode` set to `strict` or `warn`, each item is validated against the space schema before writing. In strict mode, violating items are skipped and recorded in `errors` (e.g. `"schema_violation: not in entityTypes allowlist: Person, Service"`). In warn mode, violations are recorded as warnings but the item is written. See [Schema Validation](06a-schema-api.md#schema-validation) for the full schema specification.

**Proxy spaces:** add `?targetSpace=<member>` to route all writes to a specific member space.

---

### Structured query (read-only)

```http
POST /api/filter
```

Run a constrained Mongo-style read against one logical collection. This is how you read a collection —
there is no per-collection `GET` and no second POST beside it.

**IT ANSWERS THE TOOL ENVELOPE, and that is the 5.0 break to port first.** `POST /api/<tool-name>` is one
shape for every tool, so a caller writes the response handling once:

| | |
|---|---|
| `200` | `{ok: true, text, data}` — `data` holds `results`, `count`, `total`, `limit`, `skip`, `truncated` and the budget figures |
| `4xx`/`5xx` | `{ok: false, error, data}` — `error` is the same sentence the MCP door puts in its `content`, word for word |

The route that used to live at `/api/brain/filter` answered `{results, total, …}` at the top level until
5.0. It was not a thin
route over the tool: it was a second implementation of it, with its own body validation, its own paging
parse and its own proxy fan-out — and three defects were found in the differences between the two while
it was being removed. What replaced it is the generic tool door, which has no per-tool code at all.

```json
{ "ok": true, "data": { "results": [ ... ], "count": 20, "total": 4831, "limit": 20, "skip": 0 } }
```

```json
{
  "collection": "entities",
  "filter": { "type": "service", "tags": "backend" },
  "projection": { "name": 1, "type": 1, "tags": 1 },
  "limit": 20,
  "maxTimeMS": 5000
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `collection` | ✅ | One of: `facts`, `entities`, `edges`, `chrono`, `files`, `links` |
| `filter` | — | Query filter object (defaults to `{}`) |
| `projection` | — | Projection object (`1` include / `0` exclude) |
| `limit` | — | Max rows, default `200` and NOT capped. It was silently clamped to 100 until 5.0, so a caller asking for 200 got 100 with `truncated` making it read as a correct short page — and the per-collection list routes this call replaces serve 200 or 500. What bounds an answer instead: the byte budget (`maxChars`/`maxBytes`) trims it and returns `nextSkip`, `maxTimeMS` bounds the query's duration, and on a PROXY space a `skip + limit` past the merge ceiling is an explicit `400` naming the limit |
| `skip` | — | Rows to discard before the page (default `0`) — see below |
| `sort` | — | Field to order by. Per-collection allowlist; an unlisted field is a `400` naming the allowed ones. Omit for newest-first  **`links` was missing from that allowlist until 5.0 and sorting it CRASHED** — a `500` with `retryable: true` on this door, which told a caller to retry a request that could never succeed. It sorts by `createdAt`, `updatedAt`, `from` and `to`; a link has no name, title or type of its own.|
| `dir` | — | `asc` or `desc` (default `desc`). Only meaningful with `sort` |
| `maxTimeMS` | — | Query timeout in milliseconds (default `5000`) |
| `entityName` | — | *(facts, chrono)* Only records attached to an entity whose name CONTAINS this, case-insensitively. A JOIN rather than a predicate: the server resolves the name to ids per member space first, then reads the link records. A name matching nothing returns nothing, never everything. On any other collection it is a `400` |
| `fromName` / `toName` | — | *(edges)* Only edges whose FROM / TO end is an entity whose name contains this. Direction is data: an edge from Alice to Bob matches `fromName` and not `toName`. On any other collection it is a `400` |
| `tag` | — | Only records carrying a tag that CONTAINS this, case-insensitively — `rel` finds `release`. For an EXACT tag use `filter: { tags: "release" }`. Refused on `links` |
| `type` | — | Only records of this knowledge type, exactly. The same thing as `filter: { type: ... }`, offered because the list routes offer it. Refused on `links` |
| `description` | — | Only records whose `description` CONTAINS this. Narrows that one field — `search` below also spans the record's name or title, which is why both exist. Refused on `links` |
| `properties` | — | Only records where some property VALUE contains this. Keys are not matched. It SCANS, so prefer a predicate on the property you mean when you know its name. Refused on `links` |
| `search` | — | Freetext substring over the collection's own text fields: `name`/`description` for entities, `fact`/`description` for facts, `label`/`description` for edges, `title`/`description` for chrono, `path`/`description` for files. The value is escaped, so it is a substring and never a regex. Refused on `links`, which has no text of its own |
| `path` | — | *(files)* The one file with this stored path. It is an ARGUMENT rather than `filter: { path }` because it is NORMALISED: backslashes read as separators, a leading slash ignored, so a Windows-style spelling and a leading-slash spelling both find `notes/a.md`. Exact after that — not a prefix, not a substring; for those use `search`, which also spans the description. Sending both spellings at once is a `400` rather than one of them silently winning. On any other collection it is a `400` |
| `deriveStatus` | — | *(chrono)* Present each entry's DERIVED status instead of the stored one: `overdue` where its due moment has passed, unless `whenDuePasses` on that type says a passed date means nothing. Default `false`, so this call answers with what the collection HOLDS — which is what you want when repairing data. The chrono LIST route derives unconditionally, so until 5.0 the meaning of `status` depended on which door you used. On any other collection it is a `400` |
| `includeDiagnostics` | — | Add back the two fields a listed record carries for the SYSTEM rather than for you: `matchedText` (the pre-embedding source string — for a file chunk, the passage a SECOND time) and `embeddingModel` (identical for every record in a space). Default `false`. The per-collection list routes honoured it and this call did not, so it was a `400` here and an `additionalProperties` refusal on the tool |

Any other field is a `400`. See **Unknown body fields are refused** below.

> **The five CONVENIENCES were REST-only until 5.0**, on the nine per-collection list routes this call replaces. A browser could ask for "facts tagged release" and an agent could not — both doors present, one accepting less. They are assembled by one module now, so `tag` cannot come to mean different things on the two doors, and a collection that cannot honour one says so rather than ignoring it.
>
> **The three name fields are on the tool too** — `filter` takes them with the same meaning and the same refusals, and `POST /api/filter` is the same call. They were REST-only until 5.0, which meant an agent could not ask for “facts about Alice” by name at all.

**`links` is read-only through THIS route, and it does have write doors of its own** — `POST /api/brain/spaces/:spaceId/links` and `DELETE /api/brain/spaces/:spaceId/links/:id`, with `save_link` and `delete_link` on MCP. This said it had none, which was true before 4.0 and stopped being when links became records. A link record says that one
record concerns another. Its `label` reads like a field name — `fact.entityIds` and its five siblings —
because each names the 4.x array the class replaced, and the label is part of the link's derived id
element. You write one by writing that array on the record, exactly as before; querying this collection is how
you read them back as rows.

A link document is deliberately small: `from` and `to` with a `fromKind` and `toKind` (`entity`,
`fact`, `chrono` or `file`), plus `author`, `createdAt`, `updatedAt` and `seq`. There is no label, type,
weight or description, because the two kinds already say which of the six connections it is — and no
embedding, so a link never competes in a meaning-ranked search.

**Response** `200`:

```json
{
  "results": [ ... ],
  "collection": "entities",
  "count": 12,
  "total": 4831,
  "limit": 20,
  "skip": 0
}
```

`count` is **this page**. `total` is **every document the filter matches**, ignoring `limit` and `skip` — that is the
number you need to know whether a sweep is finished, and without it a short last page is indistinguishable from a
truncated one. On a proxy space it is the sum across member spaces. It costs one count per member per call, bounded by
`maxTimeMS`, and it is always returned: a caller who does not know to ask for it is exactly the caller who ends up
guessing.

When you pass `sort`, the applied `sort` and `dir` are echoed back too.

#### Sortable fields, per collection

| Collection | Fields |
|---|---|
| `entities` | `createdAt`, `name`, `type` |
| `edges` | `createdAt`, `label`, `from`, `to`, `type`, `weight` |
| `facts` | `createdAt`, `type` |
| `chrono` | `createdAt`, `title`, `startsAt`, `endsAt`, `status`, `type` |
| `files` | `createdAt`, `updatedAt`, `path` |

The same allowlist, parser and error text as [Sorting](04-brain-api.md#sorting-all-brain-list-endpoints) on the list
endpoints. **`_id` is appended to every order**, including one you choose — that is what keeps the order *total*, so
`skip` pages through it without a row drifting between pages and being seen twice or missed.

#### Paging with `skip`

| Field | Default | Meaning |
|---|---|---|
| `limit` | `20` | Max documents, clamped to 100 |
| `skip` | `0` | Rows to discard before the page. Must be a **non-negative integer** — a negative or fractional value is a `400`, not a silent `0` |

The result order is **total** — `seq`, then `updatedAt`, `createdAt`, `_id` — so no row can drift between pages and be
seen twice or missed. Concatenating `skip=0,5,10,…` gives you the collection exactly once, in order.

```json
{ "results": [ … ], "collection": "facts", "count": 3, "limit": 3, "skip": 4 }
```

`limit` and `skip` are echoed back, so a paging loop can distinguish *the page you asked for* from *what the server
capped it to*. A `skip` past the end returns an empty `results` — it does **not** return the last page, so a loop that
stops on an empty page terminates.

On a **proxy space** the page is computed over the **merged** set of all member spaces, not per member: the server takes
the first `skip + limit` rows from each member, merges them into the documented order, and returns the window. A deep
page therefore costs more on a proxy space than on a plain one, but it is the same page.

#### A read result too large to return inline is bounded, and you page through the rest

`recall` and `similar` bound the response by **`maxChars`** (default **50 000 over REST, 25 000 over MCP** — the one
place the two doors deliberately differ) and, if you set it, by **`maxBytes`**, which has NO default and counts real
UTF-8 bytes. Set both and both apply: the answer stops at whichever it reaches first. `maxTokens` is a convenience
onto `maxChars`, converted at a fixed 3.5 characters per token (the `charsPerToken` override was removed in 5.0).

> **This paragraph named `maxBytes` as the defaulting parameter, at 100 000.** Neither half was right: the
> defaulting parameter is `maxChars` at 50 000, and `maxBytes` defaults to nothing. A caller sizing to 100 KB
> was truncated at 50 000 characters; one who set `maxBytes` expecting it to be *the* budget got both ceilings.
> The name changed meaning in 3.7 — it used to bound characters while its name, its refusal and its response
> field all said bytes. What fits comes back as the longest **prefix** of the
ranked matches, every record whole, and `nextSkip` says where to continue from — send it back as **`skip`** for
the next prefix, with no match repeated and none missed. A match is counted together with its whole `_graph`
subtree, so a deeper or wider traversal means fewer matches fit — they are absent, not shortened.

`returned`, `count`, `truncated`, `budgetChars`, `budgetBytes`, `charsReturned` and `bytesReturned` are on
**every** response, whether the budget bit or not, so an absence never has to be interpreted — `budgetBytes` is
`null` unless you asked for a byte ceiling. That is SEVEN fields; this listed five, omitting both character
figures, which is the same confusion as the paragraph above. `nextSkip` is there exactly when `truncated` is.
`count` stays the FULL total on a skipped page rather than shrinking as you advance.

**`remainderDump: true`** additionally writes what did not fit to the space's `_tmp/` as JSON and reports it as
`remainder: {matches, records, path, download, expiresAt}`. It is off by default because writing a file on a
read path counts against space storage and most callers want the next page rather than an artifact. `remainder`
carries **only** what did not fit — a continuation, not a copy. The file carries no embedding vectors and
expires after one day.

> **This replaced a 25-record cap that collapsed the answer to three inline matches plus a download of
> everything**, including the three already sent. `read_file` takes no offset or limit, so that roughly doubled
> what a caller had to read rather than reducing it. The full reasoning is in
> [Prefiltered Recall and the byte budget](04a-recall-api.md).

`recall` and `similar` with `traverse > 0` cap the traversed nodes they return inline. Past that cap the
**complete** graph is written to the space's file store under `_tmp/` as JSON, and the response carries
`graphTruncated: true` with `graphComplete: {nodes, path, download, expiresAt}`. The download is the normal
authenticated `GET /api/files/:spaceId?path=…`, the file expires after one day, and it is hidden from browsing
and never embedded.

The alternative — a `truncated` flag alone — tells a caller their graph was cut and leaves them no way to get
the rest, which on a neighbourhood is a dead end: there is no `total` to page against.

**It is still the right answer in one case, and since 3.6.1 it is used there.** The link scans that follow a
record's links are bounded per hop, and a hop can spend its budget on records it discards as already
visited — so the graph is short and there is no complete copy to write, because the missing records were never
read. `graphTruncated: true` arrives on its own. A caller that treated the two as inseparable should read the
flag and treat `graphComplete` as optional.

#### Unknown body fields are refused

These four read routes accept a fixed set of body fields and **reject anything else with a `400`** naming the offending
keys:

| Route | Accepted fields |
|---|---|
| `POST /filter` | `space`, `collection`, `filter`, `projection`, `limit`, `skip`, `sort`, `dir`, `maxTimeMS`, `entityName`, `fromName`, `toName`, `path`, `tag`, `type`, `description`, `properties`, `search`, `includeDiagnostics`, `deriveStatus`, `maxChars`, `maxBytes`, `maxTokens` |
| `POST /recall` | `space`, `query`, `topK`, `types`, `minScore`, `filter`, `traverse`, `tags`, `minPerType`, `maxPerType`, `maxTimeMS`, `includeFileContent`, `includeDiagnostics`, `includeRecordMeta`, `projection`, `maxChars`, `maxBytes`, `maxTokens`, `skip`, `remainderDump` |
| `POST /traverse` | `startId`, `direction`, `edgeLabels`, `maxDepth`, `limit`, `includeChrono`, `includeMemories`, `includeFiles`, `includeEdges` |
| `POST /similar` | `space`, `entryId`, `entryType`, `topK`, `minScore`, `targetTypes`, `traverse`, `includeFileContent`, `includeDiagnostics`, `projection`, `maxChars`, `maxBytes`, `maxTokens`, `skip`, `remainderDump`, `crossSpace` *(not deprecated: `space` pins the seed ENTRY here, `crossSpace` widens the SEARCH)* |

```json
{
  "error": "Unknown field(s): orderBy. Allowed: collection, filter, projection, limit, skip, sort, dir, maxTimeMS, maxChars, maxBytes, maxTokens",
  "unrecognized_keys": ["orderBy"]
}
```

**This is a deliberate break with the previous behaviour, and it is the point.** These bodies used to accept any key and
honour the ones they recognised. The fleet integrator paged a sweep with `skip` before it was implemented, got `200` every time, and
counted page one repeatedly as if it had advanced — *"it cost us a fabricated number"*. A parameter the server cannot
honour is now an error rather than a wrong answer that looks right.

`sort` and `dir` **are** accepted on `/query` — they were added after this refusal shipped, and this table is the
authoritative list rather than a summary of it. `client-bodies-match-server.test.js` compares every row here against the
sets the routes enforce, so a parameter cannot be added to a route and left undocumented, or documented as refused while
being accepted.

---

### List file metadata records

There is no `GET .../files`, and there has not been since 5.0 — file metadata is a collection like any
other, so it is read the same way:

```http
POST /api/filter
Content-Type: application/json

{ "space": "work", "collection": "files", "limit": 50, "tag": "design" }
```

Rows carry what the collection stores — `path`, tags, description, properties, size, author, timestamps —
plus the embedding job's step progress for any file still in flight, joined per member space so a UI can
draw which stage is running instead of a spinner that never resolves.

Two of the route's query parameters are worth naming, because neither is a plain predicate:

| the route | `filter` |
|---|---|
| `?path=` (exact, spelling-tolerant) | `path`, an ARGUMENT — see its row in the body table above. A bare `filter: { path }` is an exact equality and will miss a path spelled with the other separator |
| `?includeChunks=true` | there is no default here: `filter` returns CHUNK records too unless you exclude them with `filter: { parentFileId: { "$exists": false } }` |

**That second row is the one to read before porting a caller.** The route hid chunk records by default and
`filter` does not, because a default is a decision about what somebody meant and this door takes what they
said. A file converted to Markdown has one top-level record and one per chunk, so a listing that does not
exclude them looks like the same file many times over.

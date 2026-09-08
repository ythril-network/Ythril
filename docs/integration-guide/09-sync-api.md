# Notify & Sync APIs

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Notify API

Base path: `/api/notify`

### Send Event (peer-to-peer)

```http
POST /api/notify
```

```json
{
  "networkId": "net-uuid",
  "instanceId": "sender-uuid",
  "event": "sync_available"
}
```

Events: `vote_pending`, `member_departed`, `member_removed`, `space_deletion_pending`, `space_wipe_pending`, `sync_available`, `ping`.

**Response** `204`.

---

### List Events

```http
GET /api/notify?networkId=net-uuid&limit=50
```

---

### Trigger Sync

```http
POST /api/notify/trigger
Authorization: Bearer <instance-admin token>
```

```json
{ "networkId": "net-uuid" }
```

**Instance administrator, since 4.4.** It was any authenticated token until then — a token with no rights at
all could start a cycle on any network id it named, while `POST /api/networks/:id/sync`, which does the same
thing, already required an administrator.

Triggers an immediate sync cycle for the given network. **Fire-and-forget by default** — it returns as
soon as the cycle is scheduled:

**Response** `200`:

```json
{ "status": "triggered", "networkId": "net-uuid" }
```

**Synchronous mode** — add `?wait=true` to run the cycle and get its outcome in the response. Bounded by
`?timeoutMs` (default `30000`, clamped to `1000`–`120000`) so a slow or stuck cycle can't hang the
request; on timeout the cycle keeps running in the background.

```http
POST /api/notify/trigger?wait=true&timeoutMs=15000
```

**Response** `200` (completed): `{ "status": "completed", "networkId": "…", "synced": 12, "errors": 0 }`
· `504` (timed out, still running): `{ "status": "timeout", "networkId": "…", "timeoutMs": 15000 }`
· `500` (the cycle failed): `{ "status": "error", "networkId": "…", "error": "…" }`

#### One peer instead of a network

Send `peerId` in place of `networkId` to sync a single peer across every network it belongs to. Available
since 4.4 — the `sync_now` MCP tool had taken this argument from the start and no REST route accepted one,
so a REST caller could sync a network and never a single peer.

```json
{ "peerId": "inst-9f2c…" }
```

It must be an **exact `instanceId`** of a configured member, as returned by `GET /api/networks` — never a
URL and never a label. An id that belongs to no network is refused with `404`, because an unvalidated value
would become the address this instance connects to.

Sending both `networkId` and `peerId` is a `400`: they name different subjects. Sending neither is also a
`400`.

`?wait=true` applies here too, and the completed body reports `networksSynced` rather than `synced` — one
peer can belong to several networks. There is no `timeoutMs` race on this path: a single peer is bounded by
its own request timeouts, where a network cycle can span many peers.

---

## Sync API

### The peer version floor

Every `/api/sync/*` endpoint refuses a caller whose member record carries a version below
`minPeerVersion`, with **`426 Upgrade Required`** and a body naming both numbers:

```json
{
  "error": "Peer runs 3.4.0, below the minimum of 4.0.0 this network requires. Upgrade the peer to 4.0.0 or later.",
  "minPeerVersion": "4.0.0",
  "peerVersion": "3.4.0"
}
```

**`minPeerVersion` is THIS INSTANCE'S OWN MAJOR at `.0.0`, derived rather than configured.** A 4.x
instance requires 4.0.0; a 5.x instance requires 5.0.0. There is no setting, and the value moves with
the release.

Two reasons, and the first is the one that decided it:

- **Compatibility is not transitive, but a network is.** With a floor a few minors back, a 4.1 instance
  admits 3.2, which admits 2.5 — and records travel the length of that chain even though the ends were
  never compatible. Every hop is inside its own floor and the path is outside all of them. A floor at
  the running major cannot chain, because every member is inside the same breaking boundary.
- **It means what a major already means.** A major is where removals happen, so nothing a major deletes
  can still be needed by a peer, and there is no second number to keep in step with the changelog.

**The cost, stated plainly:** a network cannot be rolled across a major one instance at a time. The
moment one member reaches 4.0, every 3.x member stops syncing data until it is upgraded too. Plan a
major upgrade as one window. Minor and patch upgrades are unaffected and can be rolled in any order.

**A null `version` means one of TWO things, and `belowFloor` is what tells them apart.**

| Stored state | Verdict | Why |
|---|---|---|
| `version` below the floor | refused | it said so |
| `version` present but uncomparable | refused | a claim we cannot compare is not evidence of being current, and it only exists because the peer sent it |
| `version` null, `versionCheckedAt` **set** | refused | it answered and named none, so it predates version reporting |
| `version` null, `versionCheckedAt` **unset** | **not refused** | no exchange has completed, so there is no evidence either way |

The last row is load-bearing rather than a courtesy. A member can be legitimately versionless for ever:
a manually-provisioned peer, or a single-side-configured network, may never complete the gossip exchange
that reports a version. Refusing those stops the data plane permanently. Unreachability is already
counted and surfaced by `consecutiveFailures`, and the floor does not answer a question it has no
evidence for.

So do not infer a verdict from `version` — read `belowFloor`, which is the refusal sentence or `null`.

**A version — and the exchange stamp — are only ever learned from gossip**, so
`POST /api/sync/networks/:networkId/members` is the one endpoint the floor does not guard. The stamp is
written on BOTH directions: when this instance calls a peer and reads its piggybacked self-record, and
when a peer announces itself here. Either alone would leave a push-only or pull-only peer permanently
unjudgeable. That is the floor's input rather than a hole in it: refused
there too, a peer could never report that it had been upgraded. That route lets a below-floor peer
describe ITSELF — `instanceId`, `label`, `url`, `version` — and already refuses any attempt to write
another member's record. No brain document moves through it.

**Only a peer token is checked.** An admin or local token carries no `peerInstanceId`, is not another
instance, and has no version to report — running it through the floor would refuse an operator's own
tooling for being versionless.

**Both directions.** The floor is also applied outbound: a member below it is skipped for the data
plane and the cycle records the reason, so it appears in sync history rather than as a silent
exclusion. Governance is deliberately not gated — a vote round expires on a deadline, and refusing an
ejection vote about a stale peer because the peer is stale is how a network loses the ability to remove
it.

**Reading it from either door — the same three fields, per member, spelled the same way.**
`GET /api/networks`, `GET /api/networks/:id` and the MCP tool `list_peers` all carry `version` (what the
peer last reported, `null` if never), `belowFloor` (the refusal sentence, or `null`) and
`minPeerVersion` (this instance's floor, identical on every row) on each member.

`minPeerVersion` is per-member rather than on an envelope because `list_peers` returns a bare JSON
array by contract, and wrapping it would break every caller that indexes the result. Repeating a
constant per row is that tool's existing idiom — `network`, `networkId` and `networkType` already are —
and it keeps one spelling of the fact across both doors.

Base path: `/api/sync` — used by the sync engine between peers. All endpoints require auth + sync rate limit.

### Route Overview

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/sync/memories` | GET | Page memory changes (`items`, `nextCursor`) |
| `/api/sync/memories/:id` | GET | Fetch one full memory doc |
| `/api/sync/memories` | POST | Upsert one remote memory |
| `/api/sync/entities` | GET | Page entity changes |
| `/api/sync/entities/:id` | GET | Fetch one full entity doc |
| `/api/sync/entities` | POST | Upsert one remote entity |
| `/api/sync/edges` | GET | Page edge changes |
| `/api/sync/edges/:id` | GET | Fetch one full edge doc |
| `/api/sync/edges` | POST | Upsert one remote edge |
| `/api/sync/chrono` | GET | Page chrono changes |
| `/api/sync/chrono/:id` | GET | Fetch one full chrono doc |
| `/api/sync/chrono` | POST | Upsert one remote chrono doc |
| `/api/sync/links` | GET | Page link-record changes |
| `/api/sync/links/:id` | GET | Fetch one full link doc |
| `/api/sync/filemeta` | GET | Page a file's METADATA changes — parents only, never chunks |
| `/api/sync/filemeta/:id` | GET | Fetch one full file metadata doc |
| `/api/sync/batch-upsert` | POST | Bulk upsert memories/entities/edges/chrono/links/filemeta |
| `/api/sync/tombstones` | GET | List tombstones by seq |
| `/api/sync/tombstones` | POST | Apply remote tombstones |
| `/api/sync/manifest` | GET | File manifest diff |
| `/api/sync/file-tombstones` | GET | List file deletion tombstones |
| `/api/sync/file-tombstones` | POST | Apply file deletion tombstones |
| `/api/sync/merkle` | GET | Compute Merkle root |
| `/api/sync/networks/:networkId/members` | GET | Pull gossip member view |
| `/api/sync/networks/:networkId/members` | POST | Push gossip member updates |
| `/api/sync/networks/:networkId/votes` | GET | Pull open governance rounds |
| `/api/sync/networks/:networkId/votes/:roundId` | POST | Relay a yes/veto vote |
| `/api/sync/warm` | POST | Pre-sync warm-up (auth/embedding/DB) |

**Link records have no single-record `POST`, and that is deliberate.** A link is written by writing the array
field it comes from on the record that holds it — `memory.entityIds`, `chrono.entityIds`/`memoryIds`,
`file.entityIds`/`memoryIds`/`chronoIds` — so there is no independent create for a peer to mirror. Link
records reach a peer through `batch-upsert`, which is what a sync cycle uses for every family anyway; the
per-family `POST` routes are the older single-record path.

### A file's METADATA replicates; the bytes travel separately (4.0)

```http
GET /api/sync/filemeta?spaceId=&networkId=&sinceSeq=&limit=&full=true
GET /api/sync/filemeta/:id
```

The bytes have always moved through the manifest and `/api/files`. From 4.0 the file's **metadata record**
moves too — its description, tags, properties, and the three link arrays.

**Before this, a file linked to an entity on one instance sent the LINK record and not the array it came
from.** So the graph on a peer showed the connection and the peer's own file list showed none: two answers
to one question, differing by which collection you asked.

**Only the AUTHORED half crosses the wire, and the ingest MERGES rather than replaces.** A file meta record
holds three different kinds of field:

| | |
|---|---|
| **authored** — replicates | `description`, `descriptionSource`, `tags`, `entityIds`, `memoryIds`, `chronoIds`, `properties`, `author`, `createdAt`, `updatedAt`, `seq`, the two suppression spellings |
| **derived from the local blob** — never sent, never overwritten | `sizeBytes`, `sha256`, `excerpt`, the vector, `chunkCount`, `embeddingStatus`, `conversionError` |
| **chunk-only** — the whole record is refused | `parentFileId`, `chunkIndex`, `content` |

A whole-document replace would leave the file reporting the SENDER's size and hash with no vector at all —
findable by neither its own text nor its own name, with nothing having failed. So the write is a `$set` of
the keys that arrived, and a key the sender omits is **left alone rather than cleared**: a peer on an older
build sends fewer fields, and reading absence as deletion would let it erase a description it has never
heard of.

**A chunk sent to `batch-upsert` is REFUSED and reported**, not stripped. A chunk is derived from the blob
and the receiver makes its own, with its own chunker and its own model; stripped, it would land as a FILE
under an id ending in `#0`, carrying another instance's passage text.

**Deletions travel on `/api/sync/file-tombstones`**, as they always have — a deleted file has a file
tombstone rather than a brain one, so the metadata page carries no tombstones of its own.

> **Metadata written before 4.0 has no `seq`, and the page cursor is `seq > n`.** So it does not reach a
> peer until the record is next written. `npm run links:convert` stamps the ones already stored, and it is
> the same one-off an operator runs for the link records — idempotent, and safe to run twice.

### Common Query Parameters

| Parameter | Description |
|---|---|
| `spaceId` | Required on space-scoped sync routes |
| `networkId` | Optional on many pulls, used for policy checks and directional sync |
| `sinceSeq` | Start sequence for incremental pulls |
| `cursor` | Encoded continuation cursor for paged pulls |
| `limit` | Page size (typically max 500; endpoint-specific caps apply) |
| `full=true` | Return full docs instead of `_id`/`seq` stubs on list routes |

### Incremental Collection Pull Example

```http
GET /api/sync/memories?spaceId=general&sinceSeq=0&limit=200&full=true
```

Returns `{ items, nextCursor }`. Use `nextCursor` as `cursor` on the next request until `nextCursor` is `null`.

### Single-Document Pull Example

```http
GET /api/sync/entities/:id?spaceId=general
```

Returns `404` when missing.

### Bulk Push Example

```http
POST /api/sync/batch-upsert?spaceId=general&networkId=net-uuid
```

```json
{
  "memories": [ ... ],
  "entities": [ ... ],
  "edges": [ ... ],
  "chrono": [ ... ]
}
```

Each array is capped at 500 items. Response includes per-type counters:

```json
{ "status": "ok",
  "memories": { "inserted": 3, "updated": 1, "forked": 0, "skipped": 12, "forkDepthRefused": 0, "tombstoned": 0 },
  "entities": { "upserted": 5, "skipped": 2, "tombstoned": 0 },
  "edges":    { "upserted": 0, "skipped": 0, "tombstoned": 0 },
  "chrono":   { "upserted": 0, "skipped": 0, "tombstoned": 0 } }
```

**`skipped` is benign and `forkDepthRefused` is not — read the second one.** They were one counter until now,
which is the whole reason this paragraph exists.

| counter | what happened | did the record land? |
|---|---|---|
| `skipped` | the receiver already holds that record at the same `seq` or newer | **nothing was lost** — this is ordinary conflict resolution and is by far the common case |
| `forkDepthRefused` | memories only: content diverged at an identical `seq` and the record's fork chain is already at its cap, so the incoming version was **discarded** | **no — the record is gone** |

**A `200` therefore does not mean every record was applied.** If you push, read `forkDepthRefused`: a non-zero
value means those records did not land, and our own sync engine will **not** offer them again — it advances its
watermark regardless, because the receiver would refuse the identical record on every future cycle and holding
the watermark back would stall the space instead. Both ends log it; the receiver's log names the record ids.

A peer on an older build omits `forkDepthRefused` entirely, so treat a missing field as zero rather than as an
error.

### A duplicate relationship is reported, not an error

An edge's identity is its `(from, to, label)` triplet — that combination is uniquely indexed — while its `_id`
is random. So when two instances create the same relationship independently there is **one relationship under
two ids**, and the receiver cannot store the second without breaking that index.

It answers `200` and says so, rather than failing:

```json
// single-record POST /api/sync/edges
{ "status": "duplicate" }
```

```json
// batch-upsert
{ "edges": { "upserted": 12, "skipped": 3, "tombstoned": 0, "duplicateTriplets": 1 } }
```

**The local copy stands and the incoming one is not applied** — the same rule the pull side uses, so both
directions resolve it identically. The receiver logs the triplet.

**Why this is a 200 and not a 409.** A push that gets a non-2xx stops that collection's transfer and does not
advance its watermark, so the next cycle re-sends the identical batch and hits the identical duplicate. An
error here would not retry — it would stop that channel making progress for as long as the duplicate exists.
Reporting inside a `200` is what lets the rest of the batch land and the cursor move on.

Treat a missing `duplicateTriplets` as zero: a peer on an older build omits it.

### A vector never crosses the wire, and the receiver decides whether to make one (3.7)

Owner's ruling, 2026-09-01. Three things follow from it, and a client that pushes documents needs all three.

**Send no embedding.** No ingest schema declares `embedding` or `embeddingModel`, so if you send them they
are dropped. A vector is derived from the text by one particular model; two instances running different
models — or different versions of one — hold legitimately different vectors for identical content, and
ranking one against the other produces plausible-looking nonsense rather than an error. Memories were the
last type that carried theirs; now none do.

**The same holds when this instance PULLS from you, and until 4.0 it did not.** The schemas above run on the
push path; a pull fetches whole documents and validates nothing, so a pulled record kept the sender's vector
— and, more expensively, the sender's `_expireAt`, which the receiving instance's retention sweep then
acted on. Both directions now drop the same five fields, and the serving side leaves them out of the page
altogether, so a sync page is materially smaller than it was.

**The receiver embeds what it accepts, on its own terms.** Every accepted document is queued for embedding
against the receiving instance's own model, at the moment it is written. Nothing has to ask for this and there
is no flag for it.

**Send the suppression mark, and it will be honoured.** `suppressEmbeddings` replicates, on all four
types. Its pre-3.1 spelling `excludeFromVectorSearch` replicated too until 4.0 removed it; an ingest
schema no longer declares it, so it is stripped on push like any other unknown field. Suppression resolves `record > schema > space`:
the schema and space tiers are the receiver's own configuration, and the record tier is the mark on the
document. Strip it and the ruling inverts on that record: an entry its author kept out of meaning-ranked
search would enter one on every peer. Absent means "not stated" and falls through to the tiers below, so
omitting the field is correct and `false` is not the same as omitting it.

A suppressed record is not queued at all on arrival, rather than queued and discarded when the job runs. Both
end with no vector; only one of them leaves a queue full of work whose purpose is to be thrown away.

**Three more fields began replicating in the same release**, and each was being silently deleted on push
because zod strips what a schema does not declare:

| Field | On | Why losing it mattered |
|---|---|---|
| `type` | memory | it selects the memory's type schema, so an arriving memory was validated against nothing and missed every type filter |
| `contentRedacted` | chrono | it is what lets a reader tell *"this entry never had a description"* from *"it had one and its retention window lapsed"* |
| `contentRedactedAt` | chrono | when that happened |

None of these was reported by anybody. They were found by deriving one rule from two mechanisms that were
already in the code: **a field the divergence check hashes must replicate.** If it does not, the sender's copy
has the key, the receiver's does not, and the two Merkle roots differ for ever — so a network with
`merkle: true` logs a `MERKLE_DIVERGENCE` warning every cycle for a space where nothing is wrong. A permanent
false alarm teaches an operator to ignore the one signal that means data really is missing.

**The two retention stamps went the other way, and that is now settled.** `_expireAt` and `_contentExpireAt`
are excluded from the hash rather than replicated. They cannot travel — each instance computes its own from its
own policy, and shipping the sender's would let one peer decide when another deletes its data — so before this
release, a network with `merkle: true` logged a `MERKLE_DIVERGENCE` warning every cycle for every space with a
retention policy, when nothing was wrong with any of them.

The marks a lapsed content window leaves behind, `contentRedacted` and `contentRedactedAt`, are the opposite
case and DO replicate and DO get hashed: they say what the record is, not when the instance will act. Excluded,
a redacted entry would hash identically to one that still has its detail — real divergence going unreported.

### Schema mismatches are reported, never refused

Two instances in one network may declare **different schemas for the same space**. A record the sender
validated against its own rules can therefore break the receiver's — and discarding it is not the receiver's
call, because the sender believes it delivered.

So an ingest **stores the record and hands back what broke the rules.** Both doors report, in the shape each
already uses:

```json
// batch-upsert — a per-type counter, beside inserted/updated/skipped
{ "status": "ok",
  "entities": { "upserted": 5, "skipped": 2, "tombstoned": 0, "schemaViolations": 2 } }
```

```json
// any single-record route — the violations themselves, beside the status
{ "status": "inserted",
  "schemaViolations": [
    { "field": "properties.severity", "value": "catastrophic", "reason": "must be one of: low, medium, high" }
  ] }
```

**`schemaViolations` is absent when there are none**, so a clean ingest returns exactly what it always did and
a present field always means something to look at. A peer on an older build omits it entirely; treat missing
as none.

**The record landed either way.** This is a report, not a refusal — reconcile the two schemas, or accept the
divergence deliberately.

| the check | what happens |
|---|---|
| a property, tag or type that breaks the space's declared schema | **stored**, and counted or listed |
| a chrono `type` outside both the product's vocabulary and anything the space declares | **`400`, refused** |

The second row is the one exception, and it is not about disagreement: such a record is meaningless to every
reader rather than merely non-conforming, and nothing else in the pipeline would catch it.

### Tombstones

- `GET /api/sync/tombstones?spaceId=general&sinceSeq=0` returns grouped `{ entities, memories, edges, chrono, links }` tombstones. The keys are derived from the tombstone types, so a new record kind appears here without a protocol change; a client should read the keys it knows and ignore the rest.
- `POST /api/sync/tombstones` accepts `{ tombstones: [...] }` and applies deletions.

**The `sinceSeq` you send is recorded.** The serving instance stores it as `lastSeqServed` for your peer identity and prunes tombstones that every member has pulled past — that is the only retention bound on the collection, because an age-based one would let a long-absent peer resurrect a deleted record. Two consequences for an integrator:

- **Send your real watermark, and never a value higher than what you have applied.** Claiming a position you have not reached lets the other side drop tombstones you still need.
  - **And a watermark shared across several transfers may only reach where ALL of them are complete.** A cycle that fetches tombstones plus four collections under one `sinceSeq` must limit its next `sinceSeq` to the lowest position among the transfers that stopped early — a non-`2xx`, or a page cap. Taking the maximum instead claims a position the stopped transfer never reached, and its unserved records then sit behind your watermark permanently while every later cycle looks successful. Our own engine had this defect until 3.2.0.
- **A peer that never pulls tombstones blocks pruning for its spaces** — deliberately, since "has not pulled" and "has caught up" must not look alike.

### File Sync Artifacts

- `GET /api/sync/manifest?spaceId=general` returns file digest metadata for delta detection.
- `GET /api/sync/file-tombstones?spaceId=general&since=<ISO>` returns file delete tombstones. **The sync engine
  deliberately omits `since`**: a file tombstone carries its original `deletedAt` and can be relayed onward long
  afterwards, so filtering by it would skip an older deletion arriving late and the file would stay. Use it only
  if you can tolerate that.
- `POST /api/sync/file-tombstones` applies file delete tombstones (`{ spaceId, tombstones: [...] }`).
  **Your `200` is an acknowledgement.** The sender records the newest `deletedAt` in the batch as your confirmed
  position and eventually drops its own copies below the minimum across all members — so answer `200` only once
  the tombstones are durably recorded. `{ applied: 0 }` is a valid acknowledgement (the upsert is idempotent);
  a non-2xx or a timeout means the sender keeps its copies, which is the safe direction.

### Merkle Consistency Check

```http
GET /api/sync/merkle?spaceId=general&networkId=net-uuid
```

**Response** `200`:

```json
{
  "spaceId": "general",
  "root": "sha256-hex-string",
  "leafCount": 123,
  "computedAt": "2026-04-15T10:00:00.000Z",
  "networkId": "net-uuid"
}
```

Each brain-document leaf hashes the document's **content** (canonical JSON, keys sorted), not just its
`_id`/`seq` — so a mismatch detects tampered content, not only missing or version-skewed documents.

Five fields are excluded, and the rule behind the list is worth knowing if you are comparing roots yourself:
**a field that is hashed must replicate.** `embedding`, `embeddingModel` and `matchedText` are derived by the
local model, so peers running different models legitimately differ. `_expireAt` and `_contentExpireAt` are
retention stamps each instance computes from its own policy — a peer's stamp is never adopted, in either
direction, because the sweep that acts on it would then be following another operator's policy. Everything
else is hashed, and everything else crosses the wire — a field in neither category means two peers can never agree about identical content. File leaves hash the file's SHA-256. The check is advisory: a root mismatch is reported as `MERKLE_DIVERGENCE`, it does not block sync.

### Gossip Endpoints

- `GET /api/sync/networks/:networkId/members` returns current member view (sensitive fields stripped).
- `POST /api/sync/networks/:networkId/members` accepts member updates for gossip propagation. The `self` record carries the sender's `signingPublicKey`, which the receiver pins trust-on-first-use for verifying that member's signed votes.
- `GET /api/sync/networks/:networkId/votes` returns open rounds.
- `POST /api/sync/networks/:networkId/votes/:roundId` relays `{ vote: "yes" | "veto", instanceId, sig?, castAt? }`. A cast bearing a valid `sig` (Ed25519 over `ythril-vote:v1|network|round|subject|voter|vote`) is accepted from any relaying peer; an unsigned cast is accepted only directly from its own voter. Returns `403` if the cast is rejected. See [Sync Protocol → Signed vote casts](../sync-protocol.md).

If this instance has been ejected from a network, `/api/sync/networks/:networkId/*` returns `401` with `{ "error": "ejected" }`.

### Warm-Up Endpoint

```http
POST /api/sync/warm
```

```json
{ "networkId": "net-uuid", "spaces": ["general"] }
```

Preloads embedding model and collection handles before a full sync cycle.

**Response** `200`:

```json
{ "status": "ready" }
```

---

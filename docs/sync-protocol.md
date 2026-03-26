# Ythril Sync Protocol

This document describes how two brains exchange data in a sync cycle: the sequence of HTTP calls, conflict rules, watermarks, and the WAN-efficiency optimisations applied to each phase.

---

## Overview

Sync is **peer-to-peer over plain HTTPS**. Each brain calls its peers directly using the URL stored in the `member.url` config field — typically `https://brain.example.com`. There is no central broker.

A sync cycle for a single member consists of four phases in order:

| Phase | Direction | Description |
|-------|-----------|-------------|
| **Pull** | peer → us | Fetch everything the peer has that we haven't seen yet |
| **Push** | us → peer | Upload everything we have that the peer hasn't seen yet |
| **File sync** | peer → us | Download files whose SHA-256 digest differs from ours |
| **Gossip** | us ↔ peer | Exchange member identity records (label, URL, children) |

Phases 1 and 2 are gated by [watermarks](#watermarks) so only new or changed documents travel over the wire. Phase 3 is manifest-based and equally incremental. Phase 4 propagates identity metadata across the member graph.

---

## Trigger

Sync can be triggered two ways:

- **Scheduled** — `syncSchedule` on the network config (e.g. `"*/5 minutes"`, `"every 1h"`) starts a cron timer per network at startup. Format supports `*/N minutes|hours` and `every Nm|Nh`.
- **Manual** — `POST /api/notify/trigger { networkId }` runs the cycle immediately and returns `{ synced, errors }`.

---

## Watermarks

Two independent high-water marks prevent redundant data transfer:

| Field | Type | Meaning |
|-------|------|---------|
| `lastSeqReceived[spaceId]` | `Record<string,number>` | Highest seq we have ever pulled from this peer for this space |
| `lastSeqPushed[spaceId]` | `Record<string,number>` | Highest seq we have confirmed pushed to this peer for this space |

Both are stored per member in the config file and persisted immediately after a successful sync. If a sync fails mid-way, the watermark is not advanced — the next cycle retries from the last safe point, giving at-least-once delivery semantics.

---

## Pull phase

```
GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq={lastSeqReceived}     (1 request)
GET /api/sync/memories?spaceId=&...&full=true&limit=200                     (ceil(N/200) requests)
GET /api/sync/entities?...                                                  (ceil(N/200) requests)
GET /api/sync/edges?...                                                     (ceil(N/200) requests)
GET /api/sync/chrono?...                                                    (ceil(N/200) requests)
```

### Why `?full=true`

Without `?full=true` the list endpoints return `{_id, seq}` stubs, and the caller would need a second `GET /api/sync/memories/:id` request per document to fetch the full content — **N additional round-trips** per sync cycle.

With `?full=true` the full document payload is embedded in the paginated list response. The pull phase is `ceil(N/200)` requests regardless of how many documents exist.

**Impact at 100 ms WAN latency:**

| Documents changed | Before | After |
|---|---|---|
| 10,000 | ~10,001 requests, ~17 min | ~51 requests, ~5 s |
| 1,000  | ~1,001 requests, ~1.7 min | ~6 requests, ~600 ms |
| 100    | ~101 requests, ~10 s | ~1 request, ~100 ms |

### Tombstones pulled first

Tombstones are fetched before documents so that a deletion that arrived at the peer applies before the engine could accidentally re-insert the same document that was just deleted. After tombstones are applied, items appearing in the list with a `deletedAt` field are skipped (they're stubs that the tombstone phase already handled).

### `lastSeqReceived` update

After all three document types are pulled, `lastSeqReceived[spaceId]` is advanced to the highest `seq` seen **among documents authored by the peer** (`doc.author.instanceId === member.instanceId`) and written to config. On the next cycle the watermark is passed as `sinceSeq` so the peer returns only documents newer than that point.

Docs that originate from a third instance but were relayed through the peer (e.g. during braintree fanout) deliberately do not advance the watermark. Those relayed docs may carry a `seq` assigned by their true author's counter, which can be much higher than the peer's own counter. Allowing them to advance `lastSeqReceived` would cause the engine to skip the peer's locally-written documents on the next pull.

---

## Push phase

```
POST /api/sync/tombstones?spaceId=&networkId=                               (0 or 1 request)
POST /api/sync/batch-upsert?spaceId=&networkId=                             (ceil(changed/200) requests)
```

### Incremental push via `lastSeqPushed`

The engine queries only documents with `seq > lastSeqPushed[spaceId]`. If nothing has changed since the last cycle, no HTTP requests are made for that type.

If the peer has never been synced (`lastSeqPushed` = 0), the full history is sent — but still in batches, not one request per document.

### `POST /batch-upsert`

Accepts `{ memories?: MemoryDoc[], entities?: EntityDoc[], edges?: EdgeDoc[], chrono?: ChronoEntry[] }` in a single request. Up to 500 documents per type per request. The server applies the same conflict rules as the individual `POST /memories`, `POST /entities`, `POST /edges`, `POST /chrono` endpoints:

| Type | Rule |
|------|------|
| Memories | `incoming.seq > existing.seq` → overwrite; equal seq + different fact → **fork** (new `_id`); else skip |
| Entities | `incoming.seq > existing.seq` → overwrite (upsert); else skip |
| Edges | same as entities |
| Chrono | same as entities |

Response: `{ status: 'ok', memories: {inserted,updated,forked,skipped,tombstoned}, entities: {upserted,skipped,tombstoned}, edges: {upserted,skipped,tombstoned}, chrono: {upserted,skipped,tombstoned} }`

### `lastSeqPushed` update

After a successful batch push, `lastSeqPushed[spaceId]` is advanced to the highest `seq` **among documents authored by this instance** (`doc.author.instanceId === cfg.instanceId`). This is evaluated per-batch so an interrupted push (network drop mid-way) advances the watermark only as far as the last acknowledged batch.

Relayed docs (received from a third peer and stored locally) are pushed to other members but do **not** advance `lastSeqPushed`. Their seq values belong to the originating instance's counter and could be arbitrarily higher than the local counter, which would incorrectly suppress future pushes of this instance's own work.

**Non-braintree push filter**: for `closed`, `democratic`, and `club` networks, only documents authored by this instance are queried for push (`{ seq: { $gt: lastSeqPushed }, 'author.instanceId': cfg.instanceId }`). This prevents echoing a peer's own documents back to them. For `braintree` networks no author filter is applied — relay of third-party docs through the tree is the intended topology.

---

## Conflict resolution

### Memories — fork on equal sequence

Memories are the primary content type. If two brains independently edit the same document (same `_id`) and their changes produce the same `seq` counter:

```
Brain A:  { _id: "abc", seq: 5, fact: "The sky is blue" }
Brain B:  { _id: "abc", seq: 5, fact: "The sky is cerulean" }   ← concurrent edit
```

The receiving brain detects `incoming.seq === existing.seq && incoming.fact !== existing.fact` and creates a **fork**: a new memory with a fresh UUID, `forkOf: "abc"`, and the next available `seq`. Both versions coexist and can be reviewed by the user.

### Entities and edges — last-writer-wins

Entities and edges are structural metadata (names, relationships). They use a simpler `seq`-wins rule: the document with the higher `seq` survives. Equal seq is treated as a no-op (already in sync).

---

## Timeouts

| Constant | Value | Applied to |
|----------|-------|------------|
| `FETCH_TIMEOUT_MS` | 10 s | Tombstone requests, individual per-doc requests (legacy), manifest requests, file downloads |
| `BATCH_FETCH_TIMEOUT_MS` | 60 s | `GET /memories?full=true`, `GET /entities?full=true`, `GET /edges?full=true`, `POST /batch-upsert` |

The separation prevents a single slow 800 KB batch payload from being aborted by the 10 s timeout while also preventing a timed-out offline peer from holding up a sync cycle for more than 10 s per non-batch call.

---

## Consecutive failure handling

Each failed sync attempt for a member increments `consecutiveFailures`. The member is **never auto-removed** — removal requires the same governed vote process as any other removal.

| Threshold | Action |
|-----------|--------|
| 10 failures | `PEER UNREACHABLE` warning logged with last-success timestamp |
| Every 10 more | Repeated `PEER STILL UNREACHABLE` reminder |

For braintree networks the warning includes a note identifying how many children are in the partitioned subtree.

On the next successful sync the counter resets to 0.

---

## Braintree directional sync

In a braintree network, `member.direction` controls which phases run:

| `direction` | Pull runs? | Push runs? |
|------------|-----------|-----------|
| `both` | yes | yes |
| `push` | no | yes |

A leaf node has `direction='push'` toward its parent — meaning the engine pushes down to children and only the parent pulls from its own source. Data does not travel upward.

---

## File sync

After document sync, the engine performs a manifest-based file sync:

1. `GET /api/sync/manifest?spaceId=&networkId=` retrieves the peer's list of `{ path, sha256, size, modifiedAt }`.
2. Entries where the local SHA-256 differs (or the file is absent) are downloaded via `GET /api/files/:spaceId/:path`.
3. The downloaded bytes are SHA-256 verified before writing to disk. A mismatch is logged and the file is discarded.

File sync uses the standard 10 s timeout per request. Large files that exceed this will be retried on the next cycle.

---

## Gossip phase

After file sync, each engine cycle performs a lightweight member identity exchange with each peer:

1. **Self-announce** — `POST /api/sync/networks/:networkId/members` with `{ instanceId, label, children?, url? }`. The `url` field is included only when the `INSTANCE_URL` environment variable is set; if omitted, the peer keeps the URL it already has on record.

2. **Self-record piggyback** — the receiving peer includes its own current identity in the `200` response as `{ status: 'ok', self: { instanceId, label, url? } }`. The caller updates its local member entry for that peer from this payload — no separate GET is needed.

3. **Pull member view** — `GET /api/sync/networks/:networkId/members` fetches the peer's full member list. Any record whose `instanceId` is already known locally (but is not our own `instanceId`) has its `url`, `label`, and `children` merged in if they differ.

### Gossip poisoning protection

On the receiving side, the `POST /api/sync/networks/:networkId/members` endpoint only updates the record for the exact `instanceId` in the request body. It will not update any other member's record — so a compromise peer cannot overwrite other members' identity details. Unknown `instanceId` values (not already in the member list) are silently acknowledged as `{ status: 'unknown_member' }` and never auto-added.

On the pulling side, records returned by `GET /members` that share our own `instanceId` are never applied.

---

## API reference

All endpoints are under `/api/sync` and require a `Bearer` token that resolves to a network member (peer token, not a user PAT). Rate-limited per IP.

### Read endpoints (called during pull)

| Method | Path | Key params | Returns |
|--------|------|------------|---------|
| `GET` | `/api/sync/memories` | `spaceId`, `networkId`, `sinceSeq`, `limit`, `cursor`, `full` | `{ items[], nextCursor }` |
| `GET` | `/api/sync/memories/:id` | `spaceId`, `networkId` | Full `MemoryDoc` |
| `GET` | `/api/sync/entities` | same as memories | `{ items[], nextCursor }` |
| `GET` | `/api/sync/entities/:id` | `spaceId`, `networkId` | Full `EntityDoc` |
| `GET` | `/api/sync/edges` | same as memories | `{ items[], nextCursor }` |
| `GET` | `/api/sync/edges/:id` | `spaceId`, `networkId` | Full `EdgeDoc` |
| `GET` | `/api/sync/tombstones` | `spaceId`, `networkId`, `sinceSeq` | `{ memories[], entities[], edges[] }` |
| `GET` | `/api/sync/manifest` | `spaceId`, `networkId` | `{ manifest[{ path, sha256, size, modifiedAt }] }` |
| `GET` | `/api/sync/info` | — | `{ instanceId, label, version }` |
| `GET` | `/api/sync/networks/:networkId/members` | `networkId` | `{ members[{ instanceId, label, url, direction, … }], updatedAt }` |

`?full=true` on the list endpoints returns complete documents instead of `{_id,seq}` stubs. Maximum `limit` is 500. Tombstone stubs (items with `deletedAt`) are always appended to list responses regardless of `full` mode.

### Write endpoints (called during push)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/api/sync/memories` | `MemoryDoc` | `200 { status:'ok' }` |
| `POST` | `/api/sync/entities` | `EntityDoc` | `200 { status:'ok' }` |
| `POST` | `/api/sync/edges` | `EdgeDoc` | `200 { status:'ok' }` |
| `POST` | `/api/sync/batch-upsert` | `{ memories?, entities?, edges? }` | `200 { status:'ok', memories:{…}, entities:{…}, edges:{…} }` |
| `POST` | `/api/sync/tombstones` | `{ tombstones[] }` | `200 { applied: N }` |

`POST /batch-upsert` is the primary push path used by the engine. The individual `POST /memories`, `/entities`, `/edges` endpoints remain for backwards compatibility and direct API usage.

All incoming documents are validated against Zod schemas before any database write. Invalid documents are rejected with `400` (single endpoints) or silently filtered out (batch-upsert). Key constraints: `tags` max 100 items, `entityIds` max 500, `seq` max 2^50, all string fields validated for type safety. Unknown fields are stripped.

### Gossip endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/sync/networks/:networkId/members` | — | `{ members[], updatedAt }` |
| `POST` | `/api/sync/networks/:networkId/members` | `{ instanceId, label, url?, children? }` | `{ status: 'ok'\|'unknown_member', self?: { instanceId, label, url? } }` |

The `self` field in the `POST` response carries the receiver's own identity so the caller can update its record for the peer in a single round-trip.

### Vote propagation endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/sync/networks/:networkId/votes` | — | `{ rounds[VoteRound] }` |
| `POST` | `/api/sync/networks/:networkId/votes/:roundId` | `{ vote: 'yes'\|'veto', instanceId }` | `200 { status:'ok' }` \| `404` |

Sensitive fields (`inviteKeyHash`, `pendingMember.tokenHash`) are stripped from `GET` responses before sending to peers.

---

## Vote propagation phase

After the gossip (member identity) exchange, the engine runs a vote propagation pass with each peer:

1. **Push casts** — for each open local vote round, each known vote cast is relayed to the peer via `POST /api/sync/networks/:networkId/votes/:roundId { vote, instanceId }`. If the peer does not yet have the round (404), the push is silently skipped — the round will arrive on the peer's next pull cycle.

2. **Pull rounds** — `GET /api/sync/networks/:networkId/votes` fetches the peer's open rounds. For each round:
   - **New round**: if the round does not exist locally, it is adopted into `pendingRounds` (with an empty `votes` array); votes are then merged in the same pass.
   - **Vote merge**: for each cast from the peer's round, if the cast is not already present locally it is added. If the same voter's cast differs (e.g., updated from `yes` to `veto`), the local cast is replaced.

3. **Round conclusion** — after all merges, `concludeRoundIfReady` is evaluated for every open local round. Unanimous-type networks (closed, braintree) require every listed remote member to have individually cast `yes`; a single outstanding member prevents conclusion. Democratic networks use a simple majority count. Club networks conclude on the first `yes`.

4. **Side effects** — if a `space_deletion` round concludes with zero vetoes, the space is removed from the local instance asynchronously.

This means a vote cast on any peer propagates to all other peers within one gossip cycle per hop, and a round concludes independently on each instance as soon as it has received enough votes to satisfy its network's pass condition.

---

## Leave and removal flows

### Voluntary leave (`DELETE /api/networks/:id`)

When an instance removes itself from a network, it broadcasts a `member_departed` event to all current members before deleting the network locally:

1. For each member in the network, it sends `POST /api/notify { networkId, instanceId, event: "member_departed" }` using the stored peer token, with a 5-second fire-and-forget timeout.
2. The local network entry is then spliced from `cfg.networks` and config is saved.

On the **receiving** end of a `member_departed` event:
- The sender is removed from `net.members` for all network types.
- The event is **idempotent** — if the sender is no longer in the member list (already processed), the call returns `204` rather than `403`. This handles duplicate delivery and race conditions gracefully.
- N-7 braintree auto-adopt logic runs as before (orphaned children are re-parented to the closest surviving ancestor).

### Forced removal (remove vote)

A `remove` vote round passes when the network's conclusion rule is satisfied. Once concluded, the observing instance sends a `member_removed` notify event to the ejected instance:

- `sendMemberRemovedNotify(subjectUrl, subjectInstanceId, networkId)` is called from three places: the vote relay handler in `sync.ts`, the vote handler in `networks.ts`, and the gossip engine in `engine.ts` (all after `concludeRoundIfReady` returns true for a `remove` round).
- The ejected instance receives `POST /api/notify { networkId, instanceId, event: "member_removed" }`.

On the **receiving** end of a `member_removed` event:
1. `networkId` is added to `cfg.ejectedFromNetworks` (deduplicated).
2. The network entry is removed from `cfg.networks`.
3. Config is saved.

Subsequently, any sync request to `/api/sync/networks/:networkId` for an ejected network ID returns `401 { "error": "ejected" }` via an early-exit middleware, preventing stale sync attempts.

> **Note on peer token lifecycle**: peer tokens (stored in `secrets.peerTokens`) are *infrastructure-level* credentials representing a trusted peering relationship and are not automatically revoked when a member leaves or is removed from a network. Token revocation is a separate, explicit administrative action.



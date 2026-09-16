# Ythril Sync Protocol

This document describes how two brains exchange data in a sync cycle: the sequence of HTTP calls, conflict rules, watermarks, and the WAN-efficiency optimisations applied to each phase.

---

## Overview

Sync is **peer-to-peer over plain HTTPS**. Each brain calls its peers directly using the URL stored in the `member.url` config field — typically `https://brain.example.com`. There is no central broker.

A sync cycle for a single member consists of these phases in order:

| Phase | Direction | Description |
|-------|-----------|-------------|
| **Warm-up** | us → peer | `POST /api/sync/warm` asks the peer to eagerly warm its embedding model, bcrypt token cache, and MongoDB collection handles before the real work starts; local collections are warmed in parallel. Best-effort. |
| **Gossip** | us ↔ peer | Exchange member identity records (label, URL, children, signing keys) |
| **Vote propagation** | us ↔ peer | Pull the peer's rounds, push local vote casts, conclude rounds |
| **Pull** | peer → us | Fetch everything the peer has that we haven't seen yet |
| **Push** | us → peer | Upload everything we have that the peer hasn't seen yet |
| **File sync** | us ↔ peer | Exchange file tombstones, download files we lack, push files the peer lacks |
| **Merkle check** | us ↔ peer | Opt-in (`network.merkle: true`): compare per-space Merkle roots after sync and log a `MERKLE_DIVERGENCE` warning on mismatch |

Governance (gossip + vote propagation) runs **before** the data phases, deliberately: vote rounds are deadline-sensitive and their messages are small, so they must converge promptly and independently of the data plane. It used to run last, which meant any failure in the per-space data loop (a timed-out pull, a slow file transfer) skipped governance for the whole cycle — a saturated peer could starve vote propagation indefinitely.

Pull and push are gated by [watermarks](#watermarks) so only new or changed documents travel over the wire. File sync is manifest-based and equally incremental.

Which phases run for a given member depends on the `member.direction` field:

| Direction | Pull | Push | Used by |
|-----------|------|------|---------|
| `both`    | ✓    | ✓    | Closed, Democratic, Club (default) |
| `push`    | ✗    | ✓    | Braintree parent → child, Pub/Sub publisher → subscriber |
| `pull`    | ✓    | ✗    | Pub/Sub subscriber's record of its publisher; Braintree child's record of its parent |

For non-directional networks (`closed`, `democratic`, `club`), pull and push always run regardless of the direction field.

---

## Trigger

Sync can be triggered two ways:

- **Scheduled** — `syncSchedule` on the network config starts a node-cron task per network at startup. A standard cron expression only (e.g. `"*/5 * * * *"`, `"0 * * * *"`), refused with a `400` if the scheduler could not run it. The legacy shorthands `"*/N minutes|hours"` and `"every Nm|Nh"` were removed in 4.0: a stored one is rewritten to its cron form at boot, and sending one is refused with the expression it used to mean.
- **Manual** — `POST /api/notify/trigger { networkId }` starts the cycle and returns `{ status: 'triggered', networkId }` immediately. Results surface in the per-network sync history and logs. (The admin UI's `POST /api/networks/:id/sync` behaves the same way, returning `{ ok: true }`.)

  **`?wait=true` makes it synchronous instead**, answering `{ status: 'completed', networkId, synced, errors }` when the cycle finishes — bounded by `?timeoutMs` (default 30 000, clamped 1 000–120 000), which answers `504 { status: 'timeout', networkId, timeoutMs }` if the bound is reached. A cycle can run for minutes, so the default is still fire-and-forget; this paragraph used to say the response *"never waits on it"*, full stop, which left the one mode a caller reaches for when scripting a sync undocumented.

---

## Watermarks

Four high-water marks are kept per member. The first two prevent redundant data transfer; the last two are what make deletion records prunable.

| Field | Type | Meaning |
|-------|------|---------|
| `lastSeqReceived[spaceId]` | `Record<string,number>` | Highest seq we have ever pulled from this peer for this space |
| `lastSeqPushed[spaceId]` | `Record<string,number>` | Highest seq we have confirmed pushed to this peer for this space |
| `lastSeqServed[spaceId]` | `Record<string,number>` | Highest `sinceSeq` this peer has pulled **our** tombstones from — its confirmed position in our data ([details](#lastseqserved--the-mirror-watermark-and-why-tombstone-retention-needs-it)) |
| `lastFileTombstoneAckedAt[spaceId]` | `Record<string,string>` | Newest `deletedAt` among FILE tombstones this peer answered `200` to on a push ([details](#lastfiletombstoneackedat--the-same-bound-for-file-tombstones-from-acknowledgement)) |

All four are stored per member in the config file. After a successful sync they are written through the coalesced asynchronous config flush (`saveConfigSoon`) rather than a blocking synchronous write — sync bookkeeping never stalls the event loop. If a sync fails mid-way, the watermark is not advanced past the failure — the next cycle retries from the last safe point, giving at-least-once delivery semantics (re-delivery is harmless: everything is re-derived from `seq`).

**One watermark, seven transfers, and that is what "the last safe point" has to mean.** A cycle runs seven independent transfers under each watermark — tombstones plus facts, entities, edges, chrono, links and FILE METADATA — and any one of them can stop early: a non-`2xx` from the peer, or its page cap. **The watermark advances only as far as EVERY transfer in the cycle is complete through.** A transfer that finished places no limit; one that stopped early limits the advance to the last position it actually delivered, and the lowest such limit wins.

Before 3.2.0 both watermarks were set to the *maximum* across the transfers, which is only correct when all of them finished. A facts push that failed at seq 300, in a cycle where the entities push succeeded to seq 500, moved the watermark to 500 — and the fact at seq 400 was behind it permanently, re-sent by nothing, while every later cycle reported success. A held-back cycle now says so in the log, naming which transfers stopped, because a watermark quietly staying put reads exactly like a cycle with nothing to do.

---

## Space ID remapping (`spaceMap`)

When a brain joins a network, the remote peer's space IDs may collide with existing local spaces. The joining brain can resolve each collision by either **merging** into the existing space or **aliasing** to a new local name. Aliases are recorded as a `spaceMap` on the `NetworkConfig`:

```json
{
  "spaceMap": {
    "research": "research-acme"
  }
}
```

The sync engine uses two helpers to translate between remote and local space IDs:

| Helper | Input | Output | Used during |
|--------|-------|--------|-------------|
| `remoteToLocal(remoteSpaceId)` | Remote space ID | Local space ID (or identity if no mapping) | Pull — storing fetched documents in the correct local collection |
| `localToRemote(localSpaceId)` | Local space ID | Remote space ID (or identity if no mapping) | Push — querying the peer's API with the space ID it expects |

**Watermark keys use the LOCAL space ID.** The sync loop iterates `net.spaces` (local IDs) and keys all three watermarks by that value, while sending `remoteSpaceId` on the wire — so an aliased space stores its watermarks under the name this instance uses, not the peer's. That is also what makes them survive a local rename, which rewrites the keys by local ID (`applySpaceRenameToConfig`).

**API calls** (`GET /api/sync/facts?spaceId=...`) always use the **remote** space ID so the peer returns the correct data.

**Local storage** (collection names, file paths) uses the **local** space ID so documents land in the aliased collection.

Spaces without an entry in `spaceMap` pass through unchanged (identity mapping). The `spaceMap` is also updated automatically when a local space is renamed — `renameSpace()` adds or updates the reverse mapping on every network that references the old space ID.

---

## Pull phase

```http
GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq={lastSeqReceived}     (1 request)
GET /api/sync/facts?spaceId=&...&full=true&limit=200                     (ceil(N/200) requests)
GET /api/sync/entities?...                                                  (ceil(N/200) requests)
GET /api/sync/edges?...                                                     (ceil(N/200) requests)
GET /api/sync/chrono?...                                                    (ceil(N/200) requests)
GET /api/sync/links?...                                                     (ceil(N/200) requests)
GET /api/sync/filemeta?...                                                  (ceil(N/200) requests)
```

### Why `?full=true`

Without `?full=true` the list endpoints return `{_id, seq}` stubs, and the caller would need a second `GET /api/sync/facts/:id` request per document to fetch the full content — **N additional round-trips** per sync cycle. Each family has that per-document route: `GET /api/sync/entities/:id`, `GET /api/sync/edges/:id`, `GET /api/sync/chrono/:id`, `GET /api/sync/links/:id` and `GET /api/sync/filemeta/:id`.

With `?full=true` the full document payload is embedded in the paginated list response. The pull phase is `ceil(N/200)` requests regardless of how many documents exist.

Pagination is additionally capped at **50 pages per type per cycle** (~10,000 documents). A backlog larger than that is drained across successive cycles — the watermark advances each cycle, so nothing is lost, it just takes more than one cycle to catch up.

Hitting that cap counts as a transfer stopping early (see [watermarks](#watermarks)), so it limits how far the shared watermark may advance — to exactly what this type delivered. That is also why the rule is a *limit* rather than "do not advance at all": a capped type has more to give, and refusing to advance would make it re-fetch the same pages every cycle and never catch up.

**Impact at 100 ms WAN latency:**

| Documents changed | Before | After |
|---|---|---|
| 10,000 | ~10,001 requests, ~17 min | ~51 requests, ~5 s |
| 1,000  | ~1,001 requests, ~1.7 min | ~6 requests, ~600 ms |
| 100    | ~101 requests, ~10 s | ~1 request, ~100 ms |

### Tombstones pulled first

Tombstones are fetched before documents so that a deletion that arrived at the peer applies before the engine could accidentally re-insert the same document that was just deleted. After tombstones are applied, items appearing in the list with a `deletedAt` field are skipped (they're stubs that the tombstone phase already handled).

### Tombstone deletion authorisation

When `applyRemoteTombstone` processes an incoming tombstone it must satisfy **two** conditions before deleting the underlying document:

1. **Author match** — `tombstone.instanceId` (the issuer of the delete) must equal `localDoc.author.instanceId` (the instance that created the document). A tombstone can only delete a document authored by its own issuer.
2. **Issuer proof** — because `tombstone.instanceId` is attacker-controllable, matching it against the author is not enough on its own. The delete is authorised only when the tombstone was delivered by the issuer itself — the authenticated peer's identity (`peerInstanceId`, carried on production peer tokens; or `member.instanceId` on the pull path) equals the issuer — or the caller is a trusted local/admin token. A tombstone relayed by a third party on behalf of another author is **refused**; the authoring peer's own tombstone reaches each member first-hand on direct sync.

Together this prevents a member from forging a tombstone with `instanceId` set to a victim instance in order to delete the victim's content across the network. Documents without `author` metadata (legacy, pre-author-field data) are deleted unconditionally since authorship cannot be determined.

### Document ID collision safety

All document `_id` values (`facts`, `entities`, `edges`, `chrono`, `links`) are **UUIDv4** — 122 bits of cryptographic randomness from Node.js `uuid` v4. The probability of two independent instances generating the same `_id` is astronomically low (~2.7 × 10⁻²⁰ after 1 billion documents). In practice, a publisher's tombstone targeting `_id = X` will never match a subscriber-created document because the subscriber's documents will always have different UUIDv4 identifiers. The tombstone deletion-authorisation checks are a defence-in-depth layer on top of this structural guarantee.

### `lastSeqReceived` update

After all five document types (facts, entities, edges, chrono, links) are pulled, `lastSeqReceived[spaceId]` is advanced to the highest `seq` seen **among documents authored by the peer** (`doc.author.instanceId === member.instanceId`) and written to config. On the next cycle the watermark is passed as `sinceSeq` so the peer returns only documents newer than that point.

Docs that originate from a third instance but were relayed through the peer (e.g. during braintree or pubsub fanout) deliberately do not advance the watermark. Those relayed docs may carry a `seq` assigned by their true author's counter, which can be much higher than the peer's own counter. Allowing them to advance `lastSeqReceived` would cause the engine to skip the peer's locally-written documents on the next pull.

### `lastSeqServed` — the mirror watermark, and why tombstone retention needs it

`lastSeqReceived` and `lastSeqPushed` are **our** position in a peer's data. `lastSeqServed[spaceId]` is the opposite: the highest `sinceSeq` that peer has pulled **our** tombstones from, i.e. the position it has confirmed applying. It is recorded on the serving side by `GET /api/sync/tombstones`, keyed by the authenticated peer, after the read.

It exists because tombstone retention cannot be time-based. Tombstones are served by `seq > sinceSeq`, so a peer that was offline longer than any expiry window comes back, never sees the deletion, and pushes its live copy — the deleted record returns. A floor built from `min(lastSeqServed)` across every member of every network carrying the space has no such hole: below it, every peer has already applied the deletion.

The prune (`brain/tombstone-prune.ts`, every 6 h) therefore deletes tombstones with `seq <= min(lastSeqServed)`, and treats every unknown as a reason to keep:

| situation | outcome |
|---|---|
| a member has no `lastSeqServed` for the space | **no prune** — including every member until it pulls once after upgrading |
| the minimum is 0 | **no prune** |
| a `peerInstanceId` token is scoped to the space but has no member entry | **no prune** — it can pull and has nowhere to record a position |
| no network carries the space **and** no peer token reaches it | prune everything — the single-instance case |
| `member.direction === 'push'` | still counted; direction governs our outbound behaviour, not what a peer may `GET` |

### `lastFileTombstoneAckedAt` — the same bound for file tombstones, from acknowledgement

File tombstones carry no `seq` (they are keyed by `deletedAt`) and their pull is unfiltered, so there is no served position to record. Their floor comes from the **push** instead: `POST /api/sync/file-tombstones` upserts every tombstone it receives and re-propagates it onward, so a **200** proves that peer now holds it and will keep passing it on — which makes dropping the local copy safe transitively.

`lastFileTombstoneAckedAt[spaceId]` is the newest `deletedAt` in a set the member answered 200 to, and the prune deletes file tombstones at or below `min()` of it across the space's members. Three rules make it safe:

- **The position comes from the array that was sent**, never from a fresh query — a file deleted between building the body and reading the reply was not in the payload.
- **Only a 200 counts.** A 403 (direction-blocked peer) or a timeout leaves the position unknown, which blocks pruning.
- **`applied` is not a count of what CHANGED, and `applied: 0` is not proof of receipt.** The receiver increments it for every element that passes a shape check (`_id` present, `path` a string) and a path-traversal guard, whether or not the upsert inserted anything — so an already-held tombstone still counts. What it does NOT count is an element it rejected, and it rejects them **silently**. So `applied` short of the number you sent means that many were thrown away, and `applied: 0` on a non-empty push means **every** element was. This paragraph used to say the opposite — that zero was the legitimate answer from a peer that already had them — and then told you to prune on it.
- **Timestamps are compared only in the fixed-width `…Z` form**, which sorts lexically. An offset form (`+02:00`) sorts later while being earlier in real time, so anything else is treated as unknown rather than compared.

**The file-tombstone pull is deliberately NOT filtered by `since`.** A file tombstone carries its original `deletedAt` and can reach a peer long after that timestamp — a third instance's old deletion relayed onward, or a peer back from a week offline. `deletedAt > since` would skip exactly those, and the file they should delete would stay. The payload concern such a filter would address is answered by the prune instead: once every peer's copy is bounded, the full set is small.

This matters more than the record half: `FileTombstoneDoc.path` is often personal in itself, so an unbounded collection means a deleted file's **name** is retained indefinitely.

---

## Push phase

```http
POST /api/sync/tombstones?spaceId=&networkId=                               (paged: 500/request, looped until drained)
POST /api/sync/batch-upsert?spaceId=&networkId=                             (ceil(changed/200) requests)
```

Tombstone push is deliberately **unbounded** (it loops in pages of 500 until every pending tombstone is delivered) so a peer that was offline for a long time never misses deletions.

### Incremental push via `lastSeqPushed`

The engine queries only documents with `seq > lastSeqPushed[spaceId]`. If nothing has changed since the last cycle, no HTTP requests are made for that type.

If the peer has never been synced (`lastSeqPushed` = 0), the full history is sent — but still in batches, not one request per document.

### `POST /batch-upsert`

Accepts `{ facts?: MemoryDoc[], entities?: EntityDoc[], edges?: EdgeDoc[], chrono?: ChronoEntry[], links?: LinkDoc[], filemeta?: FileMetaDoc[] }` in a single request. **An array the receiver does not read is dropped with a `200`**, so a peer built without `filemeta` loses every file description, tag and link array at the boundary — and nothing says so at either end. Up to 500 documents per type per request. The server applies the same conflict rules as the individual `POST /facts`, `POST /entities`, `POST /edges`, `POST /chrono` endpoints:

| Type | Rule |
|------|------|
| Facts | `incoming.seq > existing.seq` → overwrite; equal seq + different fact → **fork** (new `_id`); else skip |
| Entities | `incoming.seq > existing.seq` → overwrite (upsert); else skip |
| Edges | same as entities |
| Chrono | same as entities |

Response: `{ status: 'ok', facts: {inserted,updated,forked,skipped,forkDepthRefused,tombstoned,schemaViolations}, entities: {upserted,skipped,tombstoned,schemaViolations}, edges: {upserted,skipped,tombstoned,schemaViolations,duplicateTriplets}, chrono: {upserted,skipped,tombstoned,schemaViolations,unknownType}, links: {upserted,skipped,tombstoned} }`

**Four of those counters were undocumented, and one of them is the sender's only report of a PERMANENT loss.** `skipped` means the peer was already current, which is benign. `forkDepthRefused` means a record was DROPPED and will not be retried — the push path reads exactly that field to report a refusal, so a receiver that does not emit it makes the loss silent at both ends. `schemaViolations` counts documents stored despite failing the RECEIVER's schema (validated, counted and let in — see the ingest rule below); `duplicateTriplets` counts edges the unique index rejected; `unknownType` counts the case below.

**`filemeta` reports its counters like every other family.** Six arrays in, six sets of counters out. Until 4.0 the response carried five: file metadata was accepted, applied, counted internally and only logged, so a sender had no way to tell whether it landed.

**A link has no fork counter, and that is a property of the record rather than an omission.** A fork exists
because two peers can write different CONTENT under one id at one `seq`. A link record is two endpoints and
their kinds — no label, no text, no properties — so two peers that both noticed the same connection wrote the
same fact, and the higher `seq` simply wins. The links collection carries a unique index on
`(from, fromKind, to, toKind)`, so the second write is a duplicate rather than a conflict.

### `lastSeqPushed` update

After a successful batch push, `lastSeqPushed[spaceId]` is advanced to the highest `seq` **among documents authored by this instance** (`doc.author.instanceId === cfg.instanceId`), and never past the point every transfer in the cycle is complete through (see [watermarks](#watermarks)). The maximum is tracked per acknowledged batch and persisted once after all four collections have pushed, so a drop mid-push leaves the watermark at the last position the peer actually accepted. The next cycle re-pushes from there and the upserts are idempotent.

**The limit is the last ACCEPTED seq, not the author-guarded maximum**, and the two answer different questions: the author guard says how far this instance's own records reached, while the accepted position says how far the transfer got at all. On a `pubsub` or `braintree` network the push filter is empty — this instance relays every document it holds — so limiting by the author-guarded number would let the watermark advance past a relayed document the peer never accepted, and nothing else was going to send it.

Relayed docs (received from a third peer and stored locally) are pushed to other members but do **not** advance `lastSeqPushed`. Their seq values belong to the originating instance's counter and could be arbitrarily higher than the local counter, which would incorrectly suppress future pushes of this instance's own work.

**Non-directional push filter**: for `closed`, `democratic`, and `club` networks, only documents authored by this instance are queried for push (`{ seq: { $gt: lastSeqPushed }, 'author.instanceId': cfg.instanceId }`). This prevents echoing a peer's own documents back to them. For `braintree` and `pubsub` networks no author filter is applied — relay of third-party docs through the tree (or star) is the intended topology.

---

## Conflict resolution

### Facts — fork on equal sequence

Facts are the primary content type. If two brains independently edit the same document (same `_id`) and their changes produce the same `seq` counter:

```text
Brain A:  { _id: "abc", seq: 5, fact: "The sky is blue" }
Brain B:  { _id: "abc", seq: 5, fact: "The sky is cerulean" }   ← concurrent edit
```

The receiving brain detects `incoming.seq === existing.seq && incoming.fact !== existing.fact` and creates a **fork**: a new fact with a fresh UUID, `forkOf: "abc"`, and the next available `seq`. Both versions coexist and can be reviewed by the user.

### Entities and edges — last-writer-wins

Entities and edges are structural metadata (names, relationships). They use a simpler `seq`-wins rule: the document with the higher `seq` survives. Equal seq is treated as a no-op (already in sync).

---

## Timeouts

| Constant | Value | Applied to |
|----------|-------|------------|
| `FETCH_TIMEOUT_MS` | 10 s | Tombstone requests, individual per-doc requests (legacy), manifest requests |
| *(whole-file transfer budget)* | 10 min | File UPLOADS to a peer. A source constant with no environment variable — naming it here would invite you to set something that is not settable |
| `BATCH_FETCH_TIMEOUT_MS` | 60 s | `GET /facts?full=true`, `GET /entities?full=true`, `GET /edges?full=true`, `POST /batch-upsert` |

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

In a braintree, a child stores its **parent** with `direction='pull'` (the child pulls its parent's data downward), and a parent stores each **child** with `direction='push'` (the parent pushes down to that child). Both records describe the *same* downward flow, root → leaves — so a leaf never pushes up to its parent, and data does not travel upward. (This is set in `join.ts`: an applying child records the inviting parent as `pull`; a parent records an accepted child as `push`.)

---

## Direction enforcement on inbound endpoints

The direction field controls not only which phases the sync *engine* runs on the initiating side, but also which writes the *receiving server* accepts.

**The data-write surface is peer-only.** A POST to any write endpoint (`/api/sync/facts`, `/entities`, `/edges`, `/chrono`, `/batch-upsert`, `/tombstones`, `/file-tombstones`) — link records arrive through `/batch-upsert` and have no single-record write door — must be presented with a **peer token** (a PAT carrying `peerInstanceId` — issued by the invite handshake, or minted explicitly via `POST /api/tokens { peerInstanceId }` for manually-configured topologies) or an **admin token** (the local operator, who could write through the regular REST API anyway). A space-scoped user PAT is refused with `403 { error: 'Sync writes require a peer token (peerInstanceId) or an admin token — use the regular REST API for user writes' }`. Unlike the REST API, which assigns `seq`/`_id`/`author` server-side, sync writes carry raw stream metadata — accepting user PATs here would let anyone holding one forge sync state, e.g. a downstream operator pushing content upstream in a directional network.

For an identified peer, the server then derives the direction check from **its own membership records covering the target space** — never from the caller-supplied `networkId` query parameter. The write is allowed only when at least one of the caller's network relationships carrying that space permits inbound flow (`direction` pull/both, or a non-directional network type). If every relationship covering the space is `push` — "we push to them, they should not write to us" — the server responds `403 { error: 'Directional network: write not permitted from this peer' }`. A peer that is a member of no local network carrying the space (asymmetric/single-side topologies, a braintree child receiving from its unlisted parent) is governed by token space scope and the pending-join hold instead.

This is the server-side complement to the engine's client-side skip logic. Together they guarantee:

| Scenario | Engine (client) | Server (receiver) |
|----------|----------------|-------------------|
| Braintree parent → child | Parent pushes, child does not push back | Child rejects POST from parent's subtree peers |
| Pub/Sub publisher → subscriber | Publisher pushes, subscriber does not push | Publisher rejects POST from subscribers |

Bidirectional network types (`closed`, `democratic`, `club`) always have `direction='both'` on all members, so the directional guard never fires — but the peer-only write gate still applies.

---

## File sync

After document sync, the engine performs a manifest-based file sync. It is bidirectional and tombstone-aware:

1. **File tombstones, both directions** — the engine pulls the peer's file tombstones (`GET /api/sync/file-tombstones`) and applies them (subject to the same [deletion authorisation](#tombstone-deletion-authorisation) rules as document tombstones), then pushes its own pending file tombstones (`POST /api/sync/file-tombstones`).
2. **Manifest** — `GET /api/sync/manifest?spaceId=&networkId=` retrieves the peer's list of `{ path, sha256, size, modifiedAt }`. Manifests are served from a per-space file-hash cache (`<spaceId>_file_hashes`), so the peer does not re-hash its whole tree per request.
3. **Download** — files we lack entirely are downloaded via `GET /api/files/:spaceId?path=<relative path>` (the path travels as a query parameter). Downloaded bytes are SHA-256 verified before writing to disk; a mismatch is logged and the file discarded.
4. **Divergence → conflict, never overwrite** — when a file exists on both sides with different hashes, the engine does **not** overwrite the local copy. It writes the peer's version as a conflict copy alongside and records a `ConflictDoc`, surfaced in **Workspace → Conflicts** for the user to resolve.
5. **Push** — files the peer lacks (or holds an older `modifiedAt` for) are uploaded to it.

Manifest requests use the 10 s timeout and batch-style transfers the 60 s one. A whole file body gets the ten-minute transfer budget, because a 10 s ceiling on a multi-megabyte upload aborts it on any ordinary link.

**A download gets it too, and until 4.0 it did not.** The call passed the transfer budget alongside a request that already carried the 10 s control-plane signal, and `init.signal ?? …` means the signal won — so any file whose body took longer than ten seconds aborted, logged, and was retried identically on every cycle, for ever. Large files simply never replicated. The control-plane signal is stripped before the transfer call now, so one budget reaches the fetch.

---

## Merkle divergence check (opt-in)

With `merkle: true` on the network config, the engine ends each per-space sync by comparing content roots with the peer: it computes the local Merkle root and fetches the peer's via `GET /api/sync/merkle?spaceId=&networkId=`.

**The algorithm, because a root cannot be reproduced from a prose summary.** Each brain document contributes a leaf `SHA-256("doc:<collection>:<_id>:<seq>:<sha256(canonical JSON)>")` over **all six** collections — facts, entities, edges, chrono, links and files — and each file manifest entry contributes `SHA-256("file:<path>:<sha256>")`. Leaves are sorted lexicographically; an odd level duplicates its last node; an empty tree is `SHA-256("")`. File CHUNK records are excluded by a `parentFileId: {$exists: false}` filter, so a chunked file contributes its parent only.

**What is left out of a document's hash is five fields, not "embeddings"** — `embedding`, `embeddingModel`, `matchedText`, `_expireAt` and `_contentExpireAt`. The first three are derived by the local embedding model and the last two by the local retention policy, so none of them can travel: peers running different models hold different vectors for identical content, and a retention stamp would let one instance decide when another deletes its data.

**And `files` runs the opposite way round.** The five other collections EXCLUDE those fields from an otherwise-complete document; a file record has thirty-odd fields, most of them local machinery, so it is hashed from an INCLUSION list of its sixteen authored keys instead. A field added to a file record is therefore outside the hash until it is added to that list — the reverse of the rule for every other collection, and the direction that fails silently. Matching roots log `Merkle OK`; a mismatch logs a loud `MERKLE_DIVERGENCE` warning naming the space, peer, and both roots with leaf counts — the space contents differ *after* sync, indicating possible data loss, a concurrent write, or a sync bug. This is **detection only**: nothing is auto-repaired, and any failure in the check itself (peer error, missing field) degrades to a warning without affecting the sync result.

---

## Gossip phase

At the **start** of each cycle — before any data sync, see [Overview](#overview) for why — the engine performs a lightweight member identity exchange with each peer:

1. **Self-announce** — `POST /api/sync/networks/:networkId/members` with `{ instanceId, label, children?, url?, signingPublicKey?, signingKeyRotation? }`. The `url` field is included only when the `INSTANCE_URL` environment variable is set; if omitted, the peer keeps the URL it already has on record. The signing fields distribute the instance's vote-signing public key (see [Signed vote casts](#signed-vote-casts)).

2. **Self-record piggyback** — the receiving peer includes its own current identity in the `200` response as `{ status: 'ok', self: { instanceId, label, url?, signingPublicKey?, signingKeyRotation? } }`. The caller updates its local member entry for that peer from this payload — no separate GET is needed.

3. **Pull member view** — `GET /api/sync/networks/:networkId/members` fetches the peer's full member list. Any record whose `instanceId` is already known locally (but is not our own `instanceId`) has its `url`, `label`, and `children` merged in if they differ.

### Gossip poisoning protection

On the receiving side, the `POST /api/sync/networks/:networkId/members` endpoint only updates the record for the exact `instanceId` in the request body. It will not update any other member's record — so a compromise peer cannot overwrite other members' identity details. Unknown `instanceId` values (not already in the member list) are silently acknowledged as `{ status: 'unknown_member' }` and never auto-added.

On the pulling side, records returned by `GET /members` that share our own `instanceId` are never applied.

---

## API reference

All endpoints are under `/api/sync` and require a `Bearer` token. In normal operation that is a **peer token** — a PAT carrying `peerInstanceId`, issued to the peer during join. Read endpoints additionally accept admin and appropriately space-scoped user PATs, and admin tokens act as trusted local relays for tombstones.

The two **governance relays** — `POST /networks/:networkId/members` and `POST /networks/:networkId/votes/:roundId` — accept **a peer token speaking for its own instance, or an instance administrator relaying on a peer's behalf**, and refuse anything else with `403`. The authorisation runs before the network and round are looked up, so an unauthorised caller cannot learn which rounds are open from the status code.

> This paragraph used to say token space-scope and network membership were *"enforced before any read or write"*. That was not true of the two governance relays, which carried authentication only: any write-capable token could rewrite a member record, or cast a vote attributed to any instance on any round — including a `space_wipe`. Fixed 2026-09-04. The seven **data-write endpoints accept only peer or admin tokens** — see [Direction enforcement on inbound endpoints](#direction-enforcement-on-inbound-endpoints). Rate-limited per IP.

### Read endpoints (called during pull)

| Method | Path | Key params | Returns |
|--------|------|------------|---------|
| `GET` | `/api/sync/facts` | `spaceId`, `networkId`, `sinceSeq`, `limit`, `cursor`, `full` | `{ items[], nextCursor }` |
| `GET` | `/api/sync/facts/:id` | `spaceId`, `networkId` | Full `MemoryDoc` |
| `GET` | `/api/sync/entities` | same as facts | `{ items[], nextCursor }` |
| `GET` | `/api/sync/entities/:id` | `spaceId`, `networkId` | Full `EntityDoc` |
| `GET` | `/api/sync/edges` | same as facts | `{ items[], nextCursor }` |
| `GET` | `/api/sync/edges/:id` | `spaceId`, `networkId` | Full `EdgeDoc` |
| `GET` | `/api/sync/chrono` | same as facts | `{ items[], nextCursor }` |
| `GET` | `/api/sync/chrono/:id` | `spaceId`, `networkId` | Full `ChronoEntry` |
| `GET` | `/api/sync/links` | same as facts | `{ items[], nextCursor }` |
| `GET` | `/api/sync/links/:id` | `spaceId`, `networkId` | Full `LinkDoc` |
| `GET` | `/api/sync/filemeta` | same as facts | `{ items[], nextCursor }` |
| `GET` | `/api/sync/filemeta/:id` | `spaceId`, `networkId` | Full `FileMetaDoc` |
| `GET` | `/api/sync/tombstones` | `spaceId`, `networkId`, `sinceSeq`, `limit` (default 1000, max 5000) | `{ facts[], entities[], edges[], chrono[], links[] }` |
| `GET` | `/api/sync/file-tombstones` | `spaceId`, `networkId`, `since` | `{ tombstones[] }` |
| `GET` | `/api/sync/manifest` | `spaceId`, `networkId`, `since` | `{ manifest[{ path, sha256, size, modifiedAt }] }` |
| `GET` | `/api/sync/merkle` | `spaceId`, `networkId` | `{ spaceId, root, leafCount, computedAt, networkId }` (only used when `network.merkle: true`) |
| `GET` | `/api/sync/networks/:networkId/members` | `networkId` | `{ members[{ instanceId, label, url, direction, … }], updatedAt }` |

There is no dedicated identity endpoint — a peer that needs the instance's identity calls the regular authenticated `GET /api/about` (`{ instanceId, instanceLabel, version, … }`), and identity also arrives on every cycle via the gossip `self` record.

`?full=true` on the list endpoints returns complete documents instead of `{_id,seq}` stubs. Maximum `limit` is 500. Tombstone stubs (items with `deletedAt`) are always appended to list responses regardless of `full` mode.

**`links` and `filemeta` had no rows in this table until 2026-09-04, and `tombstones` was missing its `links[]` key.** Both are consequences of one thing: file metadata became the sixth replicated family and links the fifth, and the places that enumerate the families were not derived from anything. A peer built from the old table serves neither, drops both on the way in, and never propagates a link deletion — and because `merkle` hashes all six collections, its root then diverges permanently on data that is not actually different. The advisory nature of that check is what makes it worse: nothing contradicts the warning, so an operator learns to ignore the one signal that means data really is missing.

### Write endpoints (called during push)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/api/sync/facts` | `MemoryDoc` | `200 { status: 'inserted'\|'updated'\|'forked'\|'skipped'\|'tombstoned' }` — the `'forked'` case also returns `forkId` (the new fork document's `_id`) |
| `POST` | `/api/sync/entities` | `EntityDoc` | `200 { status:'ok' }` (or `'tombstoned'`) |
| `POST` | `/api/sync/edges` | `EdgeDoc` | `200 { status:'ok' }`, `'tombstoned'`, or **`'duplicate'`** when the unique `(from, fromKind, to, toKind)` index rejects the insert |
| `POST` | `/api/sync/chrono` | `ChronoEntry` | `200 { status:'ok' }` (or `'tombstoned'`) |
| `POST` | `/api/sync/batch-upsert` | `{ facts?, entities?, edges?, chrono?, links?, filemeta? }` | `200 { status:'ok', facts:{…}, entities:{…}, edges:{…}, chrono:{…}, links:{…} }` — six arrays in, five sets of counters out |
| `POST` | `/api/sync/tombstones` | `{ tombstones[] }` | `200 { applied: N }` |
| `POST` | `/api/sync/file-tombstones` | **`{ spaceId, tombstones[] }`** — `spaceId` in the BODY, not the query; absent it answers `400 { error: 'spaceId required' }` | `200 { applied: N }` |
| `POST` | `/api/sync/warm` | `{ networkId, spaces[] }` | `200` once the embedding model, token cache and collection handles are warm. It touches `facts`, `entities`, `edges` and `chrono` only, and results are discarded |

**Direction is enforced on `braintree` and `pubsub` networks only**, and this paragraph used to state it of every write endpoint on every network. A peer whose `member.direction === 'push'` — we push to them, so they should not be writing to us — is refused with a `403` on those two types. On any other type carrying the space the write is allowed, which is deliberate: direction is a topology property of a tree and a publisher, and a `closed` or `club` network has no upstream to protect. See [Direction enforcement on inbound endpoints](#direction-enforcement-on-inbound-endpoints).

**And two of these endpoints enforce less than the sentence above implied.** `POST /api/sync/warm` sits behind authentication and nothing else — no peer gate, no direction, no space scope — which costs nothing because it discards its results, but it is not what "all write endpoints" said. Direction is also read from the CALLER's peer identity, so a token with no `peerInstanceId` is not direction-checked at all; the peer-or-admin requirement is what stands in front of that.

**There is no single-document route for `links` or `filemeta`.** Both arrive only through `batch-upsert`, so a peer implementation that only wires the per-type `POST` endpoints replicates neither.

`POST /batch-upsert` is the primary push path used by the engine. The individual `POST /facts`, `/entities`, `/edges` endpoints remain for backwards compatibility and direct API usage.

All incoming documents are validated against Zod schemas before any database write. Invalid documents are rejected with `400` (single endpoints) or silently filtered out (batch-upsert). Key constraints: `tags` max 100 items, `entityIds` max 500, all string fields validated for type safety. Unknown fields are stripped.

Two additional ingest safety caps protect the local seq counter and fork chains from a malicious or corrupted peer:

- **Implausible seq** — the schema bound on `seq` is 2^50, but ingest applies a stricter ceiling of `2^50 − 2^40` (`rejectImplausibleSeq`); a document above it is refused so a poisoned seq can never exhaust the counter's headroom.
- **Fork limits** — fork chain depth is capped at 10 on both paths: exceeding it returns `400` on the single `POST /facts` endpoint and is silently skipped in `batch-upsert`. The additional per-document **fan-out** cap (no more than 10 forks pointing at the same parent) is enforced **only on the single endpoint** — `batch-upsert` checks chain depth alone, not sibling fan-out.

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
| `POST` | `/api/sync/networks/:networkId/votes/:roundId` | `{ vote: 'yes'\|'veto', instanceId, sig?, castAt? }` | `200 { status:'ok' }` \| `403` \| `404` |

Sensitive fields (`inviteKeyHash`, `pendingMember.tokenHash`) are stripped from `GET` responses before sending to peers.

### Signed vote casts

Each brain holds a persistent **Ed25519 keypair** (private key in `secrets.json` as `signingPrivateKey`, public key in `config.json` as `signingPublicKey`, generated at setup / first boot). When an instance casts its own vote it signs the canonical message `ythril-vote:v1|<networkId>|<roundId>|<subjectInstanceId>|<voterInstanceId>|<vote>`; the base64 signature travels with the cast as `VoteCast.sig`.

Public keys are distributed and **pinned trust-on-first-use** via the member-gossip `self` record (`NetworkMember.signingPublicKey`). A later attempt to change a member's pinned key is refused **unless** it is accompanied by a valid **rotation proof** — a signature by the currently-pinned (old) key over `ythril-keyrot:v1|<instanceId>|<newPublicKeyPem>`. An instance rotates its keypair with `POST /api/admin/rotate-signing-key`, which generates the new key and the proof and advertises both on the `self` record (`signingKeyRotation`); peers then re-pin automatically. When the old private key is lost (no proof possible), an admin force-pins the new key via `PUT /api/networks/:id/members/:instanceId/signing-key` (break-glass). A rotation proof only re-pins peers that hold the immediately-preceding key; peers that missed an intermediate rotation recover via the force-pin endpoint.

A receiver accepts a cast when:

- its signature verifies against the voter's pinned key — accepted from **any** reporting peer, which is what makes multi-hop vote relay (deep braintree trees) safe; or
- the network is not in strict mode (`requireSignedVotes` unset) **and** the cast is reported directly by its own voter (the unsigned-compatibility path — a peer may never relay an unsigned cast on another member's behalf).

With `requireSignedVotes: true` on the network, only signed-and-verified casts are accepted. Enable it once every member has published a key.

---

## A chrono type the RECEIVER does not know is dropped

A space may declare its own chrono vocabulary in `meta.typeSchemas.chrono`. When it declares any, that set
is the whole permitted list — and it is the RECEIVER's list that applies, which follows from the ingest
rule above: a peer validated the record against its own schema, and this instance validates against its.

**The two doors answer differently, and the batch one is the quiet half.** A single
`POST /api/sync/chrono` refuses an unknown type with a `400`. In `batch-upsert` the entry is SKIPPED,
counted as `unknownType`, and the response is `200` — so a sender advances `lastSeqPushed` past a record
the receiver never stored, and nothing re-sends it.

So two instances that both declare chrono vocabularies, and do not declare the same one, silently do not
replicate the entries whose types differ. Read `chrono.unknownType` on the batch response: it is the only
signal, and it is the reason that counter is in the documented response shape above.

---

## Vote propagation phase

Directly after the gossip (member identity) exchange — still ahead of the data phases — the engine runs a vote propagation pass with each peer:

**Pull before push, and the order is load-bearing.** Adopting the peer's rounds first means a cast this
instance is about to relay has a round to land on. This list used to run the other way round, which is the
silently-skipped `404` in step 2: a cast pushed for a round the peer has not yet adopted.

1. **Pull rounds** — `GET /api/sync/networks/:networkId/votes` fetches the peer's open rounds. For each round:
   - **New round**: if the round does not exist locally, it is adopted into `pendingRounds` (with an empty `votes` array); votes are then merged in the same pass.
   - **Vote merge**: each cast from the peer's round is accepted only if it passes the signature/own-cast check above (a forged cast attributed to another member is dropped). The cast — including its signature — is stored verbatim so it can be relayed onward unchanged. If the same voter's cast changes (e.g., `yes` → `veto`), the local cast is replaced.

2. **Push casts** — for each local vote round — including already-concluded ones, so that a round-concluding cast still reaches peers that have not concluded yet — each known vote cast is relayed to the peer via `POST /api/sync/networks/:networkId/votes/:roundId { vote, instanceId, sig, castAt }`, forwarding the voter's signature so the peer can verify and relay it onward. If the peer does not yet have the round (404), the push is silently skipped — the round will arrive on the peer's next pull cycle.
3. **Round conclusion** — after all merges, `concludeRoundIfReady` is evaluated for every open local round. Unanimous-type networks (closed, braintree) require every listed remote member to have individually cast `yes`; a single outstanding member prevents conclusion. For **braintree** rounds the required-voter set (ancestor path) is recomputed from the local topology at conclusion, never trusted from the adopted round, so a peer cannot shrink it. Democratic networks use a simple majority count. Club networks conclude on the first `yes`.

4. **Side effects** — if a `space_deletion` round concludes with zero vetoes, the space is removed from the local instance asynchronously. A `space_wipe` round behaves the same way but EMPTIES the space instead of removing it, wiping exactly the collections named on the round (**all six** when it names none — facts, entities, edges, chrono, files and links; this said five, and `links` was the one it left out). Both are applied through one function called from all three conclusion paths — an operator's own vote, a peer's vote arriving, and the gossip pass.

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

- `sendMemberRemovedNotify(subjectUrl, subjectInstanceId, networkId)` lives in `sync/governance.ts`
  alongside `concludeRoundIfReady`, and is called from four places, all after `concludeRoundIfReady`
  returns true for a `remove` round: the peer vote-relay handler (`api/sync/votes.ts`), the admin
  vote handler (`api/networks/votes.ts`), the member-removal handler (`api/networks/members.ts`),
  and the gossip engine (`sync/engine.ts`).
- The ejected instance receives `POST /api/notify { networkId, instanceId, event: "member_removed" }`.

On the **receiving** end of a `member_removed` event:

1. `networkId` is added to `cfg.ejectedFromNetworks` (deduplicated).
2. The network entry is removed from `cfg.networks`.
3. Config is saved.

Subsequently, any sync request scoped to an ejected network ID returns `401 { "error": "ejected" }` via early-exit middleware — both the gossip endpoints (`/api/sync/networks/:networkId/*`, network ID in the path) and the data endpoints (`/api/sync/facts`, `/entities`, `/edges`, `/chrono`, `/batch-upsert`, `/manifest`, `/files`, tombstones, merkle — network ID in the query string or body). Without the data-endpoint guard, ex-peers could keep syncing after an ejection because the network config is deleted locally and the space-scope check falls back to "space exists".

> **Peer credential lifecycle**: when a member is removed (direct club/pubsub removal, a concluded
> remove vote, a `member_departed` announcement, or deleting a network) — and, on the ejected side,
> when `member_removed` is processed — the instance revokes the departed peer's credentials: any PAT
> bound to it via `peerInstanceId` and the outbound token in `secrets.peerTokens`. Revocation only
> happens once the peer no longer shares **any** network with this instance; membership in another
> common network (or a pending join round) preserves the credentials
> (`revokePeerCredentialsIfOrphaned` in `auth/tokens.ts`).

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

Governance (gossip + vote propagation) runs **before** the data phases, deliberately: vote rounds are deadline-sensitive and their messages are small, so they must converge promptly and independently of the data plane. A failure in the per-space data loop (a timed-out pull, a slow file transfer) never skips governance for the cycle.

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

- **Scheduled** — `syncSchedule` on the network config starts a node-cron task per network at startup. A standard cron expression only (e.g. `"*/5 * * * *"`, `"0 * * * *"`), refused with a `400` if the scheduler could not run it. The shorthands `"*/N minutes|hours"` and `"every Nm|Nh"` are not accepted: a stored one is rewritten to its cron form at boot, and sending one is refused with the cron expression it corresponds to.
- **Manual** — `POST /api/networks/:id/sync` starts the cycle and returns `{ ok: true, status: 'triggered', networkId }` immediately; `POST /api/networks/peers/:peerId/sync` does the same for one peer across every network it belongs to. Add `?wait=true` to get the outcome instead of the acknowledgement. Results surface in the per-network sync history and logs. A client calling `/api/notify/trigger` must move to these routes; it was removed in 5.0.

  **`?wait=true` makes it synchronous instead**, answering `{ status: 'completed', networkId, synced, errors }` when the cycle finishes — bounded by `?timeoutMs` (default 30 000, clamped 1 000–120 000), which answers `504 { status: 'timeout', networkId, timeoutMs }` if the bound is reached. A cycle can run for minutes, so the default is fire-and-forget.

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

**One watermark, seven transfers, and that is what "the last safe point" has to mean.** A cycle runs seven independent transfers under each watermark — tombstones plus facts, entities, edges, chrono, links and FILE METADATA — and any one of them can stop early: a non-`2xx` from the peer, a throw, or its page cap — and for the tombstone transfer also a page of one seq it cannot page past, or an element of a type the receiver does not know. **The watermark advances only as far as EVERY transfer in the cycle is complete through.** A transfer that finished places no limit; one that stopped early limits the advance to the last position it actually delivered, and the lowest such limit wins.

The watermark is never the *maximum* across the transfers: a facts push that failed at seq 300, in a cycle where the entities push succeeded to seq 500, leaves it no further than the facts push delivered, so the fact at seq 400 is re-sent next cycle. A held-back cycle says so in the log, naming which transfers stopped, because a watermark quietly staying put reads exactly like a cycle with nothing to do.

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

**Inbound requests are translated too.** A peer names the space by the network's id, so every `/api/sync/*` request that carries a `networkId` has its `spaceId` translated through that network's `spaceMap` before any route admits, reads or writes by it. It only renames: the translated id is admitted by the same rule as the local one.

Spaces without an entry in `spaceMap` pass through unchanged (identity mapping).

**Every id a space crosses the wire under is its NETWORK id.** That includes the invite answers: an inviter's `spaces` names its own local ids, and the answer carries `networkSpaces`, index-aligned with `spaces`, naming each one's network id. A joiner that stored the local id instead would hold one space under two names the first time the inviter's local name differed from the network's — which is what a rename produces. A joiner trusts `networkSpaces` only when it is a list of valid space ids, as long as `spaces`, with no duplicates; otherwise it falls back to `spaces`, which is what a pre-fix inviter sends.

**A local space may be reached by several keys.** When a space that is already mapped is renamed, its network id stays the FIRST key and the old local id is appended as an inbound alias, because a member that joined under that name still asks for it. `localToRemote` answers the first key; `remoteToLocal` accepts any of them. Renaming a space back to its network id deletes the mapping rather than aliasing the id onto itself. Every write to `spaceMap` goes through `sync/space-map.ts`, which refuses an alias that would overwrite another space's key, alias a space to itself, or give one local space a second network id.

**A duplicate left by the old behaviour heals from upstream only.** When a member reports an announced space its receiver holds under another local name (by `spaceNames` in the self-record), the receiver records the alias — but only from the member it syncs FROM (the publisher on a pub/sub network, the parent on a braintree), only for a space it has not dismissed, and it writes a `network.space_alias.heal` audit entry. A downstream member can never rename a space for its upstream.

**Vote rounds carry both ids.** A space round keeps `spaceId` (the proposer's local id, which a 5.0/5.1 peer applies directly) and gains `networkSpaceId`; a receiver resolves the round through `networkSpaceId` when present and falls back to `spaceId` only when it is absent.

---

## Pull phase

```http
GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq={cursor}&limit=5000  (paged, tie-safe — see below)
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

| Documents changed | Per-document fetch | `?full=true` |
|---|---|---|
| 10,000 | ~10,001 requests, ~17 min | ~51 requests, ~5 s |
| 1,000  | ~1,001 requests, ~1.7 min | ~6 requests, ~600 ms |
| 100    | ~101 requests, ~10 s | ~1 request, ~100 ms |

### Tombstones pulled first

Tombstones are fetched before documents so that a deletion that arrived at the peer applies before the engine could accidentally re-insert the same document that was just deleted. After tombstones are applied, items appearing in the list with a `deletedAt` field are skipped (they're stubs that the tombstone phase already handled — the riders are served but ignored).

**The tombstone pull is paged, and it delivers everything up to the horizon or says where it stopped.** One `sinceSeq` — the member's one `lastSeqReceived` — covers tombstones and records alike. Each request asks for `limit=5000` per type from a cursor. A type that comes back full may hold more at its last seq, so the next cursor is the lowest last seq among the full types **minus one**: that seq is served again, whole, and what was already applied is skipped by `(type, _id)`. Equal seqs are legitimate — a peer relays tombstones from several issuers, each with its own clock — and this is what keeps a run of them across a page boundary from being lost. The cursor moves only over elements the receiver admitted, so a refused element at the top of a page cannot page past the real deletions after it. A full type that is all one seq cannot be paged past; the transfer then stops, warns naming the space, the peer and the seq, and holds the watermark below it. So does the 200-request bound per cycle; the next cycle resumes. The cost, accepted: the types that were not full are served again from the new cursor. A peer older than this one serves at most `limit` per type and is paged the same way.

### Tombstone deletion authorisation

Both doors — `POST /api/sync/tombstones` and the pull — apply a page through one function, `applyPeerTombstones` (`sync/tombstone-apply.ts`), and each element passes these, in order:

1. **Shape and seq, per element** — a malformed element (no `type`, a missing field, a seq the counter cannot carry) is refused on its own and logged, and the rest of the page applies. An element whose `type` this instance does not know (a newer peer's) leaves the whole page unapplied — the push answers `400`, the pull holds its watermark — so the sender re-sends it once this instance upgrades.
2. **The admitted space** — the element is applied to the LOCAL space the door admitted (the query's `spaceId` after the network alias is resolved, or the space the cycle is syncing), never to the `spaceId` it carries. Under a `spaceMap` an honest peer's deletion lands in the local space.
3. **Issuer proof** — because `tombstone.instanceId` is attacker-controllable, it is authorised only when the tombstone was delivered by the issuer itself — the authenticated peer's identity (`peerInstanceId`, carried on production peer tokens; or `member.instanceId` on the pull path) equals the issuer — or the caller is a trusted local/admin token. A tombstone relayed by a third party on behalf of another author is **refused and not stored**; the authoring peer's own tombstone reaches each member first-hand on direct sync.
4. **Author match** — when the target record is held here, `tombstone.instanceId` must equal `localDoc.author.instanceId`. A tombstone for another author's record is **refused and not stored**.

Only then is the tombstone stored and its record deleted — authorised before it is stored, because a stored tombstone refuses every later copy of its record. Together this prevents a member from forging a tombstone with `instanceId` set to a victim instance in order to delete, or block, the victim's content across the network. A tombstone whose target is absent is stored. Documents without `author` metadata (legacy, pre-author-field data) stay deletable by an admitted peer whose own tombstone it is, since authorship cannot be determined. Refusals are named in one warning per page. A page costs the same number of database operations whatever its size.

### Document ID collision safety

All document `_id` values (`facts`, `entities`, `edges`, `chrono`, `links`) are **UUIDv4** — 122 bits of cryptographic randomness from Node.js `uuid` v4. The probability of two independent instances generating the same `_id` is astronomically low (~2.7 × 10⁻²⁰ after 1 billion documents). In practice, a publisher's tombstone targeting `_id = X` will never match a subscriber-created document because the subscriber's documents will always have different UUIDv4 identifiers. The tombstone deletion-authorisation checks are a defence-in-depth layer on top of this structural guarantee.

### How a pulled page is stored

A pulled page is accepted by **the same page accept as a push** (`Q-204`): one document delivered either way leaves the same stored state. In order:

- **Each document is validated against its family's `Incoming*` schema** (`Q-225`), the same schemas `batch-upsert` uses, then against the shape rule (a `_id` that is a string, a seq that is a non-negative integer within the ingest ceiling). A refusal is that document's alone. A pulled file record is the sender's stored row, so its own machinery (size, hash, excerpt, media fields) is removed first; a key that is neither on the wire nor part of a file row refuses the record, as it does on push, and a `parentFileId` of any type refuses it — it is never stored as a top-level file.
- **It is planned by the push's rules**: a tombstone this instance holds at or above the incoming seq refuses the record (`tombstoned`), except that a tombstone another instance issued neither refuses nor is cleaned up by a record whose author is the member the page was read from; a stale one below it is deleted once the record lands; an equal-seq divergent fact **forks** within the caps ([forks](#facts--fork-on-equal-sequence)); an in-page unique-key collision is decided first-accepted-wins.
- **One deliberate difference:** a chrono `type` outside this space's vocabulary is stored on pull, while a push answers `unknownType`. On pull the receiver's schema comes from the same upstream as the record, and dropping it would lose the record for good — the watermark moves past it either way.
- **It is written by the one arrival writer** (`Q-107`): retagged to the local space id; an id repeated in one page collapsed to its highest seq; the sender's local-only fields dropped and the receiver's own carried (an arrival this instance suppresses carries none of its vector — [below](#post-batch-upsert)); the receiver's retention stamped ([receiver retention](#receiver-retention-applies-to-arrivals)); a stored copy at or above the incoming seq kept; and every landed record **queued for embedding** by the receiver's suppression rules, in the background lane (`Q-203` — a pulled record used to be stored and never queued).

The local seq counter is bumped past every seq the page carried before the next page is read, so a local write never takes a seq below a record already stored.

**A failed write is a record-write failure, not an unreachable peer.** A write the store cannot do for a reason that is not one document's (the collection unavailable, a dropped connection) stops that family's transfer, holds its position below the page, logs the space and family, and fetches the page again next cycle. It does not count toward `PEER UNREACHABLE`.

**Records pulled before this release** were stored without an embed job and stay without a vector until queued: `POST /api/spaces/:id/reembed` queues every record of a space that has none.

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
- **`applied` is not a count of what CHANGED, and `applied: 0` is not proof of receipt.** The receiver increments it for every element that passes a shape check (`_id` present, `path` a string) and a path-traversal guard, whether or not the upsert inserted anything — so an already-held tombstone still counts. What it does NOT count is an element it rejected, and it rejects them **silently**. So `applied` short of the number you sent means that many were thrown away, and `applied: 0` on a non-empty push means **every** element was. Never prune on it.
- **Timestamps are compared only in the fixed-width `…Z` form**, which sorts lexically. An offset form (`+02:00`) sorts later while being earlier in real time, so anything else is treated as unknown rather than compared.

**The file-tombstone pull is deliberately NOT filtered by `since`.** A file tombstone carries its original `deletedAt` and can reach a peer long after that timestamp — a third instance's old deletion relayed onward, or a peer back from a week offline. `deletedAt > since` would skip exactly those, and the file they should delete would stay. The payload concern such a filter would address is answered by the prune instead: once every peer's copy is bounded, the full set is small.

This matters more than the record half: `FileTombstoneDoc.path` is often personal in itself, so an unbounded collection means a deleted file's **name** is retained indefinitely.

---

## Push phase

```http
POST /api/sync/tombstones?spaceId=&networkId=                               (paged: 500/request, tie-safe, looped until drained)
POST /api/sync/batch-upsert?spaceId=&networkId=                             (ceil(changed/200) requests)
```

Tombstone push is deliberately **unbounded** (it loops in pages of 500 until every pending tombstone is delivered, up to 200 requests per cycle) so a peer that was offline for a long time never misses deletions. It pages with the same tie-safe cursor as the pull: a full page's next cursor is its last seq minus one, and a page that is all one seq is asked again once at 5000 — still full, the push stops, warns, and holds the push watermark below that seq. The receiver's `refused` count is logged once per transfer; a refusal is by shape or seq, which a re-send cannot change, so the push still advances past it.

### Push order: one family per request, targets first

A sender pushes **one record family per `batch-upsert` request**, in the order `REPLICATED_FAMILIES` declares
(`server/src/sync/replicated-families.ts` — the list is the authority, and this page does not copy it): every
family a reference can point at comes before the families that hold references, so edges and links go after
the records and file metadata they name. A receiver relies on that order. On a strict-linkage space it checks
the references a request carried once the request is answered, and leaves unjudged only the families that
come after the last family the request carries, in that order — they are still to come in the same cycle. So a target pushed in
the same cycle as the edge or link naming it is never recorded missing.

**A sender that pushes references first** — an edge before the chrono entry it points at, a link before the
file — has each such reference recorded by a strict-linkage receiver as a link violation
(`GET /api/conflicts/link-violations`, `link_violation.created`), because the target was not there when the
request was checked and its family was not one still to come. The records themselves are stored as usual; a
violation is a record of what was missing at that moment, dismissed once the target is there. A sender
older than the release that introduced this order pushes in its old order and can cause exactly that.

### Incremental push via `lastSeqPushed`

The engine queries only documents with `seq > lastSeqPushed[spaceId]`. If nothing has changed since the last cycle, no HTTP requests are made for that type.

If the peer has never been synced (`lastSeqPushed` = 0), the full history is sent — but still in batches, not one request per document.

### `POST /batch-upsert`

Accepts `{ facts?: FactDoc[], entities?: EntityDoc[], edges?: EdgeDoc[], chrono?: ChronoEntry[], links?: LinkDoc[], filemeta?: FileMetaDoc[] }` in a single request. **An array the receiver does not read is dropped with a `200`**, so a peer built without `filemeta` loses every file description, tag and link array at the boundary — and nothing says so at either end. Up to 500 documents per type per request; what is sent past that is counted in `rejected` and offered again in the sender's next page. The batch and the individual `POST /facts`, `POST /entities`, `POST /edges`, `POST /chrono` endpoints are one code path — a single route is a page of one — so they apply exactly the same rules:

| Type | Rule |
|------|------|
| Facts | no stored copy → `inserted`; `incoming.seq > stored.seq` → `updated`; equal seq and different `fact` text → **fork**; anything else (a lower seq, or an equal seq with equal text) → `skipped` |
| Entities | no stored copy or `incoming.seq > stored.seq` → `upserted`; else `skipped`. An equal seq never forks |
| Edges | same as entities. Another id already holding the edge's `(from, to, label, fromKind, toKind)` → `duplicateTriplets`, and the local copy is kept |
| Chrono | same as entities, after the vocabulary check (an unknown `type` → `unknownType`) |
| Links | same as entities. Another id already holding the link's endpoints is that same link → `skipped` |
| File metadata | `incoming.seq > stored.seq` (or no stored seq) → merged (`$set` of the authored keys, under the same write guard as every family) → `upserted`; else `skipped` |

Every document is first validated against its family's `Incoming*` schema — the same step a pull runs ([how a pulled page is stored](#how-a-pulled-page-is-stored)); a failure is counted in `rejected` and, on a single route, answers `400 Invalid <kind> document`.

**Send one family per request, in `REPLICATED_FAMILIES` order** ([push order](#push-order-one-family-per-request-targets-first)). The route accepts several arrays at once, and checks a request's references after the whole request has landed; but it treats only the families after the LAST one the request carries as still to come. A reference whose target travels in a LATER request of the same cycle is therefore recorded missing unless the target's family comes after that one — which is exactly what pushing targets first guarantees.

Every family checks a tombstone first: one at or above the incoming seq → `tombstoned` — except that a tombstone another instance issued for that id neither refuses nor is cleaned up by a record whose author is the peer pushing it, proven by its peer token. A claimed author is not proof: pushed by an admin token, or by a peer that is not the author, the record is `tombstoned` as before, so a forged author cannot resurrect a deleted id (a tombstone or record with no instance on it governs, as before). A pull applies the same rule, the member it reads from being the deliverer. A stale tombstone below it is deleted **only once the record has landed**, so a write that fails keeps the deletion.

**What the counters count.** Each counts ITEMS of the request, as processing them in order would count them. When one page carries the same `_id` more than once, the copies are decided in order against each other (`[seq 5, seq 6]` for an entity is `upserted: 2`; `[seq 9, seq 3]` is one `upserted`/`inserted` and one `skipped`) and only the final winner is written, so the stored copy is the highest seq. If that final write fails (a unique-index duplicate, or a document the store refuses), the version the page accepted before it is written instead, and the counters follow what landed.

**Every document a push carries is stored by the receiver's rules** (`Q-107`): retagged to the receiver's local space id under a `spaceMap` alias; written with the receiver's own `embedding`, `embeddingModel`, `matchedText`, retention stamps and `syncBase` carried over from its stored copy (so a peer's edit does not erase them); stamped with the receiver's retention policy when the record carries no receiver stamp (see [receiver retention](#receiver-retention-applies-to-arrivals)); and queued for embedding by the receiver's suppression rules, in the background lane. **An arrival the receiver suppresses** (its own `suppressEmbeddings`, or this instance's type or space setting) carries the retention stamps and `syncBase` only: its stored vector, model and `matchedText` described content the receiver no longer embeds, and are dropped — a file's derived passages lose their vectors too (`Q-230`).

**The write guard.** Each write replaces (for file metadata: merges into) only a stored copy whose seq is below the incoming one (or that has none). A copy written locally between the read and the write is therefore kept, and the document counts as `skipped`. A copy written meanwhile at the SAME seq with different fact text is a divergence: the arriving copy forks, exactly as it would have had it been read first (`Q-232` — it used to count itself landed while its text was stored nowhere).

Response: `{ status: 'ok', facts: {inserted,updated,forked,skipped,forkDepthRefused,tombstoned,schemaViolations,rejected}, entities: {upserted,skipped,tombstoned,schemaViolations,rejected}, edges: {upserted,skipped,tombstoned,schemaViolations,duplicateTriplets,rejected}, chrono: {upserted,skipped,tombstoned,schemaViolations,unknownType,rejected}, links: {upserted,skipped,tombstoned,rejected}, filemeta: {upserted,skipped,rejected} }`

**One of those counters is the sender's only report of a PERMANENT loss.** `skipped` means the peer was already current, which is benign. `forkDepthRefused` means a record was DROPPED and will not be retried — the push path reads exactly that field to report a refusal, so a receiver that does not emit it makes the loss silent at both ends. `schemaViolations` counts documents stored despite failing the RECEIVER's schema (validated, counted and let in — see the ingest rule below); `duplicateTriplets` counts edges the unique index rejected; `unknownType` counts the case below. **`rejected`** is everything the sender must not count as delivered: a document that fails its `Incoming*` schema, one past the 500 cap, one with a `_id` that is not a string or a seq outside the ingest ceiling, one the receiver's store refuses (named by id in the receiver's log), a fork refused at its cap, and an unknown chrono type.

**A failed write that is not one document's answers 500 — or 503 when it is the store's.** A fault with no per-document cause fails the page, so the sender holds its watermark and offers the page again. When the receiver's classification identifies the STORE (a write its bound ended, a dropped connection, a step-down) the answer is `503` with `retryable: true`, a `Retry-After` and the receiver's own words — the same classification its REST and MCP doors answer from; anything else, and a seq counter the receiver could not move past the page, is a `500`. Re-sending is safe: records that landed before the fault come back `skipped`, and a fork that landed comes back as the same fork (below).

**The counter moves before the answer.** Before it answers, the receiver awaits a bump of its seq counter past every plausible seq the request carried — written or not, so a tombstoned, skipped or refused-as-unknown document moves it too. A seq the receiver refuses as implausible does not. A fork the request causes is then written with a LOCAL seq allocated above all of them, so it sorts after the arrival that caused it.

**`filemeta` reports its counters like every other family.** Six arrays in, six sets of counters out. A peer older than 4.0 returns no `filemeta` counters.

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

The receiving brain detects `incoming.seq === existing.seq && incoming.fact !== existing.fact` and creates a **fork**: a new fact with `forkOf: "abc"` and the next available local `seq`. Both versions coexist and can be reviewed by the user.

**The fork's id is derived** from the parent's id, the shared seq and the incoming text (a v4-shaped UUID). So a push whose response was lost and is re-sent upserts the fork it already made instead of forking again, and an identical divergence forks once.

**The fork keeps the divergent copy's `createdAt` and `updatedAt`** — when its text was written, not when this instance forked it — so its retention window counts from its own age and two receivers forking one divergence store one document under the one derived id.

**Two caps, on every door — both push routes and the pull.** A fork is refused when the parent's `forkOf` chain is already 10 deep, or when the parent already has 10 forks — stored ones and the ones the same request is creating, counted together. `POST /facts` answers `400 Fork depth limit (10) exceeded for _id '…'`; `batch-upsert` counts it in `forkDepthRefused` and `rejected`; a pull names it in the receiver's log and moves past it, as the push sender does. **Mixed versions:** the fan-out cap on `batch-upsert` is new in this release — an older receiver accepts an eleventh fork of one parent that a newer one refuses, so a network mixing the two can hold different fork sets for such a record.

### Receiver retention applies to arrivals

A record that arrives — by push, by pull, or by an admin import — and carries no retention stamp of this instance is stamped by **this instance's** retention policy (type schema over space), counted from the record's own `createdAt`, never from the moment it arrived. A record older than the window is stamped in the past, and the TTL sweep deletes it through the normal delete path, which writes a tombstone that travels to peers. A stamp this instance already holds for the record is carried across the peer's update, never recomputed. The sender's own stamps never cross the wire.

**An admin import is a restore** (`Q-234`): it stores the backup's retention stamps and `syncBase` as the backup carried them, a stamp the backup does not carry from this rule, and never the values of the copy it replaces — a record restored to "never expires" no longer goes on expiring on the replaced copy's date.

### Entities and edges — last-writer-wins

Entities and edges are structural metadata (names, relationships). They use a simpler `seq`-wins rule: the document with the higher `seq` survives. Equal seq is treated as a no-op (already in sync).

---

## Timeouts

| Constant | Value | Applied to |
|----------|-------|------------|
| `FETCH_TIMEOUT_MS` | 10 s | Tombstone requests, individual per-doc requests (legacy), manifest requests |
| *(whole-file transfer budget)* | 10 min | File UPLOADS to a peer. A source constant with no environment variable — naming it here would invite you to set something that is not settable |
| `BATCH_FETCH_TIMEOUT_MS` | 60 s | `GET /facts?full=true`, `GET /entities?full=true`, `GET /edges?full=true`, `POST /batch-upsert` |
| `YTHRIL_WRITE_TIMEOUT_MS` (receiver) | settable, [default in Hosting](integration-guide/02-hosting.md) | Each database operation a RECEIVER issues inside a seq hold, and on every push door |
| `YTHRIL_HOLD_DEADLINE_MS` (receiver) | settable, [default in Hosting](integration-guide/02-hosting.md) | One seq hold, and one push page, in all: three quarters of the sender's batch budget, so a stalled receiver answers a retryable `503` before the sender gives up |

The separation prevents a single slow 800 KB batch payload from being aborted by the 10 s timeout while also preventing a timed-out offline peer from holding up a sync cycle for more than 10 s per non-batch call. The two receiver bounds are the other side of the batch budget: a write that holds its seq horizon (every seq-paged reader of the space waits below it) ends within them, so a lock or a stalled socket on the receiver stops replication of one space for at most the hold deadline, never indefinitely.

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

1. **File tombstones, both directions** — the engine pulls the peer's file tombstones (`GET /api/sync/file-tombstones`) and applies them (subject to the same [deletion authorisation](#tombstone-deletion-authorisation) rules as document tombstones), then pushes its own file tombstones (`POST /api/sync/file-tombstones`). **Only a tombstone whose act has happened is served or pushed**: a delete or move writes its tombstone before the bytes go, held back as pending until they are gone or moved, so a peer — which deletes its copy and passes a received tombstone on, back to the sender too — is never told to delete a file the sender still holds. A served tombstone carries `_id`, `spaceId`, `path` and `deletedAt`, nothing else.
2. **Manifest** — `GET /api/sync/manifest?spaceId=&networkId=` retrieves the peer's list of `{ path, sha256, size, modifiedAt }`, and `spaceId`: the peer's LOCAL id for the space it resolved the request to. The file transfers that follow use the plain file routes (`GET`/`POST /api/files/:spaceId`), which know only local ids, so they address the peer by that answer; a peer that predates the field is addressed by the network's id. Manifests are served from a per-space file-hash cache (`<spaceId>_file_hashes`), so the peer does not re-hash its whole tree per request.
3. **Download** — files we lack entirely are downloaded via `GET /api/files/:spaceId?path=<relative path>` (the path travels as a query parameter). Downloaded bytes are SHA-256 verified before writing to disk; a mismatch is logged and the file discarded.
4. **Divergence: who changed it decides** — each end remembers, per file and per peer, the hash both last held (`syncBase`, local to the instance, never replicated or hashed). When a file differs: if **our** copy is still that agreed version, only the peer changed it and theirs replaces ours (logged `FILE_REPLACED`); if the **peer's** is, only we changed it and our push carries it; otherwise both changed it and the peer's version is written as a conflict copy beside ours, with a `ConflictDoc` surfaced in **Workspace → Conflicts**. Nothing is overwritten on a real conflict. With no agreed version yet (data from before this rule), a difference is a conflict.
5. **Push** — files the peer lacks, or holds only in the agreed version, are uploaded to it. With no agreed version yet, the newer `modifiedAt` wins as before. The receiver records bytes that a peer token delivers to `POST /api/files/:spaceId` as an **arrival**, exactly as a download in step 3 is recorded: size and hash only, the peer as author of a record that is new there, and no seq of its own. The file's description, tags and properties come from its replicated metadata, and any metadata in the upload body is ignored. Stored as an upload, the receiver's copy took its own next seq and tied or outranked the publisher's next metadata edit, which then never landed.
6. **Instance-local files never travel** — a conflict copy (`<name>_<time>_<peer>.<ext>`), a schema snapshot (`schemas/<space>_<kind>_<type>.json`) and a legacy read spill at the root (`_tmp/graph-<uuid>.json`, `_tmp/results-<uuid>.json`, written by versions before 5.6.0) are this instance's own: they are left out of the manifest it serves, never pushed, and refused when an older peer offers them.

Manifest requests use the 10 s timeout and batch-style transfers the 60 s one. A whole file body gets the ten-minute transfer budget, because a 10 s ceiling on a multi-megabyte upload aborts it on any ordinary link.

**A download gets the same budget.** The 10 s control-plane signal is stripped before the transfer call, so only the transfer budget reaches the fetch.

---

## Merkle divergence check (opt-in)

With `merkle: true` on the network config, the engine ends each per-space sync by comparing content roots with the peer: it computes the local Merkle root and fetches the peer's via `GET /api/sync/merkle?spaceId=&networkId=`.

**The algorithm, because a root cannot be reproduced from a prose summary.** Each brain document contributes a leaf `SHA-256("doc:<collection>:<_id>:<seq>:<sha256(canonical JSON)>")` over **all six** collections — facts, entities, edges, chrono, links and files — and each file manifest entry contributes `SHA-256("file:<path>:<sha256>")`. Leaves are sorted lexicographically; an odd level duplicates its last node; an empty tree is `SHA-256("")`. An instance may build the root from the sorted leaves it kept per collection since an earlier call (re-reading only a collection written since) — merged, they are the same sorted list, so the root is the same; `computedAt` is when that root was computed. File CHUNK records are excluded by a `parentFileId: {$exists: false}` filter, so a chunked file contributes its parent only.

**What is left out of a document's hash is what never travels as it is — not just "embeddings".** The local-only fields (`sync/local-only-fields.ts`: the vector, its model, `matchedText`, the retention stamps, the sync base) are derived by the local embedding model or the local retention policy, so none of them can travel: peers running different models hold different vectors for identical content, and a retention stamp would let one instance decide when another deletes its data. And **`spaceId`**, which travels and is then rewritten by the receiver to its own id for the space (`sync/retagged-fields.ts`): under a `spaceMap` alias two members hold the same space under two ids, and hashing it made their roots differ in every leaf for ever.

**Files that never leave an instance are left out too** — a conflict copy, a schema snapshot, a legacy read spill (`isInstanceLocalFile`, the predicate the peer manifest already used): neither their record nor their manifest entry is hashed. Each member holds its own, so hashing them reported a divergence for ever over files that are not meant to match.

**Mixed versions.** A root computed by a version before this rule hashes `spaceId` and the instance-local files, so it never equals one computed after it, even over identical data: a `merkle: true` network whose members run both versions logs `MERKLE_DIVERGENCE` for every space until all of them have upgraded. The check is advisory and blocks nothing; the warning stops once both ends compute the same rule.

**And `files` runs the opposite way round.** The five other collections EXCLUDE those fields from an otherwise-complete document; a file record has thirty-odd fields, most of them local machinery, so it is hashed from an INCLUSION list of its authored keys instead (in `brain/merkle.ts`; `spaceId` is not among them, for the reason above). A field added to a file record is therefore outside the hash until it is added to that list — the reverse of the rule for every other collection, and the direction that fails silently. Matching roots log `Merkle OK`; a mismatch logs a loud `MERKLE_DIVERGENCE` warning naming the space, peer, and both roots with leaf counts — the space contents differ *after* sync, indicating possible data loss, a concurrent write, or a sync bug. This is **detection only**: nothing is auto-repaired, and any failure in the check itself (peer error, missing field) degrades to a warning without affecting the sync result.

---

## Gossip phase

At the **start** of each cycle — before any data sync, see [Overview](#overview) for why — the engine performs a lightweight member identity exchange with each peer:

1. **Self-announce** — `POST /api/sync/networks/:networkId/members` with `{ instanceId, label, version, spaces, children?, spaceNames?, url?, signingPublicKey?, signingKeyRotation? }`. `spaces` names the spaces this instance carries by their NETWORK ids; `spaceNames` maps each network id to this instance's local name where the two differ, and is sent only to a member this instance is upstream of (see [Space ID remapping](#space-id-remapping-spacemap)). The peer's piggybacked answer is built by the same function, so the two directions carry the same fields. The `url` field is included only when the `INSTANCE_URL` environment variable is set; if omitted, the peer keeps the URL it already has on record. The signing fields distribute the instance's vote-signing public key (see [Signed vote casts](#signed-vote-casts)).

2. **Self-record piggyback** — the receiving peer includes its own current identity in the `200` response as `{ status: 'ok', self: { instanceId, label, url?, signingPublicKey?, signingKeyRotation? } }`. The caller updates its local member entry for that peer from this payload — no separate GET is needed.

3. **Pull member view** — `GET /api/sync/networks/:networkId/members` fetches the peer's full member list. Any record whose `instanceId` is already known locally (but is not our own `instanceId`) has its `url`, `label`, and `children` merged in if they differ.

**Both self-records also carry `spaces`** — the network's spaces as the sender carries them, in the network's ids. An instance adopts from it only when the sender is its **upstream**: a pub/sub subscriber from its publisher, a braintree node from its parent. What it adds is decided by the token that joined the network there: a space that token could have joined is created under that id and added to the network, and the tokens it issued to the network's members are widened to it. Anything else, including a same-named local space, is held as a pending space for the operator (`POST /api/networks/:id/pending-spaces`). The announcement only adds; a space missing from it is never removed. From anyone else — a subscriber announcing to its publisher, a club peer — it is ignored.

## Change notes

A downward sync can carry a note: markdown, plus the spaces it concerns. It is queued per member BELOW the sender (a publisher's subscribers, a tree node's children) and delivered in that member's exchange by `POST /api/sync/networks/:networkId/change-notes`, which the receiver accepts only from its upstream, identified by the calling token and never by the body. A note that did not arrive stays queued for the next cycle; re-delivery is a no-op. The receiver keeps it per network and fires `change_note.received` per space. Structural changes a network carries — a schema update, a space added — draft their own.

## Schema phase (pub/sub and braintree)

Before pulling a space's records from its upstream, the engine pulls the space's meta — `GET /api/sync/meta?spaceId=&networkId=` — and merges it into the local meta. Only from the upstream, so a schema flows down a pub/sub network or a tree and never up.

- **What travels** is everything a network governs: type schemas, purpose, usage notes, validation mode, strict linkage and the other `meta` fields. Never what the server owns (`version`, history, reindex flags), and never the space's operational settings (duplicate rules, record retention, document extraction), which are not in `meta`.
- **The merge only adds.** A type the receiver lacks is added. A type both hold keeps every local property and gains the network's; a property both hold takes the network's definition, as does a type's own field (a naming pattern, an edge's endpoints) where the network sets one. A schema-library reference is one unit and is replaced whole. Nothing local is removed.
- **Library references travel resolved.** A schema-library entry is the instance's own and does not travel, so the sender writes every reference it can resolve inline — here and in the `pendingMeta` of every round it serves. A type whose reference neither side can resolve is left out on arrival and logged; the rest of the schema is merged.
- **Otherwise refused whole, never in part.** A meta the local API would reject is logged and nothing is merged.
- **It never stops data.** A schema that cannot be fetched or merged leaves the record sync to run as it would have.
- **A space in two networks keeps each network's schema apart**. What a network sends is stored as that network's *layer* for the space, next to the instance's own definitions, and the meta the space runs on is rebuilt from them: own definitions, then the layers in precedence, so the network joined first wins where two define the same thing differently (`networkPrecedence` on the space reorders it). A clash never stops either network's records.
- **Nothing mixed is sent on.** `GET /api/sync/meta?networkId=` answers with the instance's own definitions plus *that* network's layer — never another network's, never the combined result — so one network's definition cannot leak into the other.
- **An operator's edit lands in the own definitions**, so it survives the next layer arriving; a type a network defines cannot be removed locally, because the replicated schema is additive.
- **A passed `meta_change` reaches every member**. The proposer keeps serving the passed round on `GET /api/sync/networks/:id/votes`, so a member that never saw it open — a club member, a late joiner — adopts it and re-decides it from the casts. The proposer applies it to its own definitions, and to that network's layer as well where it holds one — a layer outranks own definitions, so without it the proposer would go on seeing the layer's old value in front of its own change. Every other member applies it into that network's layer, so replaying an old round can refresh the layer but never overwrite what the member defined itself.
- **A space added to a voted network carries its schema.** Club, closed and democratic networks have no schema pull, so the `space_addition` round carries the space's meta as `pendingMeta`, and a member that adds the space from the passed round keeps it as that network's layer. On pub/sub and braintree the member pulls it from its upstream as above.
- **A network update never removes a type.** A round is applied as a merge, including a `replace` the proposer sent, so a type the proposer left out is kept on every member; the proposer's answer names the kept types (`appliedAsMerge`, `keptTypes`) and the members below are sent a change note saying so. A round names the space by the network's id, and each member resolves it to its own.

### Gossip poisoning protection

On the receiving side, the `POST /api/sync/networks/:networkId/members` endpoint only updates the record for the exact `instanceId` in the request body. It will not update any other member's record — so a compromise peer cannot overwrite other members' identity details. Unknown `instanceId` values (not already in the member list) are silently acknowledged as `{ status: 'unknown_member' }` and never auto-added.

On the pulling side, records returned by `GET /members` that share our own `instanceId` are never applied.

---

## API reference

All endpoints are under `/api/sync` and require a `Bearer` token. In normal operation that is a **peer token** — a PAT carrying `peerInstanceId`, issued to the peer during join. Read endpoints additionally accept admin and appropriately space-scoped user PATs, and admin tokens act as trusted local relays for tombstones.

The two **governance relays** — `POST /networks/:networkId/members` and `POST /networks/:networkId/votes/:roundId` — accept **a peer token speaking for its own instance, or an instance administrator relaying on a peer's behalf**, and refuse anything else with `403`. The authorisation runs before the network and round are looked up, so an unauthorised caller cannot learn which rounds are open from the status code.

The seven **data-write endpoints accept only peer or admin tokens** — see [Direction enforcement on inbound endpoints](#direction-enforcement-on-inbound-endpoints). Rate-limited per IP.

### Read endpoints (called during pull)

| Method | Path | Key params | Returns |
|--------|------|------------|---------|
| `GET` | `/api/sync/facts` | `spaceId`, `networkId`, `sinceSeq`, `limit`, `cursor`, `full` | `{ items[], nextCursor }` |
| `GET` | `/api/sync/facts/:id` | `spaceId`, `networkId` | Full `FactDoc` |
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
| `GET` | `/api/sync/tombstones` | `spaceId`, `networkId`, `sinceSeq`, `limit` (default 1000, max 5000 — PER TYPE) | `{ facts[], entities[], edges[], chrono[], links[] }`, each ascending by seq and at most `limit` long. A full array may have more at its last seq: page with the [tie-safe cursor](#tombstones-pulled-first), never by moving to the last seq |
| `GET` | `/api/sync/file-tombstones` | `spaceId`, `networkId`, `since` | `{ tombstones[] }` |
| `GET` | `/api/sync/manifest` | `spaceId`, `networkId`, `since` | `{ manifest[{ path, sha256, size, modifiedAt }], spaceId }` (`spaceId`: the responder's local id) |
| `GET` | `/api/sync/merkle` | `spaceId`, `networkId` | `{ spaceId, root, leafCount, computedAt, networkId }` (only used when `network.merkle: true`) |
| `GET` | `/api/sync/networks/:networkId/members` | `networkId` | `{ members[{ instanceId, label, url, direction, … }], updatedAt }` |

There is no dedicated identity endpoint — a peer that needs the instance's identity calls the regular authenticated `GET /api/about` (`{ instanceId, instanceLabel, version, … }`), and identity also arrives on every cycle via the gossip `self` record.

`?full=true` on the list endpoints returns complete documents instead of `{_id,seq}` stubs. Maximum `limit` is 500. Tombstone stubs (items with `deletedAt`) are always appended to list responses regardless of `full` mode.

**A peer must serve all six families, and `tombstones` must carry `links[]`.** A peer that serves neither `links` nor `filemeta` drops both on the way in and never propagates a link deletion — and because `merkle` hashes all six collections, its root then diverges permanently on data that is not actually different. The check is advisory, so nothing contradicts the warning, and an operator learns to ignore the one signal that means data really is missing.

### Write endpoints (called during push)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/api/sync/facts` | `FactDoc` | `200 { status: 'inserted'\|'updated'\|'forked'\|'skipped'\|'tombstoned' }` — the `'forked'` case also returns `forkId` (the new fork document's `_id`, derived, so a re-sent push answers the same id); `400` for a fork at either cap, or a document the receiver's store refuses |
| `POST` | `/api/sync/entities` | `EntityDoc` | `200 { status:'ok' }` (or `'tombstoned'`); `400` for a document the receiver's store refuses |
| `POST` | `/api/sync/edges` | `EdgeDoc` | `200 { status:'ok' }`, `'tombstoned'`, or **`'duplicate'`** when the unique `(from, to, label, fromKind, toKind)` index already holds the edge under another id (an insert, or an update moving onto it); `400` for a document the store refuses |
| `POST` | `/api/sync/chrono` | `ChronoEntry` | `200 { status:'ok' }` (or `'tombstoned'`); `400` for a `type` outside this space's vocabulary, or a document the store refuses |
| `POST` | `/api/sync/batch-upsert` | `{ facts?, entities?, edges?, chrono?, links?, filemeta? }` | `200 { status:'ok', facts:{…}, entities:{…}, edges:{…}, chrono:{…}, links:{…}, filemeta:{…} }` — six arrays in, six sets of counters out |
| `POST` | `/api/sync/tombstones` | `{ tombstones[] }`, at most 5000 (`400` above) | `200 { applied: N, refused: R }` — `N` is the elements admitted by shape and seq (applied, or refused on authorisation and not stored); `R` is the elements refused on their own for their shape or seq (logged), never the page. `refused` is additive. An element of an unknown `type` answers `400 { error: 'Invalid tombstone format' }` and nothing of the page is applied. Applied to the space the query admitted, never the `spaceId` an element carries. The counter is bumped past the highest admitted seq, awaited, before the answer; a counter that could not move answers `500` |
| `POST` | `/api/sync/file-tombstones` | **`{ spaceId, tombstones[] }`** — `spaceId` in the BODY, not the query; absent it answers `400 { error: 'spaceId required' }` | `200 { applied: N }` |
| `POST` | `/api/sync/warm` | `{ networkId, spaces[] }` | `200` once the embedding model, token cache and collection handles are warm. It touches `facts`, `entities`, `edges` and `chrono` only, and results are discarded |

**Direction is enforced on `braintree` and `pubsub` networks only.** A peer whose `member.direction === 'push'` — we push to them, so they should not be writing to us — is refused with a `403` on those two types. On any other type carrying the space the write is allowed, which is deliberate: direction is a topology property of a tree and a publisher, and a `closed` or `club` network has no upstream to protect. See [Direction enforcement on inbound endpoints](#direction-enforcement-on-inbound-endpoints).

**`POST /api/sync/warm` enforces less than the other write endpoints.** It sits behind authentication and nothing else — no peer gate, no direction, no space scope — which costs nothing because it discards its results. Direction is also read from the CALLER's peer identity, so a token with no `peerInstanceId` is not direction-checked at all; the peer-or-admin requirement is what stands in front of that.

**There is no single-document route for `links` or `filemeta`.** Both arrive only through `batch-upsert`, so a peer implementation that only wires the per-type `POST` endpoints replicates neither.

`POST /batch-upsert` is the primary push path used by the engine. The individual `POST /facts`, `/entities`, `/edges`, `/chrono` endpoints remain for backwards compatibility and direct API usage; they are the same page accept with one document, so every rule above holds on them too — the counter bump before the answer included.

All incoming documents are validated against Zod schemas before any database write. Invalid documents are rejected with `400` (single endpoints) or counted in `rejected` and named in a warning (batch-upsert). Key constraints: `tags` max 100 items, all string fields validated for type safety. Unknown fields are stripped.

Two additional ingest safety caps protect the local seq counter and fork chains from a malicious or corrupted peer:

- **Implausible seq** — the schema bound on `seq` is 2^50, but ingest applies a stricter ceiling of `2^50 − 2^40` (`arrivalRefusal` in the arrival writer, and `seqRefusal` for a tombstone); a document above it is refused so a poisoned seq can never exhaust the counter's headroom.
- **Fork limits** — fork chain depth and fan-out (no more than 10 forks pointing at the same parent, the request's own new forks counted) are each capped at 10 on both paths: exceeding either returns `400` on the single `POST /facts` endpoint and counts `forkDepthRefused` (and `rejected`) in `batch-upsert`, with the refused ids in the receiver's log.

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

**Since 5.6.0 a cast also carries `bsig`**, a signature over `ythril-vote:v2|<networkId>|<roundId>|<subjectInstanceId>|<voterInstanceId>|<vote>|<type>|<spaceId>|<networkSpaceId>|<wipeTypes, sorted, comma-joined>` — what the round would DO. The v1 message binds only the round's id, so a member relaying a `space_deletion` or `space_wipe` round could rewrite which space it targets, or what it wipes, and every honest cast still verified on the receiver that learned the round from it. A receiver checks `bsig` against the round it is applying; a re-aimed round fails. `sig` stays so a 5.5.2 peer can still verify the cast.

**The transition.** A cast without `bsig` is refused from a voter this instance knows runs 5.6.0 or later (itself, or a member whose reported `version` says so), so stripping `bsig` does not fall back to the check it defeats. From an older voter, or one whose version is not known yet, the v1 check stands until every member has upgraded. A cast a voter made before it upgraded reaches only peers that do not yet know it upgraded. `pendingMeta` is not bound: a sender inlines library references into it on the way out, so honest copies differ.

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
instance is about to relay has a round to land on.

1. **Pull rounds** — `GET /api/sync/networks/:networkId/votes` fetches the peer's open rounds. For each round:
   - **New round**: if the round does not exist locally, it is adopted into `pendingRounds` (with an empty `votes` array); votes are then merged in the same pass.
   - **Vote merge**: each cast from the peer's round is accepted only if it passes the signature/own-cast check above (a forged cast attributed to another member is dropped). The cast — including its signature — is stored verbatim so it can be relayed onward unchanged. If the same voter's cast changes (e.g., `yes` → `veto`), the local cast is replaced.

2. **Push casts** — for each local vote round — including already-concluded ones, so that a round-concluding cast still reaches peers that have not concluded yet — each known vote cast is relayed to the peer via `POST /api/sync/networks/:networkId/votes/:roundId { vote, instanceId, sig, castAt }`, forwarding the voter's signature so the peer can verify and relay it onward. If the peer does not yet have the round (404), the push is silently skipped — the round will arrive on the peer's next pull cycle.
3. **Round conclusion** — after all merges, `concludeRoundIfReady` is evaluated for every open local round. Unanimous-type networks (closed, braintree) require every member to have individually cast `yes`, **this instance included**. A single outstanding member prevents conclusion, so a member that adopted a round by gossip never passes it on the other members' word alone. The subject of a join or removal is the one member not asked. For **braintree** rounds the required-voter set (ancestor path) is recomputed from the local topology at conclusion, never trusted from the adopted round, so a peer cannot shrink it. Democratic networks use a simple majority count. Club networks conclude on the first `yes`.

4. **Side effects** — if a `space_deletion` round passes with zero vetoes, the space leaves the network on this instance, with its id mapping, its schema layer and any pending offer of it; the space and its data stay as a local space. Only the proposer then deletes its own copy, once no other network carries it. A `space_wipe` round behaves the same way but EMPTIES the space instead of removing it, wiping exactly the collections named on the round (**all six** when it names none — facts, entities, edges, chrono, files and links). Both are applied through one function called from all three conclusion paths — an operator's own vote, a peer's vote arriving, and the gossip pass.

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
- Braintree auto-adopt logic runs (orphaned children are re-parented to the closest surviving ancestor).

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

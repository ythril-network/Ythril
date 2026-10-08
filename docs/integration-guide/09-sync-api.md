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

Events: `vote_pending`, `member_departed`, `member_removed`, `space_deletion_pending`, `space_wipe_pending`, `meta_change_pending`, `sync_available`, `ping`.

`data` is optional and at most **8 KiB** serialised — more is a `400` naming `data`. The receiver keeps the recent
events in memory for `GET /api/notify`, and that store is bounded by bytes as well as by count (500 events, 1 MiB),
oldest out first.

> **`meta_change_pending` was refused until 5.x (`Q-108`).** A space's schema-change round sent it to every member
> and no receiver listed it, so each answered `400` and the sender, which does not read the answer, never knew.

**Response** `204`.

---

### List Events

```http
GET /api/notify?networkId=net-uuid&limit=50&skip=0
```

Newest first. `limit` defaults to 50 and is held to 200; `skip` pages on. The answer says where it stands: `events`,
`count` (rows in this page), `total` (events matching), `limit` (the one that applied), `skip`, `truncated`, and
`nextSkip` exactly when there are more — the same fields every paged list answers with. `maxChars` / `maxBytes` bound
the body as on the search routes. A non-numeric `limit` or `skip` is a `400`, never a default.

---

### Trigger Sync

Two doors, one for each subject. Both need an **instance administrator**.

```http
POST /api/networks/:id/sync            one network
POST /api/networks/peers/:peerId/sync  one peer, across every network it belongs to
Authorization: Bearer <instance-admin token>
```

Both answer the same shape: `{ "ok": true, "status": "triggered", ... }` when fire-and-forget, and with
`?wait=true` either `completed`, `504 timeout` (still running) or `500 error`. `ok` is the one-bit summary
and `status` the detail. A cycle that fails on the store is answered as every door answers a store failure —
`503`, `Retry-After`, `{ "error": …, "retryable": true, "code": … }` in our words — and never with the
database driver's message (it names internal hosts and ports). A member whose own run failed is not a failed
cycle: it is counted in `errors` of a `completed` answer.

`?timeoutMs` (default `30000`, clamped `1000`–`120000`) bounds the WAIT on the network door only. A peer
cycle is already bounded by that peer's own request timeouts, so racing it would report a timeout for
something that cannot hang. A completed peer cycle reports `networksSynced` rather than `synced`, because
one peer can belong to several networks.

The peer id must be an exact `instanceId` of a configured member, as `GET /api/networks` returns — never a
URL and never a label. An id belonging to no network is refused `404`, because an unvalidated value would
become the address this instance connects to.

A peer lives on the networks COLLECTION rather than under one network's id on purpose: a peer can be a
member of several, and the cycle walks all of them.

#### A sync can carry a change note

The network door takes an optional JSON body, so the members BELOW this instance are told what changed:

```json
{ "note": "The Task type gained a `due` date; set it on open tasks.", "spaces": ["projects"] }
```

`note` is markdown, at most 10000 characters; `spaces` names the network's spaces it concerns, by this
instance's ids (omit it for a note about the whole network). A note goes only DOWN — a pub/sub publisher to
its subscribers, a braintree node to its children — so on any other network type, or on an instance with
nobody below it (a subscriber, a leaf), it is refused with **`409`** and the sync does not run. A malformed
body, an undeclared key, or `spaces` without `note` is **`400`**. The answer names the queued note as
`noteId`, whatever became of the cycle.

The note is queued per member and delivered in each member's next exchange, so a member that is offline gets it
when it is back. The network itself drafts a note (`generated: true`) for a schema update it carries and for a
space added to it. MCP: `network_sync` with `networkId`, `note` and `spaces`.

```http
GET /api/networks/:id/change-notes?direction=in&limit=50
```

Instance-admin. `direction` `in` (default) is what arrived here, each with `from` (the sending instance),
`receivedAt` and the local `spaces`; `out` is what was written here, with `pendingFor` naming the members it has
not reached yet. `limit` 1–200, default 50. A bad value is `400`. MCP: `network_change_notes`. Each arrival fires
the `change_note.received` webhook, once per space it concerns (per space the network carries here, for a note
about the whole network) — see [Webhooks](14-duplicates-and-webhooks.md).

> **The `/api/notify/trigger` route is GONE in 5.0.** It took `networkId` or `peerId` in the body and
> delegated to the same code as the two routes above. Move to whichever of them names your subject: the
> body goes into the path, and `?wait=true` and `?timeoutMs` behave exactly as they did. A sync trigger on
> the peer NOTIFICATION channel is what let that route accept any authenticated token until 4.4, because
> the router-wide guard exemption had been written for the notification endpoint beside it.
>
> **One behaviour differs.** The old route answered `200 {status: "triggered"}` for a network that does not
> exist — it fired and forgot before anything looked. Both routes above check their subject first and
> answer `404`, so a stale or mistyped id is a refusal rather than a success you cannot act on.

---

## Sync API

### The peer version floor

Every `/api/sync/*` endpoint refuses a caller whose member record carries a version below
`minPeerVersion`, with **`426 Upgrade Required`** and a body naming both numbers:

```json
{
  "error": "Peer runs 4.4.0, below the minimum of 5.0.0 this network requires. Upgrade the peer to 5.0.0 or later.",
  "minPeerVersion": "5.0.0",
  "peerVersion": "4.4.0"
}
```

**`minPeerVersion` is THIS INSTANCE'S OWN MAJOR at `.0.0`, derived rather than configured.** A 5.x
instance requires 5.0.0; a 6.x instance requires 6.0.0. There is no setting, and the value moves with
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
`GET /api/networks`, `GET /api/networks/:id` and the MCP tool `network_peers` all carry `version` (what the
peer last reported, `null` if never), `belowFloor` (the refusal sentence, or `null`) and
`minPeerVersion` (this instance's floor, identical on every row) on each member.

`minPeerVersion` is per-member rather than on an envelope because `network_peers` returns a bare JSON
array by contract, and wrapping it would break every caller that indexes the result. Repeating a
constant per row is that tool's existing idiom — `network`, `networkId` and `networkType` already are —
and it keeps one spelling of the fact across both doors.

Base path: `/api/sync` — used by the sync engine between peers. All endpoints require auth + sync rate limit.

### Route Overview

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/sync/facts` | GET | Page fact changes (`items`, `nextCursor`) |
| `/api/sync/facts/:id` | GET | Fetch one full fact doc |
| `/api/sync/facts` | POST | Upsert one remote fact |
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
| `/api/sync/batch-upsert` | POST | Bulk upsert facts/entities/edges/chrono/links/filemeta |
| `/api/sync/tombstones` | GET | List tombstones by seq |
| `/api/sync/tombstones` | POST | Apply remote tombstones |
| `/api/sync/manifest` | GET | File manifest diff |
| `/api/sync/file-tombstones` | GET | List file deletion tombstones |
| `/api/sync/file-tombstones` | POST | Apply file deletion tombstones |
| `/api/sync/merkle` | GET | Compute Merkle root |
| `/api/sync/meta` | GET | A space's governed meta (schemas, purpose, notes) for a downstream peer to merge — `?spaceId=&networkId=` |
| `/api/sync/networks/:networkId/members` | GET | Pull gossip member view |
| `/api/sync/networks/:networkId/members` | POST | Push gossip member updates |
| `/api/sync/networks/:networkId/pair` | POST | Club only: open a direct pairing with a member a peer introduced (no credential) |
| `/api/sync/networks/:networkId/pair/confirm` | POST | Club only: the newcomer's call back that completes a pairing |
| `/api/sync/networks/:networkId/votes` | GET | Pull open governance rounds |
| `/api/sync/networks/:networkId/votes/:roundId` | POST | Relay a yes/veto vote |
| `/api/sync/warm` | POST | Pre-sync warm-up (auth/embedding/DB) |

**Link records have no single-record `POST`, and that is deliberate.** They reach a peer through
`batch-upsert`, which is what a sync cycle uses for every family anyway; the per-family `POST` routes are
the older single-record path. A link is a small record of its own — `from`, `to` and the two kinds — so
nothing about it needs a bespoke ingest.

### A file's METADATA replicates; the bytes travel separately (4.0)

```http
GET /api/sync/filemeta?spaceId=&networkId=&sinceSeq=&limit=&full=true
GET /api/sync/filemeta/:id
```

**File bytes cross the wire as plaintext, and each receiver stores them by its own rule.** An instance that
encrypts files at rest ([Encryption at Rest](02a-encryption-at-rest.md#uploaded-files)) decrypts before it sends and
encrypts what it receives; one that does not stores what arrives as it is. The manifest's `size` and `sha256` are
always the plaintext's, so a keyed and a keyless peer compare equal for the same file and never see a change that
is only the encryption. Members of one network need not share a master secret, or have one. A path in a peer's
manifest is resolved inside the receiving space's own directory; one that would leave it is skipped.

The bytes have always moved through the manifest and `/api/files`. From 4.0 the file's **metadata record**
moves too — its description, tags and properties. Its LINKS travel as link records of their own, on the
same channel.

**Before this, a file's metadata did not replicate at all**, so a description written on one instance was
invisible on every other — while the graph already showed the connection, which is two answers to one
question differing by which collection you asked.

**Only the AUTHORED half crosses the wire, and the ingest MERGES rather than replaces.** A file meta record
holds three different kinds of field:

| | |
|---|---|
| **authored** — replicates | What the wire schema declares (`IncomingFileMetaDoc` in `server/src/api/sync/_shared.ts`): its optional keys (e.g. the description and the tags), which are the ones a removal can name, and the identity and order keys `author`, `createdAt`, `updatedAt` and `seq`. A 4.x link array arriving here is REFUSED rather than stripped — this schema is `.strict()` |
| **derived from the local blob, or this instance's own** — never sent, never overwritten | A stored file record's other keys (e.g. the size, the hash, the excerpt, the vector, the processing status, `deletedAt`): whatever the Merkle hash does not see (the inclusion list in `brain/merkle.ts`) and the wire schema does not declare. The rule is the code's; this table does not keep a copy of the list |
| **chunk-only** — the whole record is refused | `parentFileId`, `chunkIndex`, `content` |

A whole-document replace would leave the file reporting the SENDER's size and hash with no vector at all —
findable by neither its own text nor its own name, with nothing having failed. So the write is a `$set` of
the keys that arrived, and **a key the sender omits is left alone rather than cleared — unless the sender
says it removed it.** A peer on an older build sends fewer fields, and reading absence as deletion would let
it erase a description it has never heard of; so absence only counts together with `authoredKeys`.

**`authoredKeys` is how a removal crosses the wire.** Every sender — a push, the `full=true` pages of
`GET /api/sync/filemeta` and `GET /api/sync/filemeta/:id`, a relay too — adds `authoredKeys`, an array of the
authored keys *its version* knows. The set is read out of the wire schema (optional keys, less identity, order
and wire-control keys), so a key added to the schema is covered from that release on. The receiver, in the same
update that `$set`s the keys that arrived, `$unset`s each key that the sender lists, that the receiver also
authors, and that the document lacks; a key the sender does not list is never touched, and a name that is no
authored key (`sha256`, `deletedAt`, anything) is never unset whatever the list says. `authoredKeys` is
consumed on arrival: never stored, never served as stored (a bounded array of at most 64 names of at most 64
characters; more is refused). A copy that loses on its `seq` is not written, removal included. **`tags` is
optional**, since a row whose tags were removed has none. An admin import (a restore) carries no list: an
export is a full record, so every authored key its row lacks is removed; the stray drain removes nothing.

**Older peers.** A receiver before this release refuses a document with a key it does not declare
(`authoredKeys`) or without `tags`, discards it, and still answers `200`. So a push sends `authoredKeys` and
an omitted `tags` only to a peer known to run 5.7.0 or later (a peer whose
reported version is missing or does not parse counts as older); every other peer gets the shape every version
accepts, `tags: []` for a row that has none, and no list. A peer that reports 5.7.0 or later and still
refuses a page (it was rolled back) is offered that page once more in the older shape and is treated as older
until its reported version changes; the fallback is warned once per peer per window. A pull has no such cut:
an older puller strips `authoredKeys` as it strips every key it does not declare, and removes nothing. **So a
removal reaches a peer only when both ends run this release, and one made while a peer ran an older version
reaches it on the file's next edit after the peer upgrades.**

**A chunk sent to `batch-upsert` is REFUSED and reported**, not stripped. A chunk is derived from the blob
and the receiver makes its own, with its own chunker and its own model; stripped, it would land as a FILE
under an id ending in `#0`, carrying another instance's passage text.

**A read spill never syncs, in either direction.** Versions before 5.6.0 kept a `recall` or `similar` answer
too large to return inline as a file at the space root — `_tmp/graph-<uuid>.json` or
`_tmp/results-<uuid>.json` — and it replicated like content and never expired on the receiving peer. Spills
now live outside every space, and exactly that root path is instance-local: it is left out of the manifest
this instance serves and out of the space hash, its bytes are never pulled, and its metadata is dropped
whether it arrives by push or by pull — a pushed one is counted as `skipped`, not refused, so an older peer's
push still succeeds. An older peer keeps offering its spills until it upgrades; this instance drops them, and
its own copies are swept locally, so a mixed network converges without anyone upgrading first.

**A conversion's sidecar never syncs either: each instance converts by its own settings.** Anything under the
root `_converted/` or `_extracted/` (`a/_converted/x` is a user's file) is instance-local, as a read spill is:
it is left out of the manifest, never pulled or pushed, and hashed by no Merkle root. A receiver applies its own
rules to a file it is given, and a pdf, a docx or an epub converts
differently by mode, so a publisher's sidecar is never the receiver's own: a receiver with conversion off
holds no derived text at all. An older peer's offer is ignored without a refusal: the upload door answers
`200 { "ignored": "instance-local" }` and stores nothing (the older sender reads it as delivered and stops),
and a metadata row or a file tombstone for such a path is dropped; each is counted in
`ythril_sync_file_arrivals_total{outcome="ignored_instance_local"}` under its door. The same holds at every door for
the other instance-local paths: a conflict copy, a schema snapshot and a legacy spill. Sidecars a peer
delivered before this release are retired, bytes and row, by the retention sweep.

**A file row at an EQUAL seq can now change one field: its `updatedAt`.** Two instances could hold one file row at the
same `seq` with different `updatedAt` values — a hashed field, so `merkle: true` reported a divergence every cycle, and
an equal-seq arrival was skipped, so nothing ever repaired it. A receiver now adopts the arriving `updatedAt` when all of
this holds: the DELIVERING peer is the author named on both copies, that author is not the receiver, the authored content
is identical (the hash projection, with `updatedAt` and `author` left out), and the two instants differ. A relay's
delivery of somebody else's row never converges — a relay serves its own stored value with the author field intact, and
adopting it would flip the row between two values for ever. Nothing else is written: no `seq` is stamped, `deliveredBy`
is untouched, and no embedding is re-queued.

**So `updatedAt` on `IncomingFileMetaDoc` is now CHECKED, and a bad one is a `400`.** It must be an ISO instant in the
comparable fixed-width form and under 40 characters. It is the one timestamp a peer sends that can change a stored row,
which is why it is the one that is validated; every other family's `updatedAt` arrives with a whole version and is still
`z.string()`.

**A soft-deleted file's row never syncs.** With `softDeleteFileMeta` on, a delete leaves its row flagged
`deletedAt`: local audit state that stamps no `seq` and no `updatedAt`. `GET /api/sync/filemeta` does not page it,
`GET /api/sync/filemeta/:id` answers `404` for it, a push never sends it, and no Merkle root hashes it. The
deletion reaches a peer as the file tombstone below, which the peer applies by **its own** `softDeleteFileMeta`. A
sender from before this release still pushes the flagged row stripped of its flag, which lands live on the
receiver.

**Deletions travel on `/api/sync/file-tombstones`**, as they always have — a deleted file has a file
tombstone rather than a brain one, so the metadata page carries no tombstones of its own. A metadata
arrival that a held file tombstone covers (its `rowSeq` is at or above the arriving `seq`) is counted in the
batch answer's `filemeta.tombstoned`, not stored, and not `rejected`: the sender reads it as delivered. The
counter is additive and appears only when it is above zero; an older receiver never sends it, so read a missing one as zero. See
[File Sync Artifacts](#file-sync-artifacts).

> **Metadata written before 4.0 has no `seq`, and the page cursor is `seq > n`.** So it does not reach a
> peer until the record is next written. `npm run links:convert` stamps the ones already stored —
> idempotent, and safe to run twice.
>
> **The 5.0 boot conversion does NOT stamp them, and that is deliberate.** Startup converts link arrays
> to link records on every instance, but a `seq` is drawn from the instance's own counter: were every
> peer to stamp the same record at its own restart, each would write a different number and each would
> win the last-writer-wins comparison in turn. So the stamp stays on the operator-run script, and a
> container deployment that cannot run it keeps pre-4.0 metadata local until the record is next written.

### Common Query Parameters

| Parameter | Description |
|---|---|
| `spaceId` | Required on space-scoped sync routes. With `networkId`, give the NETWORK's id for the space: an instance that mapped it under another name at join translates it (Q-51) |
| `networkId` | Optional on many pulls, used for policy checks and directional sync |
| `sinceSeq` | Start sequence for incremental pulls: a whole number of 0 or more. Anything else answers `400` |
| `cursor` | Continuation cursor for paged pulls: **opaque — echo the `nextCursor` a page returned, unchanged, and never build, decode, compare or edit one.** One that does not decode answers `400`; when present it wins over `sinceSeq` (so a client may keep its `sinceSeq` constant beside the cursor it echoes) |
| `limit` | Page size, from 1 up to the route's maximum (500 on the record routes, 5000 on tombstones — per type with `sinceSeq` alone, the page's total with `cursor`). A value below 1 reads as 1, a value above the maximum as the maximum, and one that is not a number as the route's default |
| `full=true` | Return full docs instead of `_id`/`seq` stubs on list routes |

### Incremental Collection Pull Example

```http
GET /api/sync/facts?spaceId=general&sinceSeq=0&limit=200&full=true
```

Returns `{ items, nextCursor }`. Use `nextCursor` as `cursor` on the next request until `nextCursor` is `null`.

**Why the cursor is a position and not a seq.** Records keep their author's `seq`, so several records can share one, and a page can end in the middle of such a run. The cursor names the last record served in `(seq, _id)` order, so the next page continues the run; a client that built its own cursor from the last `seq` it saw would skip the rest of it, silently. Pages are ordered by that pair for the same reason — treat the order within one seq as arbitrary but stable. A listing (`full=false`) is ids and seqs only and carries no tombstone stubs.

### Single-Document Pull Example

```http
GET /api/sync/entities/:id?spaceId=general
```

Returns `404` when missing. A document read by id carries the same fields as the same document in a page, and a
document no page serves (a file's chunk) is `404` here too.

### Bulk Push Example

```http
POST /api/sync/batch-upsert?spaceId=general&networkId=net-uuid
```

```json
{
  "facts": [ ... ],
  "entities": [ ... ],
  "edges": [ ... ],
  "chrono": [ ... ],
  "links": [ ... ],
  "filemeta": [ ... ]
}
```

Each array is capped at 500 items; documents past the cap are counted in `rejected` rather than dropped unsaid. Response includes per-family counters for all six families:

```json
{ "status": "ok",
  "facts":    { "inserted": 3, "updated": 1, "forked": 0, "skipped": 12, "forkDepthRefused": 0, "tombstoned": 0, "schemaViolations": 0, "rejected": 0 },
  "entities": { "upserted": 5, "skipped": 2, "tombstoned": 0, "schemaViolations": 0, "rejected": 0 },
  "edges":    { "upserted": 0, "skipped": 0, "tombstoned": 0, "schemaViolations": 0, "duplicateTriplets": 0, "rejected": 0 },
  "chrono":   { "upserted": 0, "skipped": 0, "tombstoned": 0, "schemaViolations": 0, "unknownType": 0, "rejected": 0 },
  "links":    { "upserted": 0, "skipped": 0, "tombstoned": 0, "rejected": 0 },
  "filemeta": { "upserted": 0, "skipped": 0, "rejected": 0 } }
```

`filemeta.tombstoned` is the one counter that is **absent when it is zero** (above, a held file tombstone covered that many arrivals): read a missing one as zero.

**A file's key is one string, whoever spelled the path.** The canonical key of a path is its Unicode NFC form with `/` separators, no leading slash, no empty or `.` segment, and a `..` that stays inside the space collapsed (`a/x/../b` is `a/b`); this instance keys every file row it writes itself by it, and keys what a peer sends (a manifest entry, a tombstone's path, an upload's `?path=`) by the path as it resolves in the space. A file-metadata document whose `_id` is not that key (`a/../b`, `./b`, `a//b`, a decomposed accented name, or a path that leaves the space) counts in `filemeta.rejected` and is not stored, and the receiver's log names the id: send the path's canonical spelling, which is the key every other door uses. A row an older release stored under another spelling keeps that id and is refused the same way by an upgraded peer; see [Upgrading](02b-upgrading.md).

**The counters count the items you sent, as processing them in order would.** A page carrying one `_id` twice is decided copy by copy (an entity at seq 5 then 6 is `upserted: 2`; a fact at seq 9 then 3 is `inserted: 1, skipped: 1`), and only the highest seq is stored. The single-record routes are the same code with one document, so they decide exactly as the batch does.

**A `503` from any push route means the receiver's store could not take the page in time** — every sync POST (the record and tombstone pages, file tombstones, members, votes, change notes, pairing) answers it alike — a write the bound ended (a lock held elsewhere, a stalled socket), a step-down, a dropped connection. The body carries `retryable: true` and words of the receiver's own, and the response a `Retry-After`; hold your watermark and send the page again. **A `500` means a fault that was not one document's and not the store's**, or a seq counter the receiver could not move past what you sent. Re-sending the page is safe and is what the engine does: records that landed come back `skipped`, and a fork that landed comes back as the same fork, because a fork's id is derived from the parent id, the seq and the text. A document the store refuses for what it is (a schema validator, a value it cannot store) is counted in `rejected` and named in the receiver's log, and never fails the page.

**`skipped` is benign and `forkDepthRefused` is not — read the second one.** They were one counter until now,
which is the whole reason this paragraph exists.

| counter | what happened | did the record land? |
|---|---|---|
| `skipped` | the receiver already holds that record at the same `seq` or newer | **nothing was lost** — this is ordinary conflict resolution and is by far the common case |
| `forkDepthRefused` | facts only: content diverged at an identical `seq` and the record's fork chain, or its fan-out (10 forks of one parent, those this request creates counted), is already at its cap, so the incoming version was **discarded** | **no — the record is gone** |
| `rejected` | every family: the records of this request the receiver refused for any reason (schema, past the 500 cap, a non-string `_id`, an implausible `seq`, a store refusal, fork cap, undeclared chrono type) | **no** — subtract it from what you count as delivered |

**A `200` therefore does not mean every record was applied — read `rejected`.** Every family carries it since
5.5: the records of that family in your request that the receiver neither stored nor already held. That is a
document its `Incoming*` schema refused, one past the 500 cap, an implausible `seq`, a document the receiver's store refused, a fact whose fork chain or fan-out is at its cap
(`forkDepthRefused`, which `rejected` includes), and a chrono entry of a type the space does not declare
(`unknownType`, likewise included). Our own sync engine subtracts it from what it reports as pushed and records
the cycle as `partial`, naming the family and the count — so a push the receiver refused is never shown as
`success`. The peer answered, so this does not count as a failed sync with it and never raises its failure count. It does **not** offer those records again: it advances its watermark regardless, because the receiver
would refuse the identical record on every future cycle and holding the watermark back would stall the space
instead. Both ends log it; the receiver's log names the record ids.

A peer on an older build sends no `rejected`; read `forkDepthRefused` then, and treat a missing field as zero
rather than as an error.

### A duplicate relationship is reported, not an error

An edge's identity is its `(from, to, label, fromKind, toKind)` — that combination is uniquely indexed — while an
older edge's `_id` may be random. So when two instances create the same relationship independently there is **one relationship under
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
directions resolve it identically, and it holds for an UPDATE that would move an edge onto a triplet another id
holds as much as for an insert. The receiver logs the ids. A **link** arriving under another id for endpoints
already linked is that same link: it counts as `skipped`.

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
ranking one against the other produces plausible-looking nonsense rather than an error. Facts were the
last type that carried theirs; now none do.

**The same holds when this instance PULLS from you.** A pulled page is accepted by the same rules as a push: every
document is validated against the schema above for its type (a document that fails is refused on its own and the
rest of the page lands), a tombstone this instance holds refuses it, and an equal-seq divergent fact forks within
the caps. A fork is its own record: deleting or expiring the fact it forked from does not remove it, and it is
deleted like any other fact. The one difference is stated in [Sync Protocol → How a pulled page is stored](../sync-protocol.md#how-a-pulled-page-is-stored):
a chrono `type` outside the vocabulary is stored on pull. Until 4.0 a pull kept the sender's vector — and, more
expensively, the sender's `_expireAt`, which the receiving instance's retention sweep then acted on — and until this
release it validated nothing. Both directions drop the same local-only fields, and the serving side leaves them out
of the page altogether, so a sync page is materially smaller than it was. **And the receiver keeps its own:** a
peer's update of a record no longer erases the receiver's vector, its model, `matchedText`, its retention stamps or
its file sync bases — they are carried across the replace, so an update whose embedded text did not change is not
re-embedded and the record stays searchable meanwhile. **Unless the receiver suppresses it:** an arriving record its
own mark, this instance's type schema or this space keeps out of semantic search carries the retention stamps and
`syncBase` only, and holds no vector, model or `matchedText` afterwards — they described content the receiver no
longer embeds, and `matchedText` would keep removed text findable by lexical search. A file's derived passages lose
their vectors with it. Every arrival is also stamped with the peer that delivered it (`deliveredBy`, local to the receiver and never sent on), which is what the [deletion rule](#tombstones) reads.

**The receiver embeds what it accepts, on its own terms.** Every accepted document is queued for embedding
against the receiving instance's own model, at the moment it is written — by push (batch or single route, a new
entity included) and by pull alike. Nothing has to ask for this and there is no flag for it.

**Upgrading: records pulled by an earlier version were never queued.** A record this instance PULLED from a peer before this
release was stored without an embed job and has no vector here. [`POST /api/spaces/:id/reembed`](06-spaces-api.md#re-embed-backfill)
queues every record of a space that has none; run it once per synced space after upgrading.

**The receiver's retention applies to what arrives.** A record that carries no retention stamp of this instance
is stamped by this instance's policy (type schema over space), counted from the record's own `createdAt` — so a
record older than the window is due at once and the sweep deletes it through the normal path, which tombstones
it to peers. A stamp this instance already holds is carried, never recomputed. See
[Sync Protocol → Receiver retention](../sync-protocol.md#receiver-retention-applies-to-arrivals).

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
| `type` | fact | it selects the fact's type schema, so an arriving fact was validated against nothing and missed every type filter |
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

- `GET /api/sync/tombstones?spaceId=general&cursor=<cursor>&limit=5000` returns grouped `{ entities, facts, edges, chrono, links }` tombstones, each ascending by seq, **and `nextCursor`** beside them. The keys are derived from the tombstone types, so a new record kind appears here without a protocol change; a client should read the keys it knows and ignore the rest.
  - **Cursor mode pages by position.** It is one read of every type: `limit` rows (default 1000, max 5000, **the page's total**) in `(seq, _id)` order after the cursor's position, grouped by type. Echo `nextCursor` as `cursor` until it is `null`; the cursor is opaque ([above](#common-query-parameters)). The first request carries the bare-seq cursor of your watermark — the base64url text of the decimal number, for example `base64url("0")` — **together with `sinceSeq` set to the same watermark**: that is the one cursor a client writes, and only for that first request. A server that predates cursor mode ignores `cursor` and reads `sinceSeq`, and answers with no `nextCursor` — which is how a client knows to page it the older way. It pages through any number of tombstones at one seq: equal seqs are legitimate, because an instance relays tombstones issued by several others, and any member's token may name any seq for what it issues.
  - **`sinceSeq` alone is the older mode and is unchanged**: `seq > sinceSeq`, per type, at most `limit` of each (default 1000, max 5000), no `nextCursor`. Page it tie-safe: a full array may hold more at its last seq, so ask next from the lowest last seq among the full arrays **minus one**, and skip what you already applied by `(type, _id)`. Moving to the last seq instead loses every tombstone of a run that straddles the page. A full array that is all one seq cannot be paged past by seq: stop, and hold your watermark below it. Use cursor mode to page past it.
- `POST /api/sync/tombstones` accepts `{ tombstones: [...] }`, at most 5000 per request (`400` above), and answers `200 { applied, refused, declined }`.
  - Each element is checked on its own: one that is malformed (no `type`, a missing field) or whose seq the counter cannot carry is refused alone, counted in `refused`, and the rest applies. `refused` and `declined` are additive — an older receiver answers `{ applied }` only, and a receiver omits `declined` when it is zero, so read a missing one as zero. A refusal is by shape, so re-sending it changes nothing; advance past it.
  - **`declined` counts the elements the receiver judged it may not apply** (see the authority below). It is a part of `applied`, not an addition to it: `applied` is what passed the shape check. A declined element is not stored and would be declined again, so advance past it as past a refusal; a sender that does read it logs a non-zero count, because on a directional network it means the deletion did not reach a record you expected it to.
  - An element of a `type` the receiver does not know answers `400 { error: 'Invalid tombstone format' }` and nothing of the page is applied: hold your watermark and re-send after the receiver upgrades.
  - A tombstone is applied to the space your request names (after the network alias), never to the `spaceId` in its body. **Who may delete what** is one rule with two grounds, and a tombstone needs either. **Your own**: your peer identity delivered it, issued it, and the record is one you authored (or one with no author, which legacy data lacks). **Your upstream's**, on a pub/sub or tree network only: when the receiver's direct upstream — the publisher it subscribes to, or its parent — delivers a tombstone, it deletes the record that this receiver stored as delivered by that upstream, **whoever wrote it**; the receiver stores who delivered each record, and that is what it reads. A receiver's own records are never deletable by its upstream, nor are records that reached it through another peer. A tombstone that meets neither ground is declined and **not stored**, so a forged tombstone cannot block the real author's record either. Symmetrically, a record you push as its author with your own peer token is not refused by a tombstone another instance issued for its id; a record whose author you only claim still is. A tombstone for a record the receiver does not hold is stored and deletes nothing. The full rule, with its cost, is in [Sync Protocol → Tombstone deletion authorisation](../sync-protocol.md#tombstone-deletion-authorisation).
  - **A deletion your peer's retention sweep issues is a deletion:** it applies on the upstream ground to what an upstream relayed, and on the issuer ground to what the sweeping instance wrote.
  - The receiver's counter is moved past the highest admitted seq before it answers; a counter that could not move answers `500`, and you should re-send. A store that could not take the page in time answers a retryable `503`, as every push route does.

**Mixed versions.** The upstream ground needs no new field on the wire: it is decided from who delivered the page and what the receiver stored. A receiver that predates it applies only the issuer's own ground, so below a publisher or parent on an older build, a deletion of a record the publisher relayed from another author is declined without a trace (it counts as served, and the sender may prune it). An instance that upgrades **re-reads its upstream's tombstones once**, from the beginning and per space, so it picks up what it declined meanwhile, as far as the upstream still holds them ([Upgrading](02b-upgrading.md)); upgrade the root of a tree before the nodes below it. `declined` is read as zero when absent, and a puller on an older build reads tombstones exactly as before.

**The `sinceSeq` you send is recorded.** (With `cursor`, the cursor's seq **minus one** is: everything below it was delivered, and part of the run at it may not have been.) The serving instance stores it as `lastSeqServed` for your peer identity and prunes tombstones that every member has pulled past — that is the only retention bound on the collection, because an age-based one would let a long-absent peer resurrect a deleted record. Two consequences for an integrator:

- **Send your real watermark, and never a value higher than what you have applied.** Claiming a position you have not reached lets the other side drop tombstones you still need.
  - **And a watermark shared across several transfers may only reach where ALL of them are complete.** A cycle that fetches tombstones plus four collections under one `sinceSeq` must limit its next `sinceSeq` to the lowest position among the transfers that stopped early — a non-`2xx`, or a page cap. Taking the maximum instead claims a position the stopped transfer never reached, and its unserved records then sit behind your watermark permanently while every later cycle looks successful. Our own engine had this defect until 3.2.0.
- **A peer that never pulls tombstones blocks pruning for its spaces** — deliberately, since "has not pulled" and "has caught up" must not look alike.

**A page never gets ahead of a write that has not finished.** Every seq-paged route (the five record
families, `filemeta` and `tombstones`) serves only seqs below the lowest seq this instance has allocated and
not yet committed. A write takes its seq a moment before it stores the record, so without that horizon a page
could hand you a later seq while an earlier one was still being written — and a watermark moved to the later
seq would never come back for the earlier record. So a page never names a seq that a later commit could land
below, and a page that seems shorter than expected during heavy writes is the horizon holding the rest
back for a cycle, not a gap. The push side applies the same horizon to what it sends.

**When to move your watermark.** Move it to the highest seq you received **only when the pull finished** — `nextCursor` came back `null`. On a stop (an error, a page cap, a peer that went away) move it to the highest seq **minus one**: records share seqs, so a stop may have taken part of the run at the last seq and not the rest, and a watermark AT that seq puts the rest behind it for good. Re-reading the run next cycle is harmless; records you already hold are idempotent. The highest seq is taken among the documents the peer itself authored, never among the ones it relayed from a third instance (whose seqs are that instance's clock), and never past the point every transfer in the cycle is complete through (above). What no watermark can promise: a record that arrives at the peer later with a seq at or below the one you already moved past — the watermark is one number over clocks that are not one clock.

**A write that stalls holds the horizon for a bounded time, never for good.** Every database operation issued
while a write holds its seq is bounded (`YTHRIL_WRITE_TIMEOUT_MS` per operation, `YTHRIL_HOLD_DEADLINE_MS` for the
whole hold — see [Hosting](02-hosting.md)), and the bound ends the write on the server FIRST (its own deadline, with a client backstop 500 ms after it that kills the server operation and sees it gone before answering), so the horizon is
released only once the server operation is gone (its own deadline has passed, or the backstop has ended it), and the page serves what committed above it. What you see while one stalls: pages
from that space stop short of the stalled seq for at most the hold deadline, then continue. The promise above
still holds throughout, because a hold is released only once its write can no longer land — a transaction whose commit
answer is lost is read back while the hold is still held. On the serving instance the stall shows as the gauge
`ythril_seq_horizon_oldest_hold_seconds` and a `seq horizon held …` line in its log.

### File Sync Artifacts

- `GET /api/sync/manifest?spaceId=general` returns file digest metadata for delta detection. The answer also names `spaceId`, the local id the responder resolved the request to, which a peer uses for the file transfers that follow.
- `GET /api/sync/file-tombstones?spaceId=general&cursor=<cursor>&since=<ISO>` returns file delete tombstones, each
  `{ _id, spaceId, path, deletedAt, issuer?, rowSeq? }`: `issuer` is the instance whose act deleted the file and
  `rowSeq` the seq of the file record that act deleted, the version it erased (neither carries content, and an older
  server sends neither). **With `cursor` it pages**: one page in order of this server's own position for each
  tombstone, and `{ tombstones, nextCursor }` where `nextCursor` is opaque, echoed back as `cursor`, and `null` on
  the last page; a `cursor` it cannot read answers `400` (`cursor must be a cursor a previous page of this route
  returned`), and an empty one reads as none. A client does not build a cursor beyond the opening one its first
  request carries: the sync engine opens with the start of time, `1970-01-01T00:00:00.000Z`, in the encoded form
  `MTk3MC0wMS0wMVQwMDowMDowMC4wMDBa`, which a server with the paged mode reads as "from the beginning" (an empty
  `cursor` is NOT that, it reads as none and answers the legacy way). After that a client only echoes `nextCursor` ([why it is a position](../sync-protocol.md#lastfiletombstoneackedat--the-same-bound-for-file-tombstones-from-acknowledgement)).
  **Without `cursor` it answers as it always did**, in one answer cut at a fixed ceiling, with no `nextCursor`;
  a client that never sends one cannot read past that ceiling, and a client that gets a full answer with no
  `nextCursor` from an older server should treat it as possibly cut. **The sync engine deliberately omits `since`**: a file tombstone
  carries its original `deletedAt` and can be relayed onward long afterwards, so filtering by it would skip an older
  deletion arriving late and the file would stay. Use it only if you can tolerate that.
- `POST /api/sync/file-tombstones` applies file delete tombstones (`{ spaceId, tombstones: [...] }`), at most as many
  per request as `POST /api/sync/tombstones` takes (`400` above); send them in pages. It answers
  `200 { applied, refused?, declined? }`: `applied` is the elements that passed the shape check, `refused` those
  thrown away for their shape (a path that is not a safe relative path, an id or `deletedAt` that is not valid),
  `declined` those the receiver judged it may not apply under the [deletion authority](../sync-protocol.md#tombstone-deletion-authorisation)
  (part of `applied`). `refused` and `declined` are omitted when zero, so an older receiver's `{ applied }` reads
  alike. **A tombstone is applied only when its authority holds** (the same two grounds as a record's, with the
  file's record as the target) **and only to the version it names**: a file row whose seq is above `rowSeq` is a
  re-creation made after the deletion and is kept. **A row that arriving bytes created has no author for this purpose**:
  when a peer delivers a file's bytes before its metadata, the receiver's row is a placeholder (seq 0, authored only by
  the peer that delivered the bytes), and the file's origin deleting it is applied, not declined. A row anybody authored
  (metadata at a seq above 0) is protected from another peer's tombstone as before. An element without `issuer` (an older
  peer's) is read as issued by the peer that sent it. An id the receiver already holds is not applied again.
  **Your `200` is an acknowledgement, and no more than that.** The sender records the newest position in the pages
  you answered `200` to and eventually drops its own copies below the minimum across all members — so answer `200` only
  once the tombstones are handled, applied or judged: a declined one (a file row somebody authored, never the placeholder
  that arriving bytes created) will be declined again, so the sender may stop sending it, and `{ applied: 0 }` is a valid acknowledgement for a page whose every element was already held. A
  non-2xx or a timeout means the sender keeps its copies, which is the safe direction. (It used to read
  *"durably recorded"*; a receiver that applies a deletion but keeps no copy, because it has no one to pass it on
  to, is correct.)
- **Peer arrivals against a held file tombstone.** An instance that holds a file tombstone for a path does not take
  the erased file back from a peer: metadata whose `seq` is at or below the tombstone's `rowSeq` is counted in
  `filemeta.tombstoned` (a higher `seq` is a newer version and is stored), and **bytes a peer uploads** to
  `POST /api/files/:spaceId` for that path, whose hash is the erased content's, are answered `200 { tombstoned: true }`
  and not stored. **A delete counts from the moment its bytes are gone, not from its publication**: a delete writes its
  tombstone first and publishes it once the file is removed, and in between it shadows exactly as a published one does —
  by version for metadata, by content hash for bytes, at the metadata writer, the manifest download (re-asked right
  before the bytes are written) and both byte doors. A delete whose file is still there shadows nothing; one whose path
  cannot be looked at is neither: the byte door answers a retryable `503` (the sender does not remember it) and the
  manifest download leaves the path for the next cycle. A chunked upload is decided before its target is written, and a peer that promises the whole file's hash (`x-expected-sha256`, below) is asked at its FIRST range, by path and promised hash, so a shadowed file is turned away (`200 { "tombstoned": true }`) before any range is staged; the last range's check of the staged bytes stays the authoritative one. A path a
  peer supplies is resolved before it is looked up (`x/../file` is `file`). A user's own upload is never refused, and a
  tombstone held from before the upgrade carries no `rowSeq` and shadows nothing. See
  [Files API](05-files-api.md#delete-a-file).
- **A peer's bytes are recorded by one function, whichever door they came through.** The upload door (`POST /api/files/:spaceId`
  with a peer token, single or chunked) and the manifest pull both record an arrival the same way: the row (size and hash,
  the peer as author of a row new here, no seq of its own), then the file is processed by THIS instance's own rules (a
  document is queued for conversion, an image, audio or video file for its media pipeline, anything it does not analyse
  is marked `skipped`), and **nothing is announced**: no `file.created` webhook and no live-view event, as for a synced
  record. A changed version replaces the previous version's passages. A peer's metadata in the upload body is ignored.
  A pull checks the space quota **before** it fetches a body (on the size the manifest declares), and a pull whose record
  write fails removes the bytes it wrote (it keeps them when the database did not answer) and redoes the file next cycle;
  a file already held with no row is taken back and delivered again, and one whose row names other bytes than the disk's
  or that never went through processing is brought up to date, a few per space per cycle.
  `ythril_sync_file_arrivals_total{door,outcome}` counts them ([metrics](11-setup-api.md)).
- **Pushing a file above the receiver's single-body limit goes through the chunked door.** The non-final `202` answer of
  `POST /api/files/:spaceId` with `Content-Range` carries `maxBodyBytes` besides `path` and `received`: the single-body
  limit this door enforces (`maxUploadBodyBytes`), so a sender sizes its ranges under it. A sender may send
  **`x-expected-sha256`**, the SHA-256 (64 hex digits) of the whole file, on any range: the door binds it to the assembly
  and refuses a different one before the rename with `422`, storing nothing and dropping the staged ranges (a malformed
  value is `400`, never read as absent). The sync engine sends it on every range, and remembers a refusal of the bytes
  (`400`/`422`) per peer, path and hash, so the same bytes are not sent whole every cycle.
- **A pull streams.** The sync engine reads a body through one hash tap into a staged temp file, stopped at the size the
  manifest declared and verified in the stream's last step; the staged file is renamed into place only after the deletion
  re-check and, under the path lock, a re-check that the disk still holds what the pull decided on (otherwise the bytes
  land as a conflict copy). A body that is too long, too short or not the declared hash stores nothing.

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

**A root may come from leaves kept since an earlier call.** The instance keeps each collection's leaves while
nothing has written to it, and re-reads only a collection that was written; the file manifest is walked on
every call (unchanged bytes are not re-hashed). A call with no write and no file change in between returns the
stored root as it was, so `computedAt` is when THIS root was computed — not necessarily now. A kept root is the
root a full recompute gives, by construction.

What is excluded follows one rule, worth knowing if you are comparing roots yourself: **a field that is hashed
must replicate, as it is.** The local-only fields are out: `embedding`, `embeddingModel` and `matchedText` are
derived by the local model, so peers running different models legitimately differ, and the retention stamps
(`_expireAt`, `_contentExpireAt`) the sync base and `deliveredBy` (which peer delivered the record, read by the deletion rule) are each instance's own — a peer's stamp is never adopted,
in either direction, because the sweep that acts on it would then be following another operator's policy.
`spaceId` is out too: it crosses the wire and the receiver rewrites it to its own id for the space, which under a
`spaceMap` alias is not the sender's. Everything else is hashed, and everything else crosses the wire — a field
in neither category means two peers can never agree about identical content. File leaves hash the file's
SHA-256, and a file that never leaves an instance — a conflict copy, a schema snapshot, a legacy read spill, a
conversion's sidecar — is not hashed at all, record or bytes; nor is a soft-deleted file's row (`deletedAt`, local
audit state). A file's processing status never touches its hashed `updatedAt`. The check is advisory: a root
mismatch is reported as `MERKLE_DIVERGENCE`, it does not block sync.

**Mixed versions:** a root from a version before these rules (which hashed `spaceId`, the instance-local files, a
conversion's sidecar and a soft-deleted row) never equals one from a version after it, so a `merkle: true` network
whose members run both reports `MERKLE_DIVERGENCE` for every space until all of them have upgraded. A file
whose processing stamped `updatedAt` before this release keeps a differing `updatedAt` at an equal seq, and so a
divergence, until its next authored edit.

### Gossip Endpoints

- `GET /api/sync/networks/:networkId/members` returns current member view (sensitive fields stripped). On a **club** it also answers `removed: [{ instanceId, removedAt }]`, and each member carries `admittedAt`: a club is a mesh (`Q-135`), so every member learns the others from this roster during the gossip it already runs each cycle. A member it does not know becomes an **introduction** here (see `introductions` on [Get Network](08-networks-api.md#get-network)); a removal newer than a member's `admittedAt` removes that member here too and travels on. The later of an admission and a removal wins, wherever it arrives from. Pub/sub and braintree do not mesh by design. Closed and democratic networks mesh on their own votes: a passed join round introduces, the member that admitted this instance introduces, and any other roster entry waits for the operator's OK (`needsApproval`); `removed` is not answered on them, because a passed remove round already removes everywhere (`Q-154`).
- `POST /api/sync/networks/:networkId/pair` `{ instanceId, label, token }` — **no credential**: the caller has none here yet. Sent by the member with the LOWER instance id to one its peers introduced, handing over a token it minted for it. Answered only for an instance this instance's own peers introduced (`403` otherwise, `409` when it is already a member, `404` when the network is not a club here), and the caller is proven by a call back to the address that introduction vouched for — never one the request names. `200 { status: "paired" }` once both sides hold a token for each other; `502` when the call back failed, with why. Rate-limited like the invite handshake.
- `POST /api/sync/networks/:networkId/pair/confirm` `{ instanceId, token }` — that call back, authenticated with the token the opener handed over. Only the exact token minted for that pairing is accepted (`403` otherwise). A failed pairing is retried by the opener after half a minute, the wait doubling on each failure up to five minutes — members learn of a passed join at about the same moment, so a first call refused as not yet introduced is usually a race — and its reason is kept on the introduction.
- `POST /api/sync/networks/:networkId/members` accepts member updates for gossip propagation. The `self` record carries the sender's `signingPublicKey`, which the receiver pins trust-on-first-use for verifying that member's signed votes, and `spaces`, the network's spaces named by their NETWORK ids, plus `spaceNames` (network id → the sender's local name, where they differ; sent only downstream). The receiver uses `spaceNames` from its upstream to record an alias for a space it already holds under the sender's old local name, audited as `network.space_alias.heal`, never for a space it dismissed. It considers `spaces` only from its upstream (publisher, tree parent) and adopts only when the token that joined the network there could have joined each one; the rest wait as pending for its operator, and a same-id local space always waits — see [Networks API → Pending Spaces](08-networks-api.md#pending-spaces) and [Sync Protocol → Gossip phase](../sync-protocol.md#gossip-phase).
- `GET /api/sync/meta?spaceId=&networkId=` returns `{ meta }` — what the network governs of the space, never the server's own counters — under the same admission as the space's records. For a space in several networks it is this instance's own definitions plus the named network's layer only, never another network's (F-39.2). A downstream instance merges it additively each cycle; see [Sync Protocol → Schema phase](../sync-protocol.md#schema-phase-pubsub-and-braintree).
- `GET /api/sync/networks/:networkId/votes` returns open rounds.
- `POST /api/sync/networks/:networkId/votes/:roundId` relays `{ vote: "yes" | "veto", instanceId, sig?, bsig?, castAt? }`. A cast bearing a valid signature is accepted from any relaying peer: `bsig` (Ed25519 over `ythril-vote:v2|network|round|subject|voter|vote|type|spaceId|networkSpaceId|wipeTypes`, checked against THIS instance's copy of the round) when present, otherwise `sig` (over `ythril-vote:v1|network|round|subject|voter|vote`) — and a cast without `bsig` from a voter known to run 5.6.0 or later is refused (see [Signed vote casts](../sync-protocol.md#signed-vote-casts)); an unsigned cast is accepted only directly from its own voter. Returns `403` if the cast is rejected. See [Sync Protocol → Signed vote casts](../sync-protocol.md).

If this instance has been ejected from a network, `/api/sync/networks/:networkId/*` returns `401` with `{ "error": "ejected" }`.

### Warm-Up Endpoint

```http
POST /api/sync/warm
```

```json
{ "networkId": "net-uuid", "spaces": ["general"] }
```

Preloads embedding model and collection handles before a full sync cycle. `spaces` names spaces by the
NETWORK's ids, like every sync route; each is resolved to this instance's space, and one the network does not
carry here is ignored. A peer token that is not a member of `networkId` gets the same `404` as a network that
does not exist.

**Response** `200`:

```json
{ "status": "ready" }
```

---

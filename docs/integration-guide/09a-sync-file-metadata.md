# File Metadata Replication

> Part of the [Ythril Integration Guide](../integration-guide.md), and of the [Sync API](09-sync-api.md#sync-api).

## A file's METADATA replicates; the bytes travel separately (4.0)

```http
GET /api/sync/filemeta?spaceId=&networkId=&afterPos=&cursor=&limit=&full=true
GET /api/sync/filemeta/:id?spaceId=&networkId=
```

`:id` is the file's **path** (URL-encoded: a `/` in it is `%2F`), and `spaceId` is required here as on the pages; a chunk
or a soft-deleted file is `404`. The `full=true` pages are also what [`file_stamp_report`](06-spaces-api.md) reads to
compare a peer's author, seq, creation time and `sha256` with this instance's rows.

**File bytes cross the wire as plaintext, and each receiver stores them by its own rule.** An instance that
encrypts files at rest ([Encryption at Rest](02a-encryption-at-rest.md#uploaded-files)) decrypts before it sends and
encrypts what it receives; one that does not stores what arrives as it is. The manifest's `size` and `sha256` are
always the plaintext's, so a keyed and a keyless peer compare equal for the same file and never see a change that
is only the encryption. Members of one network need not share a master secret, or have one. A path in a peer's
manifest is resolved inside the receiving space's own directory; one that would leave it is skipped.

**A manifest names each file by its key, whatever spelling the disk keeps.** An entry's `path` is the file's canonical key
(Unicode NFC, `/` separators; see the key rule below), so a file stored under a decomposed name (a macOS-written `é` as `e` and a
combining accent) is advertised under its composed name and hashes into the space's Merkle root as the same file whichever
Unicode form either instance's disk keeps. The entry has exactly four keys (`path`, `sha256`, `size`, `modifiedAt`); where an
instance keeps the file on its own disk is never sent. The byte route (`GET /api/files/:spaceId?path=<key>`) finds a file held under
another spelling of the key it is asked for, so what the manifest advertises can always be fetched. Two spellings of one key on one
disk are one entry (the one that is the key, else the smallest), and the instance says so once per window.

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

**A drifted row is delivered again by a re-read, not by the ordinary pull.** The ordinary pull asks from the receive
watermark, and a row that drifted is behind it. With `merkle: true`, a check that finds the roots differ makes the next
cycle ask the same peer for `GET /api/sync/filemeta?afterPos=0` and page to the end, through the same accept; it has its
own cursor and never moves the receive watermark. A peer serving the file rows already serves everything this needs.

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
counter is additive and appears only when it is above zero; an older receiver never sends it, so read a missing one as zero.
**A metadata arrival at the seq the receiver holds, with other authored content, follows the tie every forking kind follows** (the lower hash of the row's authored half is the row; [Files at an equal seq](../sync-protocol.md#files-at-an-equal-seq-q-426)). When the arriving copy is the lower, the receiver replaces its row at that seq, keeps what it displaced as a metadata conflict of its own (`GET /api/conflicts`, `kind: "metadata"`) and counts the arrival `filemeta.converged`; when it is the higher, nothing is written and the arrival is counted `filemeta.skipped`, so a sender cannot tell the two from "already current" and does not need to: the receiver is the one that decides its own copy. A file never forks, and nothing is refused (`rejected`) for it.
**A file-metadata document's `_id` and `path` are at most 4096 characters** (the bound a file tombstone's `path` has too); a document past it is refused alone, counted `rejected`, and the rest of the page is stored.
**A path the receiver cannot look at never fails the page.** When a pending delete's path cannot be looked at on the receiver's disk, the
receiver decides a file's metadata from its stored row instead (no live row: it is `tombstoned`; a live row at the delete's version or
above: the usual `skipped`), the other documents of the page are stored, and the answer is a `200`; the byte door's retryable `503` is
for that one path's bytes only. See [File Sync Artifacts](09-sync-api.md#file-sync-artifacts).

> **Metadata written before 4.0 has no `seq`, and the page cursor is `seq > n`.** So it does not reach a
> peer until the record is next written. `npm run links:convert` stamps the ones already stored —
> idempotent, and safe to run twice.
>
> **The 5.0 boot conversion does NOT stamp them, and that is deliberate.** Startup converts link arrays
> to link records on every instance, but a `seq` is drawn from the instance's own counter: were every
> peer to stamp the same record at its own restart, each would write a different number and each would
> win the last-writer-wins comparison in turn. So the stamp stays on the operator-run script, and a
> container deployment that cannot run it keeps pre-4.0 metadata local until the record is next written.

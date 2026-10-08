# 06 — A soft-deleted file's row and a conversion's sidecar stay on the instance that made them

**Status:** accepted, 2026-10-08 · **Scope:** what a file's sync carries: the `deletedAt` audit flag of `softDeleteFileMeta`, and the
`_converted/` and `_extracted/` sidecars of the conversion pipeline

## Context

A file travels as bytes, as its authored metadata, and as a tombstone when it is deleted. Two things sat half on the wire
and half off it, and each produced a defect that nothing reported.

**The audit flag.** With `softDeleteFileMeta` on, a delete flags the row `deletedAt` instead of removing it. That flag
took a seq "so a peer sees it", and a peer never saw it: `deletedAt` is not a wire key, so the row went out stripped of
it and landed LIVE on the receiver, where its seq outranked the tombstone's `rowSeq` and retired the tombstone — the
deleted file came back on a third peer. Carrying the flag on the wire instead was rejected: a flagged row would always
out-seq the tombstone it travels beside, it would be a deletion through the metadata door, which the deletion authority
never judges, and it would impose the sender's setting on a receiver.

**The sidecars.** A converted document's Markdown and extracted images were written by each instance's own pipeline and
also replicated as ordinary files. A receiver converts by its own mode and models (a pdf, a docx and an epub differ by
mode), so the publisher's sidecar was never the receiver's: it arrived as a conflict copy of the receiver's own
conversion, or the receiver's was pushed over the publisher's. And because the pull recorded a row for what it fetched but
queued no processing, a pulled document was never converted at all.

## Decision

- **`deletedAt` is local state.** It stamps no seq and no `updatedAt`, a flagged row is never offered on any wire and is
  never hashed (one live-row filter answers it everywhere), and the deletion reaches peers only as the file tombstone, which each applies by its own
  `softDeleteFileMeta`. A restore keeps the flag its backup row carried.
- **A sidecar is instance-local**, in the one predicate that already kept conflict copies and schema snapshots at home
  (`isInstanceLocalFile`): never in the manifest, never pushed or pulled, never hashed, and a peer's offer of one — bytes,
  metadata row or tombstone — is ignored, the byte door answering `200 { "ignored": "instance-local" }` so an older
  sender records a base and stops. Each instance converts a file by its own configuration, and a receiver with conversion
  off holds no derived text.
- **A file's arrival is recorded by one function** (`recordArrivedBytes`) for the upload door and the manifest pull: the
  prior row is read before any write, the row is recorded, and the file is dispatched by this instance's rules.

## Consequences

- A `merkle: true` network of mixed versions reports `MERKLE_DIVERGENCE` until every member upgrades, because an older
  member still hashes sidecars and flagged rows. The upgrade notes say so.
- An older sender still pushes a flagged row stripped of its flag, which lands live, until it upgrades; it cannot be told
  apart from a re-creation.
- Peers' documents are converted by the receiver's own pipeline, an external assist model included where the receiver has
  consented, and a backlog is worked off over sync cycles.
- **The reversal to prevent:** putting `deletedAt` on the wire "so the deletion is visible", or letting sidecars travel
  "so the receiver need not convert". Each brings back a row that outranks its own tombstone, or a conversion that is
  not the receiver's.

## Where the detail lives

- `server/src/files/live-file-row.ts` and `server/src/files/file-meta.ts` — the live-row filter and the local flag.
- `server/src/sync/file-conflict.ts` — `isInstanceLocalFile`, the one predicate every door asks.
- `server/src/files/bytes-arrived.ts` — the one arrival function.
- `docs/sync-protocol.md` and `docs/integration-guide/09-sync-api.md` — the wire contract; `docs/integration-guide/02b-upgrading.md` — mixed versions.
- `testing/standalone/a-soft-deleted-file-crosses-as-its-tombstone-db.test.js` and
  `testing/standalone/a-pulled-file-is-recorded-and-processed-db.test.js` — both rules against seeded stores.

# 21 — A file whose bytes are gone is removed here only, after evidence; an explicit delete keeps its tombstone

**Status:** accepted, 2026-11-11 · **Scope:** a live top-level file record whose bytes are not on this instance's disk (an "orphan"): the absent-bytes sweep, `bytesAbsentSince`, the `files` count and `filesAwaitingBytes`, the change-feed `reason: "bytes_lost"`; the explicit delete (REST, MCP `delete_file`) is unchanged

## Context

A file record whose bytes were lost (removed outside Ythril, a restore that brought records without bytes, a volume that was not mounted) is counted and cannot be listed, so a person cannot find it to delete it. Until now the record TTL sweep completed such an orphan by writing a tombstone, and the media worker removed a record whose source was gone. Both were wrong in the same way:

- **A tombstone is an order to every peer.** A tombstone for bytes this disk lost deleted the file on peers that still held it, so the one copy that survived was removed by the instance that lost its own. Writing one "because the bytes are gone here" decides for the whole network from one disk's state.
- **"No bytes here" is not evidence of a lost file.** It is also what a disk that is not mounted, a restore, a metadata-first arrival (bytes still coming) and a move in progress look like. Acting on the absence alone, by age or by a worker's reconcile, removes records that were about to be whole.
- **A count that includes what cannot be served is wrong for every reader.** The `files` number said a file existed that could not be listed, read or delivered.

The owner's ruling of 2026-11-11 was "remove meta with the file".

## Decision

- **The record goes with its bytes, on this instance only.** No tombstone, no webhook, no live event: the instance retires the row (a feed marker, or the soft-delete flag, carrying `retiredBy: "bytes-lost"`) and the change feed says `{ deleted: true, reason: "bytes_lost" }`. A peer that still holds the file delivers its bytes again, as file sync does for any file this side lacks, and the record returns. Links to the path stay (ADR 05, D-31): a removal that is no deletion of the file does not take what people linked to it.
- **It goes only after evidence, and the question is one pure function.** The sweep notes the day the bytes were first found missing (`bytesAbsentSince`, a local field, never on the wire) and removes a record in a LATER pass when the wait is over (1 day for a record with a `sha256`, 30 days without one, and 30 days for every record of a space restored or imported within the last 30 days) and every network member this instance pulls the space from has completed a file sync, read after the note, that did not name the path. 30 days after the note the requirement for peers ends and nothing else does. A path that cannot be looked at (an error or a time bound) is never noted or removed, and a pass that found nothing present, or more than half of the space's records absent (per top-level folder: all absent and the folder gone) holds everything, because that is a disk that is not mounted.
- **It holds what is not an orphan.** A move still owed (ADR 09: `moveIsOwed` and `pathsCarriedByOwedMoves` are asked first), a pending or published file tombstone at the path, a space that is not taking writes and an open chunked upload each hold the record, however old the note.
- **An explicit delete is unchanged and keeps its tombstone.** A person's delete is the person's own act and goes to peers by the rules of ADR 05. Only the sweep's removal is this instance's alone.
- **The media worker no longer removes a record whose source is gone.** It drops its job: removing a record is the sweep's decision, made on evidence, not a side effect of a queue.
- **The `files` count leaves the record out; `filesAwaitingBytes` counts it**, on REST stats, MCP `space_stats`, `space_meta` and the completeness facts alike.

## Consequences

- **A removal is irreversible**, and a record no peer holds bytes for may be offered back by the Merkle re-read, wait again and be removed again, audited each time (`file.absent_bytes.sweep`).
- **A network with a silent member never reaches the evidence** and waits the 30 days: the ceiling bounds the wait, it does not skip the other holds.
- **A rollback is harmless**: an older build ignores `bytesAbsentSince`, `absentBytesScan` and `filesRestoredAt`; what was removed stays removed.
- **This is the reversal to prevent:** writing a tombstone for bytes lost on one disk; deciding by age or by "no bytes here" without the evidence of peers and the holds; letting the media worker (or any queue) remove a record; or counting such a record in `files`, which tells a reader a file exists that nothing can serve.

## Where the detail lives

- `server/src/files/absent-bytes-sweep.ts` — the sweep, `absentRowIsDue` (the one predicate), the constants and the holds; `server/src/files/bytes-wait.ts` — the 30-day wait; `server/src/sync/file-legs.ts` — the evidence of peers' file syncs.
- `docs/integration-guide/05-files-api.md` — the contract; `docs/integration-guide/11-setup-api.md` — the step and its metrics; `docs/integration-guide/13-audit-log-api.md` — `file.absent_bytes.sweep`; `docs/integration-guide/02b-upgrading.md` — the irreversible notice.
- `testing/standalone/an-absent-bytes-row-is-due-by-one-predicate.test.js` — the whole truth table; `testing/standalone/the-absent-bytes-sweep-removes-only-real-orphans-db.test.js` — what is and is not removed.

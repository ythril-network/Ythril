# 09 — A move the instance began is the instance's to finish, and a destination the tree refuses is `409`

**Status:** accepted, 2026-10-13; amended 2026-10-14: a move never replaces anything · **Scope:** a file or directory move (`PATCH /api/files/:spaceId`, `POST /api/move_file`,
MCP `move_file`) and the doors that place bytes or a directory at a caller's path (`mkdir`, upload, chunked upload,
`write_file`, `create_dir`)

## Context

A move carries the bytes first and the records after, and a failure between the two (the store paused, a restart) leaves
the file at one path and its records at the other. Three things made that worse than a retry away:

- **Whether anything finished it depended on the caller.** The request that began the move answered `503`; a client that
  gave up, a script that went on, or a sync peer's rename left the file listed where it no longer is.
- **Three paths forgot or destroyed it.** The sweep that clears move markers cleared an *owed* move's marker by its age
  alone, and never asked whether the records were still at the old path. The media worker, finding no bytes at the old
  path once its hold had lapsed, treated the file as deleted and removed the records the move still owed. And the move's
  own last step swallowed a failure of the records and forgot the marker, so the door answered success with the records
  still at the old path.
- **An act could remove bytes with no record that it did.** The tombstone that tells peers a path is gone was written
  first, but a failure of that write that was not the store's was swallowed, so bytes could move or be deleted with no
  tombstone and come back from a peer.

Separately, nothing looked at a destination's ancestors. A move, a `mkdir`, an upload or a `write_file` whose path runs
through a regular file failed at the filesystem, and each door said so in its own words: REST a bare `500`, MCP a `400`
carrying the server's absolute data path. The obvious fix, a `400`, is the wrong one: a sync sender reads `400` and `422`
as "refused about the bytes" and stops re-sending them until their hash changes, and this refusal is about the
receiver's **tree**, which can change.

## Decision

- **Whether a move is owed is one question, asked by everything that could forget it.** A move is owed when its marker is
  present, its bytes are at the destination and not at the source, something of the file (a record, a link or a queued
  job) is still at the source, and the bytes at the destination are the ones the move carried. Every remover of a marker
  and the media worker's "source is gone" reconcile ask it; none decides by age or by "no bytes here".
- **The instance finishes the moves it began, in housekeeping, as its own step after the settle** — not inside the settle
  and not in the worker. It takes the same single-flight lock as the request's retry, so the two never interleave, runs
  under the per-space walk and its bound, and works within a budget per pass. A move that keeps failing backs off and
  is, after a bounded number of attempts, **stranded**: the marker is kept, the reporter says so once per window and a
  gauge counts it. Nothing is deleted and nothing loops. A move housekeeping finishes is audited, counted and announced
  to webhook subscribers once, as the request's own completion would have been.
- **Identity fails closed, for a file.** If the bytes at the destination cannot be shown to be the moved bytes (the size and
  modification time the marker recorded), the move is not owed: the marker is kept as the operator's signal and nothing at
  the destination is overwritten. **A directory carries no identity**, so a directory move is judged on the other facts
  (the marker, bytes at the destination and none at the source, something of it still at the source), and what protects what
  stands at its destination is the refusal made before the move (`destination_exists`); a record of another file met after
  the bytes moved is `409` `destination_held_after_move`, and the move stays owed.
- **An act that removes bytes records its tombstone first or does not begin.** A move and both delete doors (and the
  retention sweep's delete, which goes through the same cascade) refuse before any byte goes when the tombstone cannot be
  written: a store failure is `503`, anything else is `500` with `code: "act_not_recorded"`. **A delete's link tombstones follow its
  bytes**: the links this instance wrote from the file and from its derived ids are removed after the bytes and before the row, each
  with a tombstone, and the file's own tombstone is published once they are gone, so a delete that failed in that step has told
  no peer and its retry tells them once. Links another instance wrote stay with it (ADR 05).
- **A destination a file blocks, or where something already stands, is `409`** (`code: "path_blocked"` or
  `"destination_exists"`, `path` relative to the space), the same on every door, and refused before anything is
  written. Not `400`/`422`, for the sync reason above; not `404`, which says the **source** names nothing; and the error
  is deliberately not a `RangeError`, which the REST routes answer as `400` before anything else. **A move never replaces
  anything:** a file, a folder or a file's record at the destination refuses it, and deleting what stands there is the
  way to replace it (an upload and a restore still replace).
- **A move whose records did not all follow is `503` with `Retry-After` and `code: "move_still_owed"`**, not the store's
  "not answering": the bytes have moved, so "nothing was written" would be false.

## Consequences

- **A persistent fault in the tombstone write blocks deletes for the space**, retention's included, instead of letting
  bytes go untombstoned and return from a peer. That trade is stated, and chosen.
- **Moves stranded before this change are not repaired.** The old sweep had already forgotten their markers, so nothing
  says they are owed, and finding them would be an unbounded scan. A retry of the same move still finishes one.
- **A stranded move needs a person.** Its records stay where they are and its marker stays until the move is finished or is
  no longer a move; the log line and the gauge name it.
- **A `404` on a retried move can mean it was finished**, by housekeeping or by an earlier attempt the caller never saw.
  Integrators list the destination before moving again.
- **A sync sender keeps retrying a `409`.** That is the point, and also the cost: a path that stays blocked on the
  receiver is retried every cycle until the receiver's tree changes.
- **This is the reversal to prevent:** letting a marker age out, or a worker or sweep treat "no bytes at the old path" as
  "deleted", which destroys a move that is merely unfinished; moving the completion into the settle or the worker, which
  is how a single slow move would hold every other space's housekeeping; answering a refused destination `400` or `422`,
  which silences a sync sender for a condition that can clear; and making the identity check fail open ("finish it anyway"),
  which overwrites an unrelated file that happens to stand at the destination; and letting a move replace what stands at its
  destination, which loses a file or a record nobody named and removes it from every replica.

## Where the detail lives

- `server/src/files/finish-owed-moves.ts` — the completion, its budget, its backoff and what stranded means.
- `server/src/files/move-markers.ts` — the marker, `moveIsOwed`, the pager over the markers and the remover that consults it
  (`removeUnlessOwed`); `server/src/files/tombstones.ts` — the tombstone lifecycle whose every remover asks `moveIsOwed`, and
  `settleBegunMove`; `server/src/files/tombstone-store.ts` — the one module that opens the collection (the split is Q-462).
- `server/src/files/act-answers.ts` and `server/src/files/destination.ts` — the one answer to a refused or failed file act,
  and the check every door runs on its destination.
- `docs/integration-guide/05-files-api.md` — the contract: statuses, bodies and retry.
- `testing/standalone/housekeeping-finishes-an-owed-move-db.test.js`, `testing/standalone/no-remover-drops-an-owed-move-marker.test.js`,
  `testing/standalone/move-marker-queries-are-read-through-the-pager.test.js`
  and `testing/standalone/a-destination-blocked-by-a-file-is-refused-alike-db.test.js` — the completion, the removers and
  the destination answer on every door.

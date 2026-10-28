# 16 — A peer's numbering may start over, and positions continue above everything this instance ever handed out

**Status:** accepted, 2026-10 (D-48, met by the position clock) · **Scope:** the landing position every record takes, what a start continues above, the `head` guard, the version mark kept in `config.json`, and what a restore onto an empty database can and cannot repair

## Context

A restore onto an empty database, or a volume that was wiped, can hand out two kinds of number below what this instance handed out before, and each does its own damage:

- **A position** is where a record landed in this instance's stream. A peer pages by it, so a position below one the peer has already read past means the peer never asks for that record.
- **A version** (`seq`) is the number a local write stamps on a record. A peer keeps the copy with the higher version, so an edit stamped below the copy a peer holds is lost on that peer.

The owner's ruling was to continue above the old numbers wherever they can be found and to accept a rare comeback where they cannot: sort the rest out by id and version, and accept that a record deleted here whose tombstone peers have pruned can return. Positions continue above the wall clock (points 1 to 3). Versions continue above the version mark this instance keeps outside the database (point 4).

## Decision

1. **A position is the wall clock, never below one handed out before.** The next position is `max(now in microseconds, last + 1)`; a block of rows takes consecutive values. A start continues above the highest of: the stored maximum `pos`, the wall clock, the in-process last, and the marks this instance answers for (each capped, when it was recorded, at this instance's own settled cap, so a peer that sends `afterPos` near the maximum cannot drive the seed to the ceiling).
2. **A clock before 2005-09-05T05:58:26.843Z refuses every write** (`503` `positions_clock_unusable`; reads and sync carry on), because the first instant above the version ceiling is the first usable position. A seed read that fails refuses the write (`positions_seed_unavailable`) instead of stamping from the wall clock alone.
3. **`head` detects the one case the clock cannot cover.** Every page answers `head`; a puller whose mark for a member is above that member's `head` forgets that receive mark and re-reads, sorting by id and version. That re-read is capped like the operator's, so it counts partial, not failed.
4. **No lease a write waits on; a version mark kept in `config.json`.** Owner decision 2026-10-28 ("Mark in config.json"), which narrows the earlier "no lease file, no epoch". The instance keeps, per space, a **version mark** in `config.json` (`versionMarks`, space id to number): the highest version its counter may already have reached, raised in steps of 100,000 ahead of the counter. The first write of a space after the server starts, and any write after the space's counter went backwards while the server runs, first raises the counter to the mark and only then stamps. So after a restore onto an empty database, a counter wipe that kept `config.json`, an import onto an emptied space or a failed rename, new versions continue above every version handed out before. The mark is saved in the background and **no write ever waits on it**: that is why the fsync failure this decision feared on Windows and bind mounts cannot stop a write, and why a lost or stale `config.json` is not a new failure but the case already ruled on (sort the records out by id and version). Positions in a data folder lost with the database are still covered by the wall clock alone; the operator is told not to set the system clock back across a restore.

## Consequences

- A restore never lowers what was handed out (the counter is raised and the clock is not reset), and what peers received after the backup is sent to them again.
- After a restore onto an empty database, a wipe that kept `config.json`, an import onto an emptied space or a failed rename, the next edit is stamped above everything this instance handed out, so a peer does not drop it. A version may jump by up to 100,000 after a server start; versions are only compared, so nothing else notices.
- What stays out of reach: a crash or a lost `config.json` write after the counter passed the last saved mark, together with a loss of the database (stamps in that stretch can be reused); a `config.json` lost with the database or replaced by an older copy before the first start (records are then sorted out by id and version); an edit made on a restored record before a peer's newer copy arrives, which takes the higher version and replaces that copy on every peer without a fork; and a content-id record re-created below a tombstone a peer still holds, or a stamp above the version ceiling minus one step.
- The clock is a dependency: an instance whose clock is wrong refuses edits loudly, and an NTP step back across a start that also lost the stored maximum is the residual `head` reports.

## The reversal to prevent

Making a write wait on a persisted lease, mark or epoch to make a restart look safe (a file the volume can lose, and a directory fsync that fails on Windows and bind mounts, so it can stop every write); lowering the version mark, or taking a lower value from `config.json` while the server runs; letting a held tombstone raise the mark, which lets a peer ratchet it; stamping from the wall clock when the stored maximum could not be read; and letting a peer-supplied value into the seed uncapped.

## Where the detail lives

- `server/src/util/position-clock.ts` — the clock and its holds.
- `server/src/sync/record-position-stream.ts` — the records stream, its seed sources and the landing wrapper.
- `server/src/sync/served-watermark.ts` — the capped marks this instance answers for.
- `server/src/util/version-mark.ts` — the version mark, its raise before a space's first stamp and its saving in `config.json`.
- `docs/userguide/05-storage-data-and-audit.md` — what the operator does and does not do across a restore.

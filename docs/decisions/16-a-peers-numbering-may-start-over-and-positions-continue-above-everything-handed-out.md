# 16 — A peer's numbering may start over, and positions continue above everything this instance ever handed out

**Status:** accepted, 2026-10 (D-48, met by the position clock) · **Scope:** the landing position every record takes, what a start continues above, the `head` guard, and what a restore onto an empty database can and cannot repair

## Context

A restore onto an empty database, or a volume that was wiped, used to hand out numbers peers had already read past, so a peer never asked for the records written under them. The owner's ruling was to continue above the old numbers wherever they can be found and to accept a rare comeback where they cannot: sort the rest out by id and version, and accept that a record deleted here whose tombstone peers have pruned can return.

## Decision

1. **A position is the wall clock, never below one handed out before.** The next position is `max(now in microseconds, last + 1)`; a block of rows takes consecutive values. A start continues above the highest of: the stored maximum `pos`, the wall clock, the in-process last, and the marks this instance answers for (each capped, when it was recorded, at this instance's own settled cap, so a peer that sends `afterPos` near the maximum cannot drive the seed to the ceiling).
2. **A clock before 2005-09-05T05:58:26.843Z refuses every write** (`503` `positions_clock_unusable`; reads and sync carry on), because the first instant above the version ceiling is the first usable position. A seed read that fails refuses the write (`positions_seed_unavailable`) instead of stamping from the wall clock alone.
3. **`head` detects the one case the clock cannot cover.** Every page answers `head`; a puller whose mark for a member is above that member's `head` forgets that receive mark and re-reads, sorting by id and version. That re-read is capped like the operator's, so it counts partial, not failed.
4. **No lease file, no epoch.** A data folder lost with the database is covered by the wall clock alone; the operator is told not to set the system clock back across a restore.

## Consequences

- A restore never lowers what was handed out (the counter is raised and the clock is not reset), and what peers received after the backup is sent to them again.
- What stays out of reach: a peer's mark toward a restored instance that stays above what the restore lost (the restore is told so, and the Q-556 line owns it), and a content-id record re-created below a tombstone a peer still holds.
- The clock is a dependency: an instance whose clock is wrong refuses edits loudly, and an NTP step back across a start that also lost the stored maximum is the residual `head` reports.

## The reversal to prevent

Reintroducing a persisted lease or an epoch to make a restart look safe (a file the volume can lose, and a directory fsync that fails on Windows and bind mounts, so it can stop every write); stamping from the wall clock when the stored maximum could not be read; and letting a peer-supplied value into the seed uncapped.

## Where the detail lives

- `server/src/util/position-clock.ts` — the clock and its holds.
- `server/src/sync/record-position-stream.ts` — the records stream, its seed sources and the landing wrapper.
- `server/src/sync/served-watermark.ts` — the capped marks this instance answers for.
- `docs/userguide/05-storage-data-and-audit.md` — what the operator does and does not do across a restore.

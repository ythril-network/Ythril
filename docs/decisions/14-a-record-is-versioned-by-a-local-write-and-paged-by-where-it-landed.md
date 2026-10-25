# 14 — A record's version is stamped only by a local write, and sync pages by where a record landed

**Status:** accepted, 2026-10 (D-19 B) · **Scope:** the `seq` every brain record carries, the counter it is drawn from, the sync pull and push pages (`afterPos`, `through`, `head`), and the order every brain list defaults to

## Context

`seq` did two jobs. It was the record's **version** (a peer takes a copy as newer when its `seq` is higher) and it was the **place** a record held in the serving instance's stream (a pull paged by it, a mark remembered it). The two cannot both be true of one number once records are relayed:

- **An arrival moved the counter.** Every push door bumped the counter past every `seq` it received, because the bump was the only way an arrival became visible to a pager. One peer pushing a record near the ceiling therefore pushed every later write on every receiver toward it, and a record relayed from another author landed at a `seq` of somebody else's counter, below a mark the next reader already held, so it was never offered.
- **A tombstone-only or relayed cycle moved nothing.** A mark that was a `seq` of one author's counter could not say how far a relay had read.
- **Records that share a version tie.** Relayed records carry their author's `seq`, so a page cut inside a run of equal values could skip the rest of the run.

## Decision

1. **A local write stamps the version; an arrival never does.** An edit stores a `seq` above the one it read (and above any tombstone this instance holds for the id), and writes only if that read version is still current; if an arrival landed between, it reads again and writes above it. An arrival keeps its issuer's `seq` and never moves the counter. A version that would pass the ceiling is refused (`409` `record_version_at_ceiling`, nothing written) rather than wrapped; that is the accepted cost, and a record at the ceiling is refused loudly on both doors.
2. **Every record lands at a position of this instance's own stream.** `pos` (with `posAtSeq`, the version that position was taken for) is local: never sent, never shown, never hashed. A pull pages by `afterPos` and answers `through` (never inside a run of equal positions), `head` and `positions: 1`; a mark is a position. Every brain list defaults to landing order (`pos` then `_id`, newest first).
3. **`writtenHere` and `issuedHere` are marks, not inferences.** A mesh push sends the records written here and the tombstones issued here, decided by one predicate and one module, never by the author text a peer sent.

## Consequences

- A relay forwards what it pulled, a tombstone-only cycle moves the marks, and a planted high `seq` cannot lift later writes of other records.
- Every 6.0 instance of a network must be upgraded together: a 5.x peer pages by `seq`, is refused (`Version too old`) and is never mixed in silently.
- The positions are a new local field on every row, carried once on the first start ([the carry](17-the-first-carry-is-an-owed-job-and-a-space-answers-positions-building-until-it-ends.md)).
- A rollback must clear them first, or a `merkle: true` 5.6 network logs a divergence every cycle for data that is the same.

## The reversal to prevent

Bumping the counter on an arrival to make it visible, or paging by `seq` again because it looks simpler. The first brings back a ceiling one peer can push every receiver toward and writes stamped below what they replace; the second brings back skipped relays and tied runs. Also: reading a peer's `author` to decide whether a row is ours (a peer can name us), and widening the one local-field list without hashing and replicating it by its rule.

## Where the detail lives

- `server/src/util/version-stamp.ts` — the version a local write takes, and the ceiling refusal.
- `server/src/brain/write-at-read-version.ts` — the read-then-write loop of one edit.
- `server/src/sync/record-position-stream.ts` and `server/src/util/position-clock.ts` — the landing wrapper and the clock.
- `docs/sync-protocol.md` — the wire: pages, marks, tombstones, conflicts.

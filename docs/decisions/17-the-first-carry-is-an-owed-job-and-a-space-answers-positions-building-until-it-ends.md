# 17 — The first carry into position space is an owed job, and a space answers `positions_building` until it ends

**Status:** accepted, 2026-10 (D-24 and the contribution guide's migration rule) · **Scope:** the first 6.0 start of a space, the re-upgrade repair, the rollback tool, and why this is a one-time migration of a synced collection

## Context

The contribution guide says synced data heals lazily and is never migrated once at boot, because a mixed-version peer can silently revert a boot migration. Bundle-81 needs the opposite for three fields: every row a 5.6 build stored has a version and no position, and sync pages by position. The three fields (`pos`, `posAtSeq`, `writtenHere`) are **local-only**: no peer overwrites them and none crosses the wire, so the revert the rule guards against cannot happen. The cost is another matter: the carry rewrites every document of every collection once, and the vector index re-reads each.

## Decision

1. **The carry is an owed job, not a boot step.** A counter document with neither marker field owes its first carry; a job every minute builds the `(pos, _id)` index first, positions each collection a thousand rows at a time and records the space ready in one write. A crash or a failed index build leaves the space owing and the next tick finishes it.
2. **Until it ends the space is held, never failed.** Every sync door answers `503` with `code: "positions_building"`, which a sender reads as held: no mark moves and no member failure is counted. A write to the space still lands, at a clock position. A space created, renamed or restored at runtime is ready before its act answers.
3. **The marks carry with the rows.** Each `lastSeq*` mark becomes `lastPos*` with the same number and the scanner cursors carry the same way, so the first 6.0 cycle offers exactly what 5.6's next one would have. The 5.6 marks stay frozen in `config.json`.
4. **A rollback runs a named step; a re-upgrade repairs.** `node server/dist/tools/positions-rollback.js` (with 6.0 stopped, before 5.6 starts) clears every 6.0 field, raises each counter and marks every space owing a repair; the next 6.0 start repairs what 5.6 changed. `config.json.pre-6.0` is not part of this path and is written only when the upgrade converted a pre-6.0 grouping of spaces into personal views.
5. **Upgrade every instance of a network** (D-24): a 5.x peer is refused as too old rather than mixed in, and the upgrade notes say so.

## Consequences

- The first start costs one rewrite of every document and a vector re-read, observable as `ythril_positions_building_spaces`; a large space answers `positions_building` for as long as it takes.
- Records a 5.6 mark already shadowed stay shadowed; the operator's re-read is the one recovery.
- Pre-6.0 tombstones carry no `issuedHere`, so a legacy tombstone is not pushed on a mesh as this instance's own.

## The reversal to prevent

Running the carry at boot before the server listens (a start that takes as long as the data and fails as one), answering the held state as a failure (every peer then counts this member as down for the length of the carry), or promising `config.json.pre-6.0` as a rollback that exists on every instance.

## Where the detail lives

- `server/src/sync/positions-owed.ts` — the owed job, the carry, the repair and the re-upgrade detector.
- `server/src/sync/positions-ready.ts` — the readiness every sync door asks.
- `server/src/sync/positions-rollback.ts` and `server/src/tools/positions-rollback.ts` — the rollback step and its entry.
- `docs/integration-guide/02b-upgrading.md` — the upgrade, the rollback command and what it costs.

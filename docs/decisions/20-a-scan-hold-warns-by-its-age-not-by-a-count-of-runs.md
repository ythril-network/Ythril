# 20 — A background scan's hold is warned by its age (20 hours), never by a count of runs

**Status:** accepted, 2026-11-05 · **Scope:** the duplicate scanner and the contradiction scanner when a seed's neighbour search ran over a vector index that was not ready (`index_not_ready`): the clock on the cursor (`heldSince`), `ythril_scan_holds_total`, the warning, and what clears the clock

## Context

A scan holds a type when its index is not ready: the type keeps its position and the next run reads the same records again, so no record is marked scanned without its neighbours having been looked for. That is the right answer for the hour after an upgrade or a database container recreate. It is the wrong one to leave unsaid for a week: a type held on every run is a scan that never reaches the records behind its position, and until now nothing separated the first hold from the fortieth. Each run said one line at info, a held contradiction scan answered like a finished one in the Review tab, and the duplicate scanner had the same blind spot since the hold was written.

The first design for "say it when it lasts" was a count: warn at the Nth consecutive held run. It does not survive contact with how a scan is started:

- **A manual scan is a run.** `POST /api/duplicates/scan` and **Scan now** run the same code as the schedule, with `reset: true` on the duplicate route. An operator who rescans five times in a minute while the index is building raises a run count to five, and the warning says an index has been unready for days.
- **A count needs a reset rule, and every rule is wrong somewhere.** A reset that clears the count (the manual rescan, which rewrites the position) hides a hold that is about the index and not the position; one that does not clear it counts runs of an index that recovered in between.
- **The schedule's period is a daily one, and it jitters.** What an operator means by "it has lasted" is a time: the index has been unready since a moment, not for so many runs.

## Decision

- **A hold is warned by its age.** The cursor's own row in `ythril_dupe_scan_state` carries `heldSince`, the time of the FIRST hold, kept by `$min` so a later hold never moves it. A hold at least **20 hours** old (72 000 000 ms, one constant in `scan-cursor.ts`) is warned, once per 20 hours per cursor. 20 hours is below the daily period of both scanners, so the second daily run in a row warns despite the jitter of a schedule, and a hold of one run, the ordinary case of an index being built, never does.
- **Only a pass that ended without a hold clears the clock**, once per pass and only when the row read at the pass start carried one (so a healthy instance writes nothing, and no seed writes). A position write never clears it, so the held pass's own write of the seeds before the held one keeps the clock; and a reset keeps it, so a manual rescan cannot hide a hold. An empty batch is a pass that ended without a hold. A rename moves the clock with the cursor; deleting a space deletes its rows, so a space created again under the id inherits neither a position nor a clock.
- **Each hold is counted** (`ythril_scan_holds_total{scanner}`, declared at zero for `dupe` and `contradiction` from one list) and said at info with the space, type and pass. A stalled judge (`nliStalled`) is a different cause with its own signal and is not counted: a counter that mixed them would send an operator to the index when the judge is down.
- **The scan's answer names what held** (`indexHeld` on both scan routes, `{ spaceId, type, pass? }`, built after the token's reach), and the Review tab says so in its own message in every language, so a held scan is never read as a clean one.
- **One decision per degraded reason** (`seedSearchOutcome`, an exhaustive `Record<DegradedReason, 'hold' | 'advance'>`): `index_not_ready` holds and every other reason advances, `index_unavailable` included, because a scan that waited on an index that needs an operator would stall the type for ever.

## Consequences

- **The warning is late by design.** A hold of 19 hours is not warned; the counter and the answer's `indexHeld` are what say it sooner.
- **A scan that runs less often than every 20 hours warns on the second hold**: the clock started at the first one, and the next run, however late, finds it old.
- **A poisoned `heldSince`** (a value that is no time) never warns: the next hold replaces it with its own time, and the first pass that ends without a hold clears it.
- **The clock is per cursor**, so a contradiction scan that holds both its passes warns twice, once per pass.
- **This is the reversal to prevent:** replacing the age with a count of consecutive held runs "because it is simpler", which a manual scan inflates and a reset can hide; clearing the clock on a position write or a reset, which hides a hold behind the held pass's own write or an operator's rescan; or counting `judge_stalled` as a hold, which sends an operator to the wrong place.

## Where the detail lives

- `server/src/brain/scan-cursor.ts` — `noteScanHold`, `clearScanHold`, `readScanCursor`, `dropScanCursorsOfSpace` and the age constant.
- `server/src/brain/scan-seed-runner.ts` — `seedSearchOutcome`, the one decision per reason.
- `docs/integration-guide/14-duplicates-and-webhooks.md` — the contract: `indexHeld`, the clock and the warning; `docs/integration-guide/11-setup-api.md` — `ythril_scan_holds_total` and what to alert on.
- `testing/standalone/a-scan-hold-keeps-its-clock-until-a-pass-ends-without-one-db.test.js` — the boundary at 20 h less 1 ms, 20 h and 20 h plus 1 ms, and what clears it; `testing/standalone/a-contradiction-scan-holds-its-position-while-the-index-is-not-ready-db.test.js` — the hold on both cursors.

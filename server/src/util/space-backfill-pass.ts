/**
 * A ONE-TIME pass over one space's collections: each collection is a unit, the units are isolated, and the pass is recorded done ONLY when every unit finished
 * (bundle-81, design rev 8 §3; extracted from the `deliveredBy` back-fill when the first carry into position space became its second site).
 *
 * ## The question it answers
 *
 * *"Do this once to every collection of a space, and remember it only when all of it was done."* The `deliveredBy` stamp (`sync/delivered-by-backfill.ts`) and
 * the carry into position space (`sync/positions-owed.ts`) are both a local-field migration of one space: they cannot run at boot (the answer depends on the
 * networks, or the space is too large for a boot that must finish), so they run lazily, space by space, under the housekeeping walk's bound and isolation.
 *
 * ## What a hand-written copy drops, and so what this holds
 *
 *  - **The marker waits for every unit.** A collection that failed leaves the space unmarked, so the next attempt finishes it. A marker set after the units
 *    that happened to succeed is a space half done and recorded whole, which nothing reports.
 *  - **One failing unit does not end the others, and a store that stopped answering ends all of them.** Both are `eachUnit`'s: a unit failure is said once per
 *    window through the shared reporter and the loop goes on; a `store-down` or `space-timeout` verdict is rethrown to the walk.
 *  - **The pass is bounded.** It runs inside `eachSpace`, so every database operation of every unit ends at the housekeeping figure.
 *  - **Whether the marker could be written is part of "finished".** `markDone` answers `false` when the space is gone or the write did not land, and then the
 *    pass is not finished and nothing is said as though it were.
 *
 * What a pass changes is the caller's: a unit returns how many rows it changed, and the total is handed to `onFinished` for the caller's line.
 */
import { eachSpace, eachUnit } from './housekeeping-walk.js';

export interface SpaceBackfill<U> {
  /** The walk step a failure is reported under. */
  readonly step: string;
  readonly spaceId: string;
  /** The units: usually the collections, in the order they are done. */
  readonly units: readonly U[];
  /** Do one unit; answers how many rows it changed. Idempotent: it is run again from the start after a failure. */
  readonly unit: (unit: U) => Promise<number>;
  /** The name of a unit in a failure line (default: the unit as text). */
  readonly label?: (unit: U, index: number) => string;
  /** Record the pass done. `false`: it could not be recorded (the space is gone), so the pass did not finish. Runs only when every unit finished. */
  readonly markDone: () => Promise<boolean> | boolean;
  /** Said when the pass finished, with the rows it changed. */
  readonly onFinished?: (changed: number) => void;
  /** In the words of a failure line: when the space is tried again (`next cycle`, the walk's default; `next tick`). */
  readonly when?: string;
}

/** What one pass did: whether it finished (every unit done and the marker recorded), and whether the store stopped answering so the caller should stop too. */
export interface SpaceBackfillResult {
  readonly finished: boolean;
  readonly changed: number;
  /** The walk stopped because the store is not answering or is stalled: a caller walking more spaces stops. */
  readonly stop: boolean;
}

/** Run the pass of `p` on its space; never throws. */
export async function backfillSpaceOnce<U>(p: SpaceBackfill<U>): Promise<SpaceBackfillResult> {
  let changed = 0;
  let finished = false;
  const walk = await eachSpace(p.step, [p.spaceId], async () => {
    const { failed } = await eachUnit(p.units, async (unit) => { changed += await p.unit(unit); }, p.label);
    if (failed.length > 0) return;   // a unit is still owed: the marker waits, and the next attempt finishes it
    if (!(await p.markDone())) return;
    finished = true;
    p.onFinished?.(changed);
  }, p.when !== undefined ? { when: p.when } : undefined);
  return { finished, changed, stop: walk.storeDown === true || walk.stalled === true };
}

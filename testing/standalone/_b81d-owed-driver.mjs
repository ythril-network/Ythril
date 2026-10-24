/**
 * The one place the bundle-81 slice-D tests name how a test TRIGGERS the owed-positions work (design rev 8 section 3).
 *
 * The plan names the module (`sync/positions-owed.ts`: `positionsOwed`, `owePositions`, `recordPositionsReady`, the readiness read), the
 * owed job (`positionsOwedJob`, an interval job whose tick walks the owing spaces, runs the owed work, builds the `(pos,_id)` index and
 * records readiness), and the re-upgrade detector ("run once per boot, in phase 1, before `startSyncScheduler`", also "retried by the owed
 * job"), and `stampLastSync(member, at)` in `sync/member-status.ts`. It names NO function a test can call to run one tick or one detector
 * pass, and the tests wait on explicit triggers, never a timer (rev 8 section 9, "Rules for every test"). So this driver assumes two exports
 * of `sync/positions-owed.js`:
 *
 *  - `detectReupgrade()`: the detector's one pass, which also marks every counter doc that has neither field `'carry'` and writes the
 *    config key `positionsSince` the first time (section 3, "A doc with neither field");
 *  - `runPositionsOwedTick()`: one tick of the owed job, awaited, which runs the owed work of every owing space to its end.
 *
 * If the implementation names them otherwise, this file is the only one to change. Every test that uses them says so in the report.
 */
import assert from 'node:assert/strict';

export async function owedDriver() {
  const owed = await import('../../server/dist/sync/positions-owed.js');
  for (const name of ['detectReupgrade', 'runPositionsOwedTick', 'positionsOwed']) {
    assert.equal(typeof owed[name], 'function', `sync/positions-owed.js exports no ${name}: the owed-positions work cannot be triggered (see _b81d-owed-driver.mjs)`);
  }
  return { detectReupgrade: owed.detectReupgrade, tick: owed.runPositionsOwedTick, positionsOwed: owed.positionsOwed };
}

/** `stampLastSync(member, at)` of `sync/member-status.ts`: the one writer of `lastSyncAt`, which stamps `lastSyncAtBy6` with it. */
export async function stampLastSyncOf() {
  const status = await import('../../server/dist/sync/member-status.js');
  assert.equal(typeof status.stampLastSync, 'function', 'sync/member-status.js exports no stampLastSync');
  return status.stampLastSync;
}

/** A position in the clock band (microseconds since 1970), above `2^50`, the legacy band's ceiling. */
export const CLOCK_BAND = 1_790_000_000_000_000;

/**
 * The schema snapshot sweep (Q-739, bundle-266): a snapshot row is removed once nothing here uses it. "Nothing" is: no stored record of the space
 * carries its fingerprint, it is neither the current variation's nor a held layer's, and no row that stays links it. It is marked (`orphanSince`)
 * by the pass that first finds it unused and removed no sooner than {@link SNAPSHOT_REMOVAL_GRACE_MS} after; every way back into use clears the mark.
 * The verdict is the pure `snapshotSweepPlan` (`schema-snapshot.ts`); this module does the reads and the writes.
 *
 * ## What it prevents
 *
 * - A version a stored record names losing its text. A write that read version X before a schema edit lands stamped X after it (probe experiment 1):
 *   X stays in the keep set while a writer can read it as current, so it is marked no earlier than the first pass after the edit, and the removing
 *   pass, a day later, reads the stored records again and sees the record.
 * - A pass that half-reads. The carried read covers the four record collections or the space is left untouched (fail closed): a collection that
 *   could not be read might carry any of the candidates.
 * - A removed row still known held. `forgetHeld` runs for the whole remove set before the delete and again in a `finally`, so a delete whose
 *   answer was lost after it applied leaves no stale entry, and the held generation keeps a keep in flight from noting the row held after it.
 * - An import act interleaving. The read, the verdict and every write of a space are ONE `admitSpaceWrite` unit, and the delete is conditional on
 *   the mark it read (`orphanSince <= now - grace`), so a row claimed back between the read and the delete stays. A record that lands in that window
 *   is recovered by the gap scan, which owes the fingerprint and fetches it from the member that delivered the record.
 *
 * ## Cheap first
 *
 * The rows are read without their text. With no candidate (every row a layer, kept, or never unused) and no mark, the pass ends with no record read;
 * otherwise the records are read only among the candidates, through the stamp index (`fingerprintsCarriedIn`).
 *
 * Its own module, not the TTL sweep's file: the write-gate gate exempts that file by name, and this one must ask the gate.
 */
import { asFilter } from '../db/mongo.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { log, peerList, peerText } from '../util/log.js';
import { schemaSnapshotTotal } from '../metrics/schema-snapshot-count.js';
import { configuredSpaces } from './space-lookup.js';
import { admitSpaceWrite, isActRefusal } from './space-write-gate.js';
import { forgetHeld, fpPrefix } from './schema-stamp.js';
import { owedOf, snapshots, type SnapshotRow } from './schema-snapshot-store.js';
import { fingerprintsCarriedIn, STAMPED_COLLECTIONS } from './schema-snapshot-carried.js';
import { SNAPSHOT_REMOVAL_GRACE_MS, snapshotSweepPlan, type SweptRow } from './schema-snapshot.js';

/** The step the sweep, and each failure of it, is reported under. */
export const SCHEMA_SNAPSHOT_SWEEP_STEP = declareStep('Schema snapshot sweep');

/** How many removed fingerprints the pass's line names. */
const NAMED = 5;

/** A test's seam inside the pass: right before and right after its conditional delete. A hook that throws fails the pass there. */
export interface SweepHooks {
  beforeDelete?(spaceId: string, fps: readonly string[]): unknown;
  afterDelete?(spaceId: string, fps: readonly string[]): unknown;
}

let hooks: SweepHooks | null = null;

/** Set (or with `null` clear) the test hooks of the pass. */
export function setSchemaSnapshotSweepHooksForTest(next: SweepHooks | null): void {
  hooks = next;
}

/** One pass over every configured space at `now` (ms; the clock by default). The housekeeping cycle runs it after `ensureSchemaSnapshots`. */
export async function sweepSchemaSnapshots(opts: { now?: number } = {}): Promise<void> {
  const now = opts.now ?? Date.now();
  await eachSpace(SCHEMA_SNAPSHOT_SWEEP_STEP, configuredSpaces(), async (space) => {
    let removed: { fps: string[]; count: number };
    try {
      removed = await admitSpaceWrite(space.id, undefined, () => sweepSpace(space.id, now));
    } catch (err) {
      // An act stands on the space: the whole pass waits for the next cycle.
      if (isActRefusal(err)) return;
      throw err;
    }
    if (removed.count === 0) return;
    for (let i = 0; i < removed.count; i++) schemaSnapshotTotal.note('removed');
    log.info(`Schema snapshot sweep removed ${removed.count} version(s) of space '${peerText(space.id)}' that nothing here used for `
      + `${SNAPSHOT_REMOVAL_GRACE_MS / 3_600_000} h: ${peerList(removed.fps.map(fpPrefix), ', ', { count: NAMED })}`);
  });
}

/** The pass over one space, inside its write unit: what it removed. */
async function sweepSpace(spaceId: string, now: number): Promise<{ fps: string[]; count: number }> {
  const none = { fps: [], count: 0 };
  const rows = (await snapshots(spaceId).find({}, { projection: { _id: 1, origin: 1, links: 1, orphanSince: 1 } }).toArray()) as unknown as SweptRow[];
  const keep = new Set(owedOf(spaceId).map(([stamp]) => stamp.fp));
  // A row that is a layer or kept is never a candidate, whatever carries it: only the others are asked of the records.
  const candidates = rows.filter(r => r.origin !== 'layer' && !keep.has(r._id)).map(r => r._id);
  if (candidates.length === 0 && !rows.some(r => r.orphanSince !== undefined)) return none;
  const carried = new Set<string>();
  const { failed } = await eachUnit(STAMPED_COLLECTIONS, async (collection) => {
    for (const fp of await fingerprintsCarriedIn(spaceId, collection, candidates)) carried.add(fp);
  });
  // Fail closed: a collection that could not be read might carry any candidate. Each failure was reported by the walk.
  if (failed.length > 0) return none;
  const plan = snapshotSweepPlan(rows, carried, keep, now, SNAPSHOT_REMOVAL_GRACE_MS);
  const rowsOf = snapshots(spaceId);
  if (plan.mark.length > 0) {
    await rowsOf.updateMany(asFilter<SnapshotRow>({ _id: { $in: plan.mark } }), { $set: { orphanSince: new Date(now).toISOString() } });
  }
  if (plan.clear.length > 0) await rowsOf.updateMany(asFilter<SnapshotRow>({ _id: { $in: plan.clear } }), { $unset: { orphanSince: '' } });
  if (plan.remove.length === 0) return none;
  const forget = (): void => { for (const fp of plan.remove) forgetHeld(spaceId, fp); };
  forget();
  try {
    await hooks?.beforeDelete?.(spaceId, plan.remove);
    const done = await rowsOf.deleteMany(asFilter<SnapshotRow>({
      _id: { $in: plan.remove }, orphanSince: { $lte: new Date(now - SNAPSHOT_REMOVAL_GRACE_MS).toISOString() },
    }));
    await hooks?.afterDelete?.(spaceId, plan.remove);
    return { fps: plan.remove, count: done.deletedCount };
  } finally {
    forget();
  }
}

/**
 * The owed-positions state of a space, read and set the way design rev 8 §3 specifies it, and the one place a test runs the owed job
 * (bundle-81, slice B).
 *
 * ## The state
 *
 * A space owes its positions while its `ythril_counters` document carries `positionsOwed` (`'carry'` or `'repair'`), and is ready when
 * it carries `positionsReadyAt` and no `positionsOwed` (§3 "The owed marker"). These two fields are the specified storage, so a test
 * that needs a space to owe sets them on the document and does not depend on a function the plan spells differently in one place and
 * another. The readiness answer is cached in process (`forgetPositionsReady`, §3 step 6): a case uses a space nobody has asked about, and
 * calls `forgetPositionsReady` when the module has it.
 *
 * ## The one assumed seam
 *
 * The plan names the retry as `positionsOwedJob = intervalJob(...)`, every 60 s (§3), and names no function that runs one pass of it.
 * `runOwedJob` calls `runPositionsOwedTick` exported from `sync/positions-owed.js`, the module the plan gives the owed marker; if the
 * implementation names its pass otherwise, this is the one line to change, and every case that runs the job changes with it.
 */
import assert from 'node:assert/strict';

/** The owed-positions module, or `null` while the build does not have it (cases that only need its fields do not need the module). */
export async function owedModule() {
  return import('../../server/dist/sync/positions-owed.js').catch(() => null);
}

/** The counter document of a space. */
export const counterDoc = (door, space) => door.mongo.col('ythril_counters').findOne({ _id: space });

/** Is the space ready as the counter document says: `positionsReadyAt` present and `positionsOwed` absent? */
export async function isReady(door, space) {
  const doc = await counterDoc(door, space);
  return Boolean(doc && typeof doc.positionsReadyAt === 'string' && doc.positionsOwed === undefined);
}

/** Make a space owe `kind` of work: the two fields §3 specifies, then the in-process readiness answer is forgotten. */
export async function oweDirectly(door, space, kind = 'carry') {
  await door.mongo.col('ythril_counters').updateOne({ _id: space }, { $set: { positionsOwed: kind }, $unset: { positionsReadyAt: '' } }, { upsert: true });
  const owed = await owedModule();
  owed?.forgetPositionsReady?.(space);
}

/** One pass of the owed job over every space that owes. */
export async function runOwedJob() {
  const owed = await import('../../server/dist/sync/positions-owed.js');
  assert.equal(typeof owed.runPositionsOwedTick, 'function',
    'sync/positions-owed.js has no runPositionsOwedTick: the plan names the job (positionsOwedJob) and no function that runs one pass of it (design rev 8 §3)');
  await owed.runPositionsOwedTick();
}

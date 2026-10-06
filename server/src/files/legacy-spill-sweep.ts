/**
 * Remove the read spills versions before 5.6.0 wrote INTO a space (Q-92).
 *
 * A recall's remainder and an over-cap traversal used to be a root `_tmp/results-<uuid>.json` or
 * `_tmp/graph-<uuid>.json` with a `<space>_files` record. They replicated, and a pulled copy never expired
 * (`_expireAt` is local-only), so peers have accumulated them since spills existed. Spills now live in the
 * instance's read-spill store, sync carries this path shape in neither direction (`isInstanceLocalFile`, the
 * arrival writer's `isLegacyReadSpill`, the manifest and the space hash), and this sweep removes what is left locally.
 *
 * - **By PATH, not by tag**: metadata can arrive before its blob and a blob can outlive its record, so a sweep
 *   keyed on the FileMeta's tag leaves one half behind — and finds it again every run.
 * - **Hard, with no tombstone and no webhook**: no transport carries the path, so a tombstone would announce a
 *   deletion nobody is sent, and an upgrade would fire a burst of unattributed `file.deleted` events telling
 *   consumers that someone deleted files. One summary log line and one audit entry per space instead.
 * - **Recurring**, inside every TTL sweep cycle: older peers keep sending spills until they upgrade, so a
 *   boot-once sweep would leave every one that arrives after it. It is idempotent and cheap when there is
 *   nothing: one directory listing and one indexed query per space.
 * - **One space's trouble is that space's** (`Q-274`, `Q-358`): every space is swept through `eachSpace`
 *   (`util/housekeeping-walk.ts`), so a space whose read fails is reported once and the next is still swept, and a
 *   database operation of a space that hangs ends at the housekeeping bound instead of holding the cycle. A spill
 *   whose blob cannot be removed is a unit of its space (`eachUnit`): reported by name, retried next cycle, and the
 *   others still go.
 * - **The `files` record is the finder, so it goes LAST.** A spill's removal is three steps — the blob, the `fileHashes`
 *   row, the `files` record — and only the record is looked up again next cycle (a blob already gone is not an error
 *   and a hash row is found by nothing). Deleting the record first would let a failure of the second delete leave a
 *   hash row no later run could ever find; deleting it last leaves a failed run with a record that points at
 *   everything still to do.
 * - **A directory is empty only when it is not there.** The listing's failure is the space's unless it says the path
 *   does not exist (`isMissingPath`): a permission or I/O failure answered as "no spills" would be reported as a clean
 *   sweep for ever.
 *
 * Removed at the next major, with the deprecated `path` and `isSpillPath`'s hiding of `_tmp`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spaceRoot } from './sandbox.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { deleteStored, isMissingPath } from './stored-bytes.js';
import { SPILL_DIR, spillIdFromPath } from '../brain/spill-path.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { logInternalAudit } from '../audit/audit.js';
import { LEGACY_SPILL_SWEEP_OPERATION } from '../audit/middleware.js';
import { eachSpace, eachUnit } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { log } from '../util/log.js';

/** The name a failure of this sweep is reported, counted and quarantined under. */
const STEP = declareStep('Legacy spill sweep');

export interface LegacySpillSweep {
  /** Spills removed, each counted once whichever of its two halves was present. */
  removed: number;
  /**
   * What could not be done, with the reason; logged (once per condition), retried next run. A spill whose blob could not be
   * removed names its own `path`; a space whose whole sweep failed (a read that failed or hung) names the spill directory.
   */
  failed: { spaceId: string; path: string; error: string }[];
}

/** One space: returns how many spills it removed. Throws what ends the space's sweep; the walk reports it. */
async function sweepSpace(spaceId: string): Promise<number> {
  const started = Date.now();
  const found = new Set<string>();

  const dir = path.join(spaceRoot(spaceId), SPILL_DIR);
  const names = await fs.readdir(dir).catch((err: unknown) => {
    if (!isMissingPath(err)) throw err;   // not being there is an answer; a failure to look is the space's
    return [] as string[];
  });
  for (const name of names) {
    const rel = `${SPILL_DIR}/${name}`;
    if (spillIdFromPath(rel)) found.add(rel);
  }
  const metas = await col<{ _id: string }>(spaceCollection(spaceId, 'files'))
    // An anchored, case-sensitive prefix, so the query walks only the `_tmp/` range of the `_id` index on every
    // cycle; the exact spill shape is then decided by `spillIdFromPath` below, the one test for it.
    .find(asFilter({ _id: { $regex: `^${SPILL_DIR}/` } }), { projection: { _id: 1 } }).toArray();
  for (const m of metas) if (spillIdFromPath(m._id)) found.add(m._id);
  if (found.size === 0) return 0;

  const removed: string[] = [];
  await eachUnit([...found], async (rel) => {
    await deleteStored(path.join(dir, rel.slice(SPILL_DIR.length + 1))).catch((err: unknown) => {
      if (!isMissingPath(err)) throw err;   // the blob never arrived, or is already gone
    });
    removed.push(rel);
  });
  if (removed.length === 0) return 0;
  // The disk this freed is the files quota's, and a cached figure would keep charging for it until expiry — whether or not
  // the records below go this run.
  invalidateUsageCache();

  // The `files` record is the finder (see the header): it goes last, so a failure of either delete is redone by the next run.
  await col(spaceCollection(spaceId, 'fileHashes')).deleteMany(asFilter({ _id: { $in: removed } }));
  await col(spaceCollection(spaceId, 'files')).deleteMany(asFilter({ _id: { $in: removed } }));

  log.info(`Legacy spill sweep: removed ${removed.length} read spill(s) older versions wrote into '${spaceId}'`);
  logInternalAudit({
    method: 'SWEEP', path: 'internal:legacy-spill-sweep', spaceId, operation: LEGACY_SPILL_SWEEP_OPERATION, startedAt: started,
  });
  return removed.length;
}

export async function sweepLegacySpills(): Promise<LegacySpillSweep> {
  const out: LegacySpillSweep = { removed: 0, failed: [] };
  const walk = await eachSpace(STEP, concreteSpaces(), async (space) => { out.removed += await sweepSpace(space.id); });
  for (const f of walk.failed) out.failed.push({ spaceId: f.spaceId, path: f.unit ?? SPILL_DIR, error: f.reason });
  return out;
}

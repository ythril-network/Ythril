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
 *   database operation of a space that hangs ends at the housekeeping bound instead of holding the cycle.
 * - **The walk is shared** with the retired per-type schema files (`files/retired-local-path-sweep.ts`, bundle-265): each spill is
 *   a unit (its blob, then everything it left through the one remover: its media job, its derived rows, its cached hash, its embed
 *   jobs), and the `files` records go LAST, because a record is the finder a failed run is redone by. A directory is empty only when
 *   it is not there: any other failure to list it is the space's, never "no spills".
 *
 * Removed at the next major, with the deprecated `path` and `isSpillPath`'s hiding of `_tmp`.
 */
import { SPILL_DIR, spillIdFromPath } from '../brain/spill-path.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { LEGACY_SPILL_SWEEP_OPERATION } from '../audit/middleware.js';
import { eachSpace } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { sweepRetiredLocalPaths } from './retired-local-path-sweep.js';

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

export async function sweepLegacySpills(): Promise<LegacySpillSweep> {
  const out: LegacySpillSweep = { removed: 0, failed: [] };
  const walk = await eachSpace(STEP, configuredSpaces(), async (space) => {
    out.removed += await sweepRetiredLocalPaths(space.id, {
      dir: SPILL_DIR, matches: rel => spillIdFromPath(rel) !== null, rowed: 'remove',
      step: STEP, what: 'read spill(s) older versions wrote', operation: LEGACY_SPILL_SWEEP_OPERATION, audit: 'legacy-spill-sweep',
    });
  });
  for (const f of walk.failed) out.failed.push({ spaceId: f.spaceId, path: f.unit ?? SPILL_DIR, error: f.reason });
  return out;
}

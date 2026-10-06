/**
 * Bound tombstone retention — the only growing collection that had no bound at all.
 *
 * The audit log and webhook deliveries carry per-document TTLs, `space_activity` keeps 90 days, review
 * findings have `candidate-prune`. `<space>_tombstones` kept one document per deletion forever, and the only
 * thing that removed them was wiping the space. On an instance whose agents write and delete, the tombstones
 * eventually outnumber the live records and every sync page walks past them.
 *
 * ── Why this is not a TTL ────────────────────────────────────────────────────────────────────────────────
 *
 * `listTombstones` serves by `seq > sinceSeq`, so a peer that was away resumes from its own watermark. Delete
 * by AGE and a peer offline longer than the window comes back, never learns of the deletion, and pushes its
 * live copy: the retention fix becomes "deleted records keep coming back" weeks later. The floor here is what
 * peers have provably been served instead — below it, every peer has already applied the deletion, so
 * resurrection is impossible by construction rather than unlikely. See `sync/served-watermark.ts`.
 *
 * ── Why its own timer ────────────────────────────────────────────────────────────────────────────────────
 *
 * Not hung off the sync engine: a space with no peers never syncs, and that is exactly the space whose entire
 * tombstone collection is droppable. Not a Mongo TTL index either — the condition is a per-space number read
 * from config, which an index cannot express.
 *
 * ── What one space's trouble costs the others (`Q-274`, `Q-358`) ─────────────────────────────────────────
 *
 * The prune is a walk over the spaces (`eachSpace`, `util/housekeeping-walk.ts`) and, inside a space, over its two halves
 * (`eachUnit`): the record tombstones and the file tombstones, which have independent floors and so fail independently. A
 * failure of a half is said ONCE per window under the step with the half named, and the other half and the next space are still
 * pruned; a delete that hangs ends at the housekeeping bound and the space is passed over for a while. The two floor functions
 * below no longer catch: they THROW, so a failed delete cannot be read as "nothing to remove" by a caller that forgot to look
 * (`-1` still means "the floor said not to prune", and only that).
 */
import { col, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { eachSpace, eachUnit, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { intervalJob } from '../util/interval-job.js';
import { log } from '../util/log.js';
import { tombstoneFloorForSpace } from '../sync/served-watermark.js';
import type { TombstoneFloor } from '../sync/served-watermark.js';
import { fileTombstoneFloorForSpace } from '../sync/file-tombstone-ack.js';
import type { FileTombstoneFloor } from '../sync/file-tombstone-ack.js';
import type { TombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { pruneFileTombstonesUpTo } from '../files/tombstones.js';

/** Housekeeping, not correctness — a tombstone kept six hours too long costs nothing. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h

const STEP = declareStep('Tombstone prune');

export interface TombstonePruneResult {
  /** Record tombstones removed (bounded by served seq). */
  removed: number;
  /** File tombstones removed (bounded by push acknowledgement). */
  filesRemoved: number;
  /** Spaces left alone, by reason — logged so "nothing happened" is diagnosable rather than mysterious. */
  blocked: Record<string, number>;
  /** What the walk concluded: which spaces and halves failed, and whether it stopped. */
  walk: WalkResult<void>;
}

/**
 * Delete this space's tombstones at or below a floor already decided.
 *
 * Split from the config read so the DELETE can be exercised against a real MongoDB without a config file —
 * `$lte` on a mixed collection is exactly the kind of thing a hand-written matcher agrees with while the
 * driver does not. Takes the decision as a value and refuses to invent one: a `prune: false` floor deletes
 * nothing, which is the behaviour a caller that forgot to check must still get.
 *
 * Returns -1 when the floor said not to prune, and THROWS when the delete failed: a failure must reach the walk that says it,
 * and must never look like "there was nothing to remove". Nothing but a delete is done here, so a failure leaves the
 * collection as it was (a prune is by floor and idempotent: a delete the bound ended is finished by the next cycle).
 */
export async function pruneTombstonesToFloor(spaceId: string, floor: TombstoneFloor): Promise<number> {
  if (!floor.prune) return -1;
  const res = await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
    .deleteMany(asFilter<TombstoneDoc>({ seq: { $lte: floor.upTo } }));
  return res.deletedCount ?? 0;
}

/**
 * Prune every real (non-proxy) space — record tombstones by served seq, file tombstones by acknowledgement —
 * reporting what was skipped and why.
 *
 * The two halves are counted separately because their floors are independent: a space can be prunable for
 * records and blocked for files (a peer that pulls but never accepts a push) or the reverse.
 */
export async function pruneAllTombstones(): Promise<TombstonePruneResult> {
  const result: TombstonePruneResult = { removed: 0, filesRemoved: 0, blocked: {}, walk: { failed: [], outcomes: [], skipped: [] } };
  result.walk = await eachSpace(STEP, concreteSpaces(), async (s) => {
    // Read per space, not once before the loop: the prune awaits, and a floor must come from the networks as
    // they are when this space is pruned.
    const cfg = getConfig();
    const halves = [
      {
        name: 'record tombstones',
        run: async () => {
          const floor = tombstoneFloorForSpace(cfg, s.id);
          if (floor.prune) {
            const removed = await pruneTombstonesToFloor(s.id, floor);
            if (removed > 0) result.removed += removed;
          } else {
            result.blocked[floor.reason] = (result.blocked[floor.reason] ?? 0) + 1;
            if (floor.blockedBy) {
              log.debug(`Tombstone prune: space '${s.id}' held by '${floor.blockedBy}' (${floor.reason})`);
            }
          }
        },
      },
      {
        name: 'file tombstones',
        run: async () => {
          const fileFloor = fileTombstoneFloorForSpace(cfg, s.id);
          if (fileFloor.prune) {
            const removed = await pruneFileTombstonesToFloor(s.id, fileFloor);
            if (removed > 0) result.filesRemoved += removed;
          } else {
            result.blocked[fileFloor.reason] = (result.blocked[fileFloor.reason] ?? 0) + 1;
            if (fileFloor.blockedBy) {
              log.debug(`File tombstone prune: space '${s.id}' held by '${fileFloor.blockedBy}' (${fileFloor.reason})`);
            }
          }
        },
      },
    ];
    // Independent halves (their floors are): one failing does not stop the other, and a store-down or a timeout ends the space.
    await eachUnit(halves, half => half.run());
  });

  if (result.removed > 0) {
    log.info(`Tombstone prune: removed ${result.removed} tombstone(s) every peer has already applied`);
  }
  if (result.filesRemoved > 0) {
    // Worth its own line: this is the one that stops a deleted file's NAME being retained indefinitely.
    log.info(`Tombstone prune: removed ${result.filesRemoved} file tombstone(s) every peer has acknowledged`);
  }
  return result;
}

/**
 * Delete this space's FILE tombstones at or below an acknowledged position.
 *
 * Split from the config read for the same reason as the record version, and it needs its own query because the
 * key is a `deletedAt` string rather than a `seq`: ISO8601 UTC timestamps compare lexically in MongoDB, and a
 * document whose `deletedAt` is missing or malformed does not match `$lte` at all — which is the behaviour
 * relied on here, since an unparseable timestamp cannot be proven delivered.
 */
export async function pruneFileTombstonesToFloor(spaceId: string, floor: FileTombstoneFloor): Promise<number> {
  if (!floor.prune) return -1;
  // Published ones only: a pending tombstone was sent to no peer, so no acknowledgement covers it (bundle-30 I15).
  // A failure throws, as the record half's does: the walk says it.
  return await pruneFileTombstonesUpTo(spaceId, floor.upTo);
}

const pruneJob = intervalJob('Tombstone prune', PRUNE_INTERVAL_MS, () => pruneAllTombstones());

/**
 * Start the background prune. Always on: it only removes tombstones every peer has confirmed applying, so
 * there is no behaviour an operator would want to opt out of and nothing to configure wrong.
 */
export function startTombstonePrune(): void {
  if (pruneJob.armed) return;
  pruneJob.start();
  log.debug('Tombstone prune worker started');
}

export function stopTombstonePrune(): void {
  pruneJob.stop();
}


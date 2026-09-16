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
 */
import { col, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { runExclusive } from '../util/single-flight.js';
import { tombstoneFloorForSpace } from '../sync/served-watermark.js';
import type { TombstoneFloor } from '../sync/served-watermark.js';
import { fileTombstoneFloorForSpace } from '../sync/file-tombstone-ack.js';
import type { FileTombstoneFloor } from '../sync/file-tombstone-ack.js';
import type { TombstoneDoc, FileTombstoneDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/** Housekeeping, not correctness — a tombstone kept six hours too long costs nothing. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h

export interface TombstonePruneResult {
  /** Record tombstones removed (bounded by served seq). */
  removed: number;
  /** File tombstones removed (bounded by push acknowledgement). */
  filesRemoved: number;
  /** Spaces left alone, by reason — logged so "nothing happened" is diagnosable rather than mysterious. */
  blocked: Record<string, number>;
}

/**
 * Delete this space's tombstones at or below a floor already decided.
 *
 * Split from the config read so the DELETE can be exercised against a real MongoDB without a config file —
 * `$lte` on a mixed collection is exactly the kind of thing a hand-written matcher agrees with while the
 * driver does not. Takes the decision as a value and refuses to invent one: a `prune: false` floor deletes
 * nothing, which is the behaviour a caller that forgot to check must still get.
 *
 * Best-effort and fail-closed: any error leaves the collection alone and returns -1, so a bad read can never
 * look like "there was nothing to remove".
 */
export async function pruneTombstonesToFloor(spaceId: string, floor: TombstoneFloor): Promise<number> {
  if (!floor.prune) return -1;
  try {
    const res = await col<TombstoneDoc>(spaceCollection(spaceId, 'tombstones'))
      .deleteMany(asFilter<TombstoneDoc>({ seq: { $lte: floor.upTo } }));
    return res.deletedCount ?? 0;
  } catch (err) {
    log.warn(`Tombstone prune (${spaceId}): ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

/**
 * Prune one space's record tombstones to the floor its peers have earned.
 *
 * Returns the number removed, or -1 when the space was skipped, so the caller can report the two apart.
 */
export async function pruneSpaceTombstones(spaceId: string): Promise<number> {
  let floor: TombstoneFloor;
  try { floor = tombstoneFloorForSpace(getConfig(), spaceId); } catch { return -1; }
  return pruneTombstonesToFloor(spaceId, floor);
}

/**
 * Prune every real (non-proxy) space — record tombstones by served seq, file tombstones by acknowledgement —
 * reporting what was skipped and why.
 *
 * The two halves are counted separately because their floors are independent: a space can be prunable for
 * records and blocked for files (a peer that pulls but never accepts a push) or the reverse.
 */
export async function pruneAllTombstones(): Promise<TombstonePruneResult> {
  const result: TombstonePruneResult = { removed: 0, filesRemoved: 0, blocked: {} };
  let cfg;
  try { cfg = getConfig(); } catch { return result; }   // pre-setup

  for (const s of cfg.spaces) {
    if (s.proxyFor) continue;

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
  }

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
  try {
    const res = await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'))
      .deleteMany(asFilter<FileTombstoneDoc>({ deletedAt: { $lte: floor.upTo } }));
    return res.deletedCount ?? 0;
  } catch (err) {
    log.warn(`File tombstone prune (${spaceId}): ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  }
}

/** Prune one space's file tombstones to the position its peers have acknowledged. */
export async function pruneSpaceFileTombstones(spaceId: string): Promise<number> {
  let floor: FileTombstoneFloor;
  try { floor = fileTombstoneFloorForSpace(getConfig(), spaceId); } catch { return -1; }
  return pruneFileTombstonesToFloor(spaceId, floor);
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the background prune. Always on: it only removes tombstones every peer has confirmed applying, so
 * there is no behaviour an operator would want to opt out of and nothing to configure wrong.
 */
export function startTombstonePrune(): void {
  if (_timer) return;
  _timer = setInterval(() => { void runExclusive('Tombstone prune', () => pruneAllTombstones()); }, PRUNE_INTERVAL_MS);
  _timer.unref();   // never keep the process alive for housekeeping
  log.debug('Tombstone prune worker started');
}

export function stopTombstonePrune(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

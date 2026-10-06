/**
 * Record TTL sweep (F10) — the enforcement half.
 *
 * Periodically deletes every record whose `_expireAt` has passed, **through the normal delete
 * functions** so each deletion writes a `TombstoneDoc`, bumps `seq`, and fires the delete webhook —
 * making expiry correct in synced spaces (the tombstone propagates; the record can't resurrect from a
 * peer, which a below-the-app MongoDB TTL index would allow). Runs on every instance; each expires its
 * own copy and the tombstones converge.
 */
import { col, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log, peerText, peerList } from '../util/log.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';
import { TTL_COLLECTIONS, ensureTtlIndex } from './ttl.js';
import { deleteFact } from './fact.js';
import { deleteEntity } from './entities.js';
import { deleteEdge } from './edges.js';
import { deleteChrono } from './chrono.js';
import { deleteFileCascade } from '../files/delete-cascade.js';
import { runExclusive } from '../util/single-flight.js';
import { sweepChronoRetention } from './chrono-redaction.js';
import { sweepLegacySpills } from '../files/legacy-spill-sweep.js';
import { drainStrayFileMeta } from '../sync/stray-filemeta-drain.js';

const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min
const SWEEP_BATCH = 500;              // max deletions per collection per cycle
/**
 * The most delete attempts per collection per cycle, failed ones included. A cycle that reads past the records it already
 * tried (below) needs a ceiling of its own, or a collection of records that cannot be deleted costs a pass over all of them
 * every five minutes.
 */
const SWEEP_MAX_ATTEMPTS = 2000;
/** How many ids of the records a cycle could not delete the one line about them names. */
const SWEEP_FAILED_NAMED = 5;

/** Actor recorded on TTL-driven deletions (tombstone author + webhook attribution). */
const TTL_ACTOR: WebhookActor = { tokenLabel: 'ttl-sweep' };

const DELETERS: Record<(typeof TTL_COLLECTIONS)[number], (spaceId: string, id: string, actor?: WebhookActor) => Promise<boolean>> = {
  facts: deleteFact,
  entities: deleteEntity,
  edges: deleteEdge,
  chrono: deleteChrono,
  // A file record's `_id` is its path (toDocId); the full cascade removes blob + chunks + meta + jobs.
  files: (spaceId, id, actor) => deleteFileCascade(spaceId, id, actor).then(() => true),
};

/** Extra filter for the sweep query, per collection. Files: only the file-level records (chunk/face
 *  records carry `parentFileId` and never an `_expireAt`) and not already soft-deleted. */
const SWEEP_FILTER: Partial<Record<(typeof TTL_COLLECTIONS)[number], Record<string, unknown>>> = {
  files: { parentFileId: { $exists: false }, deletedAt: { $exists: false } },
};

/** Delete all records past their `_expireAt`, across every space. Returns the number deleted. */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  let cfg;
  try { cfg = getConfig(); } catch { return 0; } // pre-setup
  let total = 0;
  for (const space of cfg.spaces) {
    if (space.proxyFor?.length) continue; // proxy spaces own no collections
    for (const c of TTL_COLLECTIONS) {
      /*
       * Read PAST what this cycle already attempted. The read used to be the first `SWEEP_BATCH` expired ids, tried once: a record
       * whose delete threw stayed expired and was in that first page again next cycle, so with a page of them at the head nothing
       * behind them was ever deleted — retention an operator configured, kept past its window, and a line per record per cycle.
       * Now each read excludes the ids already tried, and the cycle ends at `SWEEP_BATCH` deletions or `SWEEP_MAX_ATTEMPTS` attempts.
       */
      const attempted: string[] = [];
      const failed: string[] = [];
      let firstFailure: unknown;
      let deleted = 0;
      while (deleted < SWEEP_BATCH && attempted.length < SWEEP_MAX_ATTEMPTS) {
        let expired;
        try {
          expired = await col(`${space.id}_${c}`)
            .find(asFilter({
              _expireAt: { $lte: now }, ...(SWEEP_FILTER[c] ?? {}),
              ...(attempted.length > 0 ? { _id: { $nin: attempted } } : {}),
            }), { projection: { _id: 1 } })
            .limit(Math.min(SWEEP_BATCH - deleted, SWEEP_MAX_ATTEMPTS - attempted.length))
            .toArray() as unknown as Array<{ _id: string }>;
        } catch { break; } // collection may not exist yet
        if (expired.length === 0) break;
        for (const { _id } of expired) {
          attempted.push(_id);
          try {
            if (await DELETERS[c](space.id, _id, TTL_ACTOR)) deleted++;
          } catch (err) {
            if (failed.length === 0) firstFailure = err;
            failed.push(_id);
          }
        }
      }
      total += deleted;
      // Said once for the collection and cycle, with the count and the first cause: one line per record is a line per record per cycle.
      if (failed.length > 0) {
        log.warn(`TTL sweep: ${failed.length} expired ${c} record(s) in ${peerText(space.id)} could not be deleted and were passed over `
          + `this cycle (${peerList(failed, ', ', { count: SWEEP_FAILED_NAMED })}): ${peerText(firstFailure)}`);
      }
    }
  }
  if (total > 0) log.info(`TTL sweep deleted ${total} expired record(s)`);

  // Per-chrono-type retention rides the same cycle: its backfill and content-redaction passes are the same
  // shape of work on the same clock, and running them here means one timer rather than two doing housekeeping
  // over the same collections. Failures are contained inside it — a retention problem must not stop deletions.
  await sweepChronoRetention(now).catch(err => log.warn(`Chrono retention sweep: ${peerText(err)}`));

  // Read spills older versions wrote into spaces (Q-92), on the same clock and every cycle: older peers keep
  // sending them until they upgrade. Contained like the pass above.
  await sweepLegacySpills().catch(err => log.warn(`Legacy spill sweep: ${peerText(err)}`));

  // File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` (Q-219). Contained like the passes above; a failed
  // drain keeps its collection and is retried next cycle.
  await drainStrayFileMeta().catch(err => log.warn(`Stray file-metadata drain: ${peerText(err)}`));

  return total;
}

let _sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Ensure the `_expireAt` sweep index exists on every non-proxy space, so the sweep query is indexed
 * regardless of whether a record's expiry came from the space-wide default (index also ensured at
 * setting-change time) or a per-record `ttlDays`. Idempotent; best-effort per space.
 */
async function ensureSweepIndexes(): Promise<void> {
  let cfg;
  try { cfg = getConfig(); } catch { return; } // pre-setup
  for (const space of cfg.spaces) {
    if (space.proxyFor?.length) continue;
    await ensureTtlIndex(space.id).catch(err => log.warn(`TTL sweep: ensureTtlIndex ${peerText(space.id)}: ${peerText(err)}`));
  }
}

/** Start the background TTL sweep. Call once during startup. */
export function startTtlSweep(): void {
  if (_sweepTimer) return;
  void ensureSweepIndexes();
  _sweepTimer = setInterval(() => { void runExclusive('TTL sweep', () => sweepExpired()); }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref(); // don't keep the process alive
  log.debug('TTL sweep worker started');
}

export function stopTtlSweep(): void {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}


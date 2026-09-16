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
import { log } from '../util/log.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';
import { TTL_COLLECTIONS, ensureTtlIndex } from './ttl.js';
import { deleteMemory } from './memory.js';
import { deleteEntity } from './entities.js';
import { deleteEdge } from './edges.js';
import { deleteChrono } from './chrono.js';
import { deleteFileCascade } from '../files/delete-cascade.js';
import { runExclusive } from '../util/single-flight.js';
import { sweepChronoRetention } from './chrono-redaction.js';

const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min
const SWEEP_BATCH = 500;              // max deletions per collection per cycle

/** Actor recorded on TTL-driven deletions (tombstone author + webhook attribution). */
const TTL_ACTOR: WebhookActor = { tokenLabel: 'ttl-sweep' };

const DELETERS: Record<(typeof TTL_COLLECTIONS)[number], (spaceId: string, id: string, actor?: WebhookActor) => Promise<boolean>> = {
  facts: deleteMemory,
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
      let expired;
      try {
        expired = await col(`${space.id}_${c}`)
          .find(asFilter({ _expireAt: { $lte: now }, ...(SWEEP_FILTER[c] ?? {}) }), { projection: { _id: 1 } })
          .limit(SWEEP_BATCH)
          .toArray() as unknown as Array<{ _id: string }>;
      } catch { continue; } // collection may not exist yet
      for (const { _id } of expired) {
        try {
          if (await DELETERS[c](space.id, _id, TTL_ACTOR)) total++;
        } catch (err) {
          log.warn(`TTL sweep: delete ${c} ${_id} in ${space.id}: ${err}`);
        }
      }
    }
  }
  if (total > 0) log.info(`TTL sweep deleted ${total} expired record(s)`);

  // Per-chrono-type retention rides the same cycle: its backfill and content-redaction passes are the same
  // shape of work on the same clock, and running them here means one timer rather than two doing housekeeping
  // over the same collections. Failures are contained inside it — a retention problem must not stop deletions.
  await sweepChronoRetention(now).catch(err => log.warn(`Chrono retention sweep: ${err}`));

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
    await ensureTtlIndex(space.id).catch(err => log.warn(`TTL sweep: ensureTtlIndex ${space.id}: ${err}`));
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

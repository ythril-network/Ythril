/**
 * Record TTL sweep (F10) — the enforcement half.
 *
 * Periodically deletes every record whose `_expireAt` has passed, **through the normal delete
 * functions** so each deletion writes a `TombstoneDoc`, bumps `seq`, and fires the delete webhook —
 * making expiry correct in synced spaces (the tombstone propagates; the record can't resurrect from a
 * peer, which a below-the-app MongoDB TTL index would allow). Runs on every instance; each expires its
 * own copy and the tombstones converge.
 *
 * ## What a cycle does, and what each failure of it means (`Q-359`, `Q-274`, `Q-358`)
 *
 * The cycle is a walk over the spaces (`eachSpace`, `util/housekeeping-walk.ts`) and, inside a space, over its collections
 * (`eachUnit`). Every database operation of it, the deleters' internal ones included, ends at the housekeeping bound. So:
 *
 *  - **a failing space does not stop the walk**, and a hung one is ended at its bound and passed over for a while;
 *  - **a collection whose read fails is said**, under its own step (`TTL sweep: <collection>`), and the collections after it are
 *    still swept. A missing collection never throws (a read of one is an empty page), so nothing needs to be swallowed;
 *  - **a timeout ends the SPACE** (the next collection would only cost another bound against the same hung space), and a store
 *    that does not answer ends the WALK, once;
 *  - **a record that keeps failing to delete is passed over, not retried until the cycle ends** ({@link sweepCollection}).
 *
 * ## The 500-per-cycle throttle, and why a failing record cannot starve the rest
 *
 * {@link SWEEP_BATCH} counts SUCCESSFUL deletes per collection per cycle. The sweep used to read one page of that size and delete
 * it in order: a head of 500 records whose deletes all failed deleted nothing, the next cycle read the same head, and every expired
 * record behind it waited for ever (one log line per failed record per cycle). It now reads page after page, excluding every id it
 * has already asked about, until the throttle is met, a page holds nothing new, or {@link ATTEMPT_CAP} ids have been tried.
 */
import { col, asFilter } from '../db/mongo.js';
import { storeAnswers as defaultStoreAnswers } from '../db/store-answers.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { eachSpace, eachUnit, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep, signalHousekeeping } from '../util/housekeeping-signals.js';
import { intervalJob } from '../util/interval-job.js';
import { LIVE_FILE_ROW } from '../files/live-file-row.js';
import { NotFoundError } from '../util/errors.js';
import { log, peerList, peerText } from '../util/log.js';
import { defaultSpaceFailureReporter, walkVerdict, type SpaceFailureReporter } from '../util/space-failure.js';
import type { WebhookActor } from '../webhooks/dispatcher.js';
import { TTL_COLLECTIONS, ensureTtlIndex } from './ttl.js';
import { deleteFact } from './fact.js';
import { deleteEntity } from './entities.js';
import { deleteEdge } from './edges.js';
import { deleteChrono } from './chrono.js';
import { deleteFileCascade } from '../files/delete-cascade.js';
import { settleStalePendingFileTombstones } from '../files/tombstones.js';
import { sweepChronoRetention } from './chrono-redaction.js';
import { sweepLegacySpills } from '../files/legacy-spill-sweep.js';
import { drainStrayFileMeta } from '../sync/stray-filemeta-drain.js';
import { retirePeerSidecars } from '../sync/peer-sidecar-retirement.js';

/** How often the sweep runs, ms. Cited by the docs (`doc-cited-constants`). */
export const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min
/** The most SUCCESSFUL deletions per collection per cycle. A record that fails does not count against it. */
export const SWEEP_BATCH = 500;
/** The most ids one collection asks the store about in a cycle, whatever came of them: keeps the exclusion list (`$nin`) small. */
export const ATTEMPT_CAP = 2000;
/** How many ids of the records that failed a collection's line names. */
const SAMPLE_IDS = 5;

type TtlCollection = (typeof TTL_COLLECTIONS)[number];

const STEP = declareStep('TTL sweep');
const SETTLE_STEP = declareStep('TTL sweep: settling file tombstones');
const INDEX_STEP = declareStep('TTL sweep: indexes');
/** The step a collection's READ failure is said under. */
const readStep = (c: TtlCollection): string => `TTL sweep: ${c}`;
/** The step a collection's DELETE failures are said under, and counted by record under. */
const deleteStep = (c: TtlCollection): string => `TTL sweep: ${c} delete`;
for (const c of TTL_COLLECTIONS) { declareStep(readStep(c)); declareStep(deleteStep(c)); }

/** Actor recorded on TTL-driven deletions (tombstone author + webhook attribution). */
const TTL_ACTOR: WebhookActor = { tokenLabel: 'ttl-sweep' };

const DELETERS: Record<TtlCollection, (spaceId: string, id: string, actor?: WebhookActor) => Promise<boolean>> = {
  facts: deleteFact,
  entities: deleteEntity,
  edges: deleteEdge,
  chrono: deleteChrono,
  // A file record's `_id` is its path (toDocId); the full cascade removes blob + chunks + meta + jobs.
  files: (spaceId, id, actor) => deleteFileCascade(spaceId, id, actor).then(() => true),
};

/** Delete one expired record through its normal deleter. False = the deleter matched nothing (see {@link sweepCollection}). */
function removeExpired(spaceId: string, c: TtlCollection, id: string): Promise<boolean> {
  return DELETERS[c](spaceId, id, TTL_ACTOR);
}

/** Up to `limit` ids of the collection's expired records, none of them in `exclude`. */
async function expiredPage(spaceId: string, c: TtlCollection, now: Date, exclude: string[], limit: number): Promise<string[]> {
  // Files: the file-level records only — a chunk or face row carries `parentFileId` and never an `_expireAt` — and
  // never a row a soft delete already flagged. A flagged row's own retention is the separate question, run from
  // `deletedAt` by its own unit; this one would hand the audit record to `deleteFileCascade` on the next sweep.
  const files = c === 'files' ? LIVE_FILE_ROW : {};
  const filter = { _expireAt: { $lte: now }, ...files, ...(exclude.length > 0 ? { _id: { $nin: exclude } } : {}) };
  // The deadline is the housekeeping scope's (`withinHousekeepingBound`), never chained on the cursor (Q-358).
  const docs = await col(`${spaceId}_${c}`).find(asFilter(filter), { projection: { _id: 1 }, limit }).toArray() as unknown as Array<{ _id: string }>;
  return docs.map(d => d._id);
}

/** Is the record still stored? */
async function isStored(spaceId: string, c: TtlCollection, id: string): Promise<boolean> {
  // The same question as the page above, so the same narrowing: with `softDeleteFileMeta` a flagged row is what a
  // successful file delete LEAVES, and reading it as "still stored" would report a clean delete as a stuck record.
  return (await col(`${spaceId}_${c}`)
    .findOne(asFilter({ _id: id, ...(c === 'files' ? LIVE_FILE_ROW : {}) }), { projection: { _id: 1 } })) !== null;
}

/**
 * The seams of {@link sweepCollection}: the store, the deleter, the ping and where lines go. The defaults are the real ones.
 * A test seam only: production code passes none (the sweep passes `remove`, to count what it deleted whatever ends the loop).
 */
export interface SweepDeps {
  page?: (spaceId: string, c: TtlCollection, now: Date, exclude: string[], limit: number) => Promise<string[]>;
  remove?: (spaceId: string, c: TtlCollection, id: string) => Promise<boolean>;
  exists?: (spaceId: string, c: TtlCollection, id: string) => Promise<boolean>;
  storeAnswers?: () => Promise<boolean>;
  reporter?: SpaceFailureReporter;
}

export interface SweepOutcome {
  /** Records the deleter said it deleted (never more than {@link SWEEP_BATCH}). */
  deleted: number;
  /** Records that failed to delete this cycle. */
  failed: number;
  /** The attempt cap was reached before the throttle was met: records past it wait for the next cycle. */
  capped: boolean;
}

/**
 * Sweep ONE collection of ONE space: delete its expired records, at most {@link SWEEP_BATCH}, without letting a record that fails to
 * delete hold up the ones behind it.
 *
 * ## What it prevents
 *
 * **A head of failing records starving the rest.** Pages are read until the throttle is met, excluding every id already asked about
 * (the attempted set), so a failing record costs one attempt a cycle and nothing else. The attempted set is capped at
 * {@link ATTEMPT_CAP}; reaching it is said ("N+ records keep failing; the rest wait for the next cycle"), the one residual
 * starvation, stated. A page with no id the loop has not tried ends the collection, so a store that ignores the exclusion
 * cannot make it loop.
 *
 * ## What a deleter's answer means
 *
 * `true` is a delete. `false` is "nothing matched" and is READ: the record gone is a concurrent delete (not a failure, not
 * counted); the record still stored is a failure ("no record of this space matched" — a record stored under another space's id),
 * which the loop must not repeat. A files `NotFoundError` is the record already gone: neither failed nor counted.
 *
 * ## What it reports, and what it lets propagate
 *
 * An ordinary failure of a delete is collected and said ONCE for the collection when the loop ends, in a `finally` so an early
 * exit still says what failed before it: one line with the count and up to {@link SAMPLE_IDS} ids, and `records-failed` by the
 * count (so a rate of records, not of lines). A failure the walk must decide on — the store's, or a timeout of a bound
 * (`walkVerdict`, awaited) — is RETHROWN and is not counted here: `eachUnit` and the walk say it, once, for the space.
 * A failure of the READ is the walk's too: it is not swallowed as "the collection may not exist yet" (a missing collection reads empty).
 */
export async function sweepCollection(spaceId: string, c: TtlCollection, now: Date, deps: SweepDeps = {}): Promise<SweepOutcome> {
  const page = deps.page ?? expiredPage;
  const remove = deps.remove ?? removeExpired;
  const exists = deps.exists ?? isStored;
  const storeAnswers = deps.storeAnswers ?? defaultStoreAnswers;
  const reporter = deps.reporter ?? defaultSpaceFailureReporter;

  const attempted = new Set<string>();
  const failed: string[] = [];
  let firstFailure: unknown;
  let deleted = 0;
  let ended = false;
  const fail = (id: string, err: unknown): void => { failed.push(id); firstFailure ??= err; };

  try {
    while (deleted < SWEEP_BATCH && attempted.size < ATTEMPT_CAP) {
      const limit = Math.min(SWEEP_BATCH - deleted, ATTEMPT_CAP - attempted.size);
      const fresh = (await page(spaceId, c, now, [...attempted], limit)).filter(id => !attempted.has(id));
      if (fresh.length === 0) break;
      for (const id of fresh) {
        attempted.add(id);
        try {
          if (await remove(spaceId, c, id)) deleted++;
          else if (await exists(spaceId, c, id)) fail(id, new Error('no record of this space matched'));
        } catch (err) {
          if (c === 'files' && err instanceof NotFoundError) continue; // already gone
          if (await walkVerdict(err, { storeAnswers }) !== 'space-failure') throw err; // the walk's to decide
          fail(id, err);
        }
      }
    }
    ended = true;
  } finally {
    if (failed.length > 0) {
      const capped = attempted.size >= ATTEMPT_CAP && deleted < SWEEP_BATCH;
      const more = failed.length - SAMPLE_IDS;
      const ids = `ids: ${peerList(failed.slice(0, SAMPLE_IDS))}${more > 0 ? `, and ${more} more` : ''}`;
      const why = `${peerText(firstFailure)} (${ids})${capped ? `; ${failed.length}+ records keep failing; the rest wait for the next cycle` : ''}`;
      reporter.spaceFailure(deleteStep(c), spaceId, new Error(why), { unit: c, when: 'next cycle', count: failed.length });
      signalHousekeeping({ type: 'records-failed', step: deleteStep(c), count: failed.length });
    } else if (ended) {
      reporter.recovered(deleteStep(c), spaceId);
    }
  }
  return { deleted, failed: failed.length, capped: attempted.size >= ATTEMPT_CAP && deleted < SWEEP_BATCH && failed.length > 0 };
}

/**
 * The retention walk alone: every concrete space, every TTL collection, through {@link sweepCollection}. Returns what it deleted
 * and what the walk concluded (`storeDown`, `stalled`, who failed), for the one test that asks whether a frozen store costs one
 * bound. `sweepExpired` is the cycle; this is its first step.
 */
export async function sweepExpiredRecords(now: Date): Promise<{ deleted: number; walk: WalkResult<void> }> {
  let deleted = 0;
  // Counted at the deleter, so a collection that ends in a propagated failure still counts what it deleted before it.
  const counting = async (spaceId: string, c: TtlCollection, id: string): Promise<boolean> => {
    const ok = await removeExpired(spaceId, c, id);
    if (ok) deleted++;
    return ok;
  };
  const walk = await eachSpace(STEP, concreteSpaces(), async (space, ctx) => {
    await eachUnit(TTL_COLLECTIONS, async (c) => {
      ctx.step = readStep(c);
      await sweepCollection(space.id, c, now, { remove: counting });
    });
  });
  return { deleted, walk };
}

/** Delete all records past their `_expireAt`, across every space. Returns the number deleted. */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  const { deleted: total } = await sweepExpiredRecords(now);
  if (total > 0) log.info(`TTL sweep deleted ${total} expired record(s)`);

  // File tombstones still pending after their act should have finished: its drop failed, its write landed after it
  // was reported failed, or a restart came between. Settled from the disk (bundle-30 I15, `files/tombstones.ts`):
  // never served while pending, so nothing waits on this but the record of a removal that did happen.
  await eachSpace(SETTLE_STEP, concreteSpaces(), space => settleStalePendingFileTombstones(space.id, now));

  // Per-chrono-type retention rides the same cycle: its backfill and content-redaction passes are the same
  // shape of work on the same clock, and running them here means one timer rather than two doing housekeeping
  // over the same collections. The catch is the last resort: a retention problem must not stop the passes after it.
  // It does NOT isolate the pass's own spaces; that is the pass's (`brain/chrono-redaction.ts`).
  await sweepChronoRetention(now).catch(err => log.warn(`Chrono retention sweep: ${peerText(err)}`));

  // Read spills older versions wrote into spaces (Q-92), on the same clock and every cycle: older peers keep
  // sending them until they upgrade. The catch is the last resort, as above.
  await sweepLegacySpills().catch(err => log.warn(`Legacy spill sweep: ${peerText(err)}`));
  await retirePeerSidecars().catch(err => log.warn(`Peer sidecar retirement: ${peerText(err)}`));

  // File metadata a 4.0-5.6.1 pull left in `<space>_filemeta` (Q-219), a bounded amount per cycle. Each space is
  // contained inside it and logs its own failure by name; this catch is for what happens before any space.
  await drainStrayFileMeta().catch(err => log.warn(`Stray file-metadata drain: ${peerText(err)}`));

  return total;
}

/**
 * Ensure the `_expireAt` sweep index exists on every non-proxy space, so the sweep query is indexed
 * regardless of whether a record's expiry came from the space-wide default (index also ensured at
 * setting-change time) or a per-record `ttlDays`. Idempotent; a failing space is said and the walk goes on.
 *
 * `ensureTtlIndex`'s `createIndex` is deliberately not bounded by the housekeeping figure: an index build scales with the data
 * in the collection, so a figure sized for a read or a single write would end a legitimate build and leave the sweep unindexed.
 */
async function ensureSweepIndexes(): Promise<void> {
  await eachSpace(INDEX_STEP, concreteSpaces(), space => ensureTtlIndex(space.id));
}

const sweepJob = intervalJob('TTL sweep', SWEEP_INTERVAL_MS, () => sweepExpired());

/** Start the background TTL sweep. Call once during startup. */
export function startTtlSweep(): void {
  if (sweepJob.armed) return;
  void ensureSweepIndexes().catch(err => log.warn(`TTL sweep: ensuring the sweep indexes: ${peerText(err)}`));
  sweepJob.start();
  log.debug('TTL sweep worker started');
}

export function stopTtlSweep(): void {
  sweepJob.stop();
}

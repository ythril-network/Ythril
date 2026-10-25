/**
 * Does this space owe its positions? - the read side every sync door and reader asks (bundle-81, design rev 8 §3 "The owed marker").
 *
 * ## The question it answers
 *
 * A space OWES its positions while its `ythril_counters` document carries `positionsOwed` (`'carry'` or `'repair'`): rows without a position are
 * not yet paged by the position stream, so serving or storing them would hide records behind a mark. While it owes, every sync door answers
 * `503 positions_building`, which a sender reads as HELD (it moves no mark and counts no member failure), and every non-door reader (the scanners,
 * the push reader, the file-stamp report) skips the space for the tick.
 *
 * ## Why a leaf of its own
 *
 * The doors and the position readers ask it, and the module that WRITES the marker and does the work (`sync/positions-owed.ts`: the carry, the repair, the
 * detector, the job) reads and writes records through those same readers. Asked from there, the question would be an import cycle, so the read side lives here
 * and imports nothing of sync. `sync/positions-owed.ts` re-exports it, so a caller that wants "the owed marker" finds one name.
 *
 * ## What it holds
 *
 * {@link positionsOwed}, {@link positionsReady} (a yes is remembered for 10 minutes in a bounded LRU; a no and a store that does not
 * answer are read again), {@link forgetPositionsReady} (every writer of the counter document that changes readiness calls it) and
 * {@link assertPositionsReady}, which throws {@link PositionsBuilding}; and the one hold the re-upgrade detector needs: from boot until it has run
 * ({@link holdPositionsUntilDetected}), every space reads as owing, so no transfer can run on a position a 5.6 build left stale.
 *
 * Fails towards HELD: a store that does not answer is not "ready" (the read throws and nothing is cached), so a door answers the store's own 503.
 */
import { col, asFilter } from '../db/mongo.js';
import { LruMap } from '../util/lru-map.js';
import { outsideWriteBound } from '../db/write-bound.js';
import { PositionsBuilding } from '../util/errors.js';

/** What a space owes: its first carry (`'carry'`) or the repair after a 5.6 build changed rows (`'repair'`). */
export type PositionsOwed = 'carry' | 'repair';

/** How long the server may spend on the one counter document, ms. */
const READ_MS = 5_000;

interface CounterDoc { _id: string; positionsOwed?: unknown }
/** The collection the marker lives in: one document per space. */
export const COUNTERS = 'ythril_counters';

/**
 * The pipeline stage an UPSERT of a space's counter document carries, so a document the upsert CREATES is ready (`positionsReadyAt`) and never one with neither
 * marker field: such a document is what a 5.6 build leaves, and the re-upgrade detector would repair its space. A document that exists, or that already says
 * what its space owes, is left as it is (an expression that evaluates to a missing field adds none). Put FIRST in the pipeline, where `seq` is still as stored.
 */
export function readyWhenCreated(at: string = new Date().toISOString()): Record<string, unknown> {
  const absent = (field: string) => ({ $eq: [{ $type: field }, 'missing'] });
  return { $set: { positionsReadyAt: { $cond: [{ $and: [absent('$seq'), absent('$positionsOwed')] }, at, '$positionsReadyAt'] } } };
}

/** What the space owes, or `undefined` when it owes nothing. Read from the store, never cached. */
export async function positionsOwed(spaceId: string): Promise<PositionsOwed | undefined> {
  // Outside the caller's bound scope, with a figure of its own: a read in a scope carries the driver's `timeoutMS`, which retries a failed server selection until it runs out,
  // and this is the FIRST store operation of every sync door. `maxTimeMS` ends it at the server; the driver's own selection timeout ends it at the client.
  const doc = await outsideWriteBound(() => col<CounterDoc>(COUNTERS).findOne(asFilter<CounterDoc>({ _id: spaceId }), { projection: { positionsOwed: 1 }, maxTimeMS: READ_MS }));
  const owed = doc?.positionsOwed;
  return owed === 'carry' || owed === 'repair' ? owed : undefined;
}

/**
 * When each space was last read as READY, for how long that is believed. Sized for every space of the instance: a bound below the number of spaces would
 * make each read of an evicted one a store read.
 *
 * Only a yes is remembered. A "no" (the space owes) is read again every time, because it is cheap (one counter document) and a door must notice the
 * moment a build finishes; and a store that did not answer is never remembered. It is NOT a shared probe (`util/cached-probe.ts`): a probe is asked once for
 * every caller that arrives while it is in flight, so its read ran under ONE caller's bound and its failure was answered a second time by a confirming read,
 * two waits on a store that is down for every request (`a-store-failure-answers-alike-on-every-door-db`).
 */
const readyUntil = new LruMap<string, number>(50_000);
const READY_TTL_MS = 10 * 60_000;

/**
 * Until the re-upgrade detector has run this boot, every space reads as owing: a 5.6 build may have changed rows without a position, and a transfer on
 * that space would serve or store them behind a mark. Armed at the top of the boot, released by the detector's first success (`detectReupgrade`); the job
 * retries the detector while it is held, so a hiccup in the first pass costs held transfers and never a stale position.
 */
let unchecked = false;

/** Arm the hold: every space owes until {@link releasePositionsHold}. Called once, at the top of a boot. */
export function holdPositionsUntilDetected(): void {
  unchecked = true;
  readyUntil.clear();
}

/** The detector ran: spaces read as their counter documents say. */
export function releasePositionsHold(): void {
  unchecked = false;
  readyUntil.clear();
}

/** Has the boot's re-upgrade check still to run? The job asks it to know it must retry the detector. */
export const positionsHeldUntilDetected = (): boolean => unchecked;

/** What the space owes now, from the store unless it was read as ready lately. A store that does not answer THROWS: the caller answers its own 503. */
async function owedNow(spaceId: string): Promise<PositionsOwed | undefined> {
  if (unchecked) return 'repair';
  const until = readyUntil.get(spaceId);
  if (until !== undefined && until > Date.now()) return undefined;
  const owed = await positionsOwed(spaceId);
  if (owed === undefined) readyUntil.set(spaceId, Date.now() + READY_TTL_MS); else readyUntil.delete(spaceId);
  return owed;
}

/** Is the space ready: does it owe nothing? A store that did not answer is `false` and is not remembered (the caller that needs the CAUSE asks {@link assertPositionsReady}). */
export async function positionsReady(spaceId: string): Promise<boolean> {
  try { return (await owedNow(spaceId)) === undefined; } catch { return false; }
}

/** Forget what is cached for `spaceId` (all spaces without one): every in-process writer of the marker calls it, and a test that sets the marker directly. */
export function forgetPositionsReady(spaceId?: string): void {
  if (spaceId === undefined) readyUntil.clear(); else readyUntil.delete(spaceId);
}

/**
 * Throw {@link PositionsBuilding} unless the space is ready. The one check a door, a reader or a walk asks. One store read at most, under the CALLER's bound:
 * a store that does not answer throws from here, and the door answers its own 503.
 */
export async function assertPositionsReady(spaceId: string): Promise<void> {
  if (await owedNow(spaceId) !== undefined) throw new PositionsBuilding(spaceId);
}

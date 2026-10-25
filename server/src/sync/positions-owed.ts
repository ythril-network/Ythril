/**
 * Does this space owe its positions? — the readiness every sync door and reader asks (bundle-81, design rev 8 §3 "The owed marker").
 *
 * ## The question it answers
 *
 * A space OWES its positions while its `ythril_counters` document carries `positionsOwed` (`'carry'` or `'repair'`): rows without a position are
 * not yet paged by the position stream, so serving or storing them would hide records behind a mark. While it owes, every sync door answers
 * `503 positions_building`, which a sender reads as HELD (it moves no mark and counts no member failure), and every non-door reader (the scanners,
 * the push reader, the file-stamp report) skips the space for the tick.
 *
 * ## What it holds, and what a later part of the bundle adds
 *
 * This module holds the READ side: {@link positionsOwed}, {@link positionsReady} (a yes is remembered for 10 minutes in a bounded LRU; a no and a store that does not
 * answer are read again), {@link forgetPositionsReady} (every writer of the counter document that
 * changes readiness calls it) and {@link assertPositionsReady}, which throws {@link PositionsBuilding}. The writers of the marker (the first carry,
 * the repair, the owed job) are the upgrade's, and join this module there; readiness there also needs `positionsReadyAt` and the index.
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
const COUNTERS = 'ythril_counters';

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

/** What the space owes now, from the store unless it was read as ready lately. A store that does not answer THROWS: the caller answers its own 503. */
async function owedNow(spaceId: string): Promise<PositionsOwed | undefined> {
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

import { col, asFilter, asUpdate } from '../db/mongo.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { log } from './log.js';
import type { SpaceCounterDoc } from '../config/types.js';

/*
 * ── Allocation carries its write (`Q-196`) ──────────────────────────────────────────────────────────────────
 *
 * A seq is allocated in one round trip and the record that carries it is written in another. Everything that
 * pages by seq — the pull routes, the push loop, the tombstone pages, the scanners — serves `seq > cursor` and
 * moves its cursor to the highest seq it saw. So a write that allocated 7 and has not committed yet, beside a
 * write that allocated 8 and has, lets a reader take 8, move past 7, and never come back for it: a record lost
 * to one peer for ever, with every later cycle reporting nothing to do.
 *
 * **The rule: no seq-paged reader is handed a seq at or above one that is allocated and not yet settled.**
 * Two halves make it hold, and each is the half a hand-written copy would drop:
 *
 *   - `withAllocatedSeqs` takes the WRITE with the allocation and releases in a `finally`. A bare allocator
 *     returning a number cannot know when its write settles, so it cannot be released — which is why there is
 *     no exported `nextSeq` any more. A write that throws releases too, or the horizon would stick and every
 *     pull of the space would stall below it.
 *   - The registry is entered BEFORE the `$inc` is sent, as a bound rather than a number. The seq is unknown
 *     until the reply arrives, and a reader asking in between must still stop below it. Any seq Mongo hands
 *     this allocation is above every seq this process had seen when it asked, so `maxSeen + 1` is a safe floor.
 *
 * And `settledSeqRange` caps a reader at `maxSeen + 1` when nothing is in flight, because an allocation that
 * starts after the reader computed its range, and a later one that commits before the reader's query runs,
 * would otherwise slip a committed seq past an uncommitted one in exactly the same way.
 *
 * In-process, and that is sufficient: one server process owns a space's counter. `maxSeen` is seeded from the
 * counter document on first use, and `bumpSeq` (an ingest moving the counter) advances it, so a record that
 * arrived from a peer is not hidden behind a stale bound.
 */
interface SeqState {
  /** The highest seq this process has seen allocated or bumped to; undefined until seeded. */
  maxSeen: number | undefined;
  /** Floors of allocations sent and not yet answered, and seqs answered and not yet settled. Multiset. */
  inFlight: Map<number, number>;
}
const seqState = new Map<string, SeqState>();

function stateOf(spaceId: string): SeqState {
  let s = seqState.get(spaceId);
  if (!s) { s = { maxSeen: undefined, inFlight: new Map() }; seqState.set(spaceId, s); }
  return s;
}

function hold(s: SeqState, seq: number): void { s.inFlight.set(seq, (s.inFlight.get(seq) ?? 0) + 1); }
function release(s: SeqState, seq: number): void {
  const n = (s.inFlight.get(seq) ?? 0) - 1;
  if (n > 0) s.inFlight.set(seq, n); else s.inFlight.delete(seq);
}

async function seededState(spaceId: string): Promise<SeqState> {
  const s = stateOf(spaceId);
  if (s.maxSeen === undefined) {
    const seeded = await currentSeq(spaceId);
    // Another caller may have allocated while the read was out; never move the bound backwards.
    s.maxSeen = Math.max(s.maxSeen ?? 0, seeded);
  }
  return s;
}

/**
 * Allocate `n` consecutive seqs for one space and run `write` with the first. The block is registered as in
 * flight before the allocation is sent and released when `write` settles, success or failure.
 *
 * `write` should be the record write and nothing else: everything awaited inside it holds every seq-paged
 * reader of this space below the block (`a-seq-allocation-is-followed-by-its-write` holds the writers to it).
 */
export async function withAllocatedSeqs<T>(spaceId: string, n: number, write: (first: number) => Promise<T>): Promise<T> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`withAllocatedSeqs: n must be a positive integer, got ${n}`);
  const s = await seededState(spaceId);
  const floor = (s.maxSeen ?? 0) + 1;
  hold(s, floor);
  let first: number | undefined;
  try {
    const result = await col<SpaceCounterDoc>('ythril_counters').findOneAndUpdate(
      { _id: spaceId },
      { $inc: { seq: n } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!result) throw new Error(`Failed to increment sequence counter for space ${spaceId}`);
    first = result.seq - n + 1;
    hold(s, first);
    release(s, floor);
    if (result.seq > (s.maxSeen ?? 0)) s.maxSeen = result.seq;
    return await write(first);
  } finally {
    if (first === undefined) release(s, floor);
    else release(s, first);
  }
}

/**
 * Hold the horizon for the whole of `fn`: every seq allocated while it runs stays unsettled until it returns.
 *
 * For a TRANSACTION. Inside a session a write that returns has not committed — the commit is the session's —
 * so `withAllocatedSeqs` releasing when its write returns would hand a reader a seq whose record is not yet
 * visible, and the reader would step past it. Any seq allocated after this call starts is at or above the
 * floor it registers, so holding the floor holds them all.
 */
export async function withSeqHorizonHeld<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const s = await seededState(spaceId);
  const floor = (s.maxSeen ?? 0) + 1;
  hold(s, floor);
  try { return await fn(); } finally { release(s, floor); }
}

/** One seq: `withAllocatedSeqs(spaceId, 1, write)`. */
export function withSeq<T>(spaceId: string, write: (seq: number) => Promise<T>): Promise<T> {
  return withAllocatedSeqs(spaceId, 1, write);
}

/** The lowest seq allocated (or being allocated) and not yet settled, or undefined when none is. */
export function lowestUncommittedSeq(spaceId: string): number | undefined {
  const s = seqState.get(spaceId);
  if (!s || s.inFlight.size === 0) return undefined;
  return Math.min(...s.inFlight.keys());
}

/**
 * The seq range a seq-paged reader may be handed after `since`: `{ $gt: since, $lt: horizon }`. The horizon is
 * the lowest unsettled seq, or one past the highest seq this process knows of when nothing is in flight.
 * Every seq-paged read goes through this — a reader that builds `{ $gt }` by hand is the defect.
 */
export async function settledSeqRange(spaceId: string, since: number): Promise<{ $gt: number; $lt: number }> {
  const s = await seededState(spaceId);
  const lowest = lowestUncommittedSeq(spaceId);
  return { $gt: since, $lt: lowest ?? (s.maxSeen ?? 0) + 1 };
}

/*
 * A block (`n > 1` above) keeps the contract the old `reserveSeqBlock` had and that is easy to get wrong:
 * GAPS are safe — a write that fails leaves its seqs unused and nothing pages over a hole incorrectly — but
 * REUSE is not, so a block is never handed out twice and a re-planned write allocates a fresh one.
 */
/** Read the current counter for a space (0 when it does not exist yet). */
export async function currentSeq(spaceId: string): Promise<number> {
  const doc = await col<SpaceCounterDoc>('ythril_counters')
    .findOne(asFilter<SpaceCounterDoc>({ _id: spaceId })) as SpaceCounterDoc | null;
  return doc?.seq ?? 0;
}

/**
 * The protocol sequence ceiling (mirrors `MAX_SYNC_SEQ` in api/sync.ts, where
 * incoming docs are Zod-validated to `<= 2^50`). A document at or above this
 * cannot be represented, so it is never a legitimate value on the wire.
 */
export const MAX_SYNC_SEQ = 2 ** 50;

/**
 * Headroom kept below `MAX_SYNC_SEQ`. Ingesting a document advances the space
 * counter (`bumpSeq`) so local writes always sort above synced ones — so a peer
 * that pushes one document with `seq` near the ceiling drags the counter there,
 * and the space's *next* local write exceeds `MAX_SYNC_SEQ` and is rejected by
 * every peer: silent, unrecoverable write loss.
 *
 * The guard is absolute rather than relative to the current counter: legitimate
 * seqs are small monotonic counters (an allocation increments by its block size), so they sit far
 * below `MAX_SYNC_SEQ - SEQ_CEILING_RESERVE` regardless of a space's history,
 * while the poisoning value (near 2^50) is caught. A relative "max jump" guard
 * would instead false-positive on the initial sync of a high-volume space to a
 * fresh peer. 2^40 (~1.1e12) of reserve leaves an unreachable number of future
 * writes before the ceiling.
 */
export const SEQ_CEILING_RESERVE = 2 ** 40;

/** The highest `seq` an ingested document may carry. */
export const MAX_INGEST_SEQ = MAX_SYNC_SEQ - SEQ_CEILING_RESERVE;

/**
 * True when `seq` is out of range or so close to the protocol ceiling that
 * ingesting it would strand the space's counter. Callers reject such documents.
 * Synchronous — the bound does not depend on the current counter.
 */
export function isSeqImplausible(seq: number): boolean {
  return !Number.isFinite(seq) || seq < 0 || seq > MAX_INGEST_SEQ;
}

/**
 * Ensure the space counter is at least `minSeq`.
 * Called after receiving remote documents via sync so that subsequent local
 * writes always get a seq higher than any synced document.
 * Uses $max — only advances the counter, never decreases it.
 *
 * The advance is CLAMPED to `MAX_INGEST_SEQ`: ingest paths already refuse
 * documents above it, and this is the backstop that keeps a stray value from
 * stranding the counter within `SEQ_CEILING_RESERVE` of the ceiling.
 */
export async function bumpSeq(spaceId: string, minSeq: number): Promise<void> {
  if (minSeq > MAX_INGEST_SEQ) {
    log.warn(
      `Clamped seq bump for space '${spaceId}': requested ${minSeq} exceeds ` +
      `MAX_INGEST_SEQ (${MAX_INGEST_SEQ}) — advancing to the ceiling reserve instead.`,
    );
    minSeq = MAX_INGEST_SEQ;
  }
  await col<SpaceCounterDoc>('ythril_counters').updateOne(
    asFilter<SpaceCounterDoc>({ _id: spaceId }),
    asUpdate<SpaceCounterDoc>({ $max: { seq: minSeq } }),
    { upsert: true },
  );
  // A record that arrived at this seq is committed (ingest writes before it bumps); readers may be handed it.
  const s = stateOf(spaceId);
  if (s.maxSeen !== undefined && minSeq > s.maxSeen) s.maxSeen = minSeq;
}

/**
 * Every watermark that becomes a LIE when the seq counters are wiped.
 *
 * All four are `spaceId -> position` maps on a network member, and all four are meaningless once the counter
 * they were measured against restarts at zero. Listing them here rather than at the reset below is what makes
 * "did we cover all of them" a readable question — the reset used to clear exactly one, and the other three
 * were not excluded for a reason, they were not thought of.
 */
const STALE_ON_COUNTER_WIPE = ['lastSeqReceived', 'lastSeqPushed', 'lastSeqServed',
  'lastFileTombstoneAckedAt'] as const;

/**
 * Detects the bind-mount / volume mismatch that occurs when `docker compose
 * down -v` wipes MongoDB but leaves config.json intact on the host bind-mount.
 *
 * Symptom: `ythril_counters` is empty — the counter lived in the wiped volume — yet one or more network
 * members still carry watermarks from the previous run. Local seqs now restart at 1 while the watermarks
 * describe a history of numbers that will be reused for entirely different records.
 *
 * ## It used to clear ONE of the four, and the other three fail in different directions
 *
 * | watermark | what it means | stale-high costs |
 * |---|---|---|
 * | `lastSeqReceived` | our position in the peer's data | we pull `sinceSeq=47` and silently miss its 1..47 |
 * | `lastSeqPushed` | our position in what we have sent | we push `seq > 47` and NEVER send our own new 1..47 |
 * | `lastSeqServed` | the peer's position in ours | we believe it has applied deletions it has not, and prune |
 * | `lastFileTombstoneAckedAt` | file deletions a peer has taken | same, for files: prune, and the file returns |
 *
 * Only the first was reset, and the second is the same defect pointing the other way — a silent, permanent
 * failure to deliver our own records, with the sender's cycles completing normally because `seq > 47`
 * genuinely matches nothing. That is indistinguishable from a healthy idle cycle without the debug line the
 * push loop now emits.
 *
 * The third and fourth fail toward PRUNING, which `sync/served-watermark.ts` names as the dangerous direction:
 * a tombstone dropped too early lets a deleted record come back from a peer that never saw the deletion.
 * Clearing them fails toward keeping, which is that module's stated rule.
 *
 * Safe to call at every startup: a no-op when `ythril_counters` is non-empty (a normal restart) or when no
 * watermark is set.
 */
export async function resetStaleWatermarksIfNeeded(): Promise<void> {
  const count = await col<SpaceCounterDoc>('ythril_counters').estimatedDocumentCount();
  if (count > 0) return; // MongoDB intact — nothing to do

  const cfg = getConfig();
  const cleared: string[] = [];

  /** Clear every stale map on one member, reporting which were actually set. */
  const clear = (member: Record<string, unknown> | undefined, where: string): void => {
    if (!member) return;
    for (const field of STALE_ON_COUNTER_WIPE) {
      const value = member[field];
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        member[field] = {};
        cleared.push(`${where}.${field}`);
      }
    }
  };

  for (const net of cfg.networks) {
    for (const member of net.members) clear(member as unknown as Record<string, unknown>, member.instanceId);
    // A vote round in flight carries its own copy of the joining member, with its own watermarks.
    for (const round of net.pendingRounds) {
      clear(round.pendingMember as unknown as Record<string, unknown> | undefined, 'pendingMember');
    }
  }

  if (cleared.length > 0) {
    saveConfig(cfg);
    log.warn(
      `Seq counters absent but ${cleared.length} watermark map(s) were set — reset (bind-mount/volume mismatch `
      + `recovery). Local seqs restart at 1, so a retained watermark would describe numbers about to be reused: `
      + `${cleared.join(', ')}`,
    );
  }
}

import { col, asFilter, asUpdate } from '../db/mongo.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { log } from './log.js';
import type { SpaceCounterDoc } from '../config/types.js';

/**
 * Returns the next monotonic sequence number for a space.
 * Safe for concurrent callers — uses findOneAndUpdate with $inc.
 */
export async function nextSeq(spaceId: string): Promise<number> {
  const counters = col<SpaceCounterDoc>('ythril_counters');
  const result = await counters.findOneAndUpdate(
    { _id: spaceId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) throw new Error(`Failed to increment sequence counter for space ${spaceId}`);
  return result.seq;
}

/*
 * `reserveSeqBlock` WAS HERE, and it went with its only caller (5.0).
 *
 * It reserved a contiguous range in one `$inc` for the bulk-delete paths, which wrote one tombstone per
 * document and would otherwise have made a round trip each — 100k awaited round trips to wipe 100k facts,
 * before the delete even started. Those paths were the five per-collection `DELETE` routes; emptying a
 * space is one tool call now and `wipeSpace` does a `deleteMany` per collection, writing no tombstones.
 *
 * **No tombstones is correct here and the reason is the vote, not an omission.** A wipe that empties a
 * collection and writes none is one the next sync cycle would undo record by record from a peer's copy —
 * which is exactly why `delete_space_data` opens a governed round on a networked space instead: every
 * member wipes, so there is nothing for a peer to offer back. On a space in no network there is no peer.
 *
 * Deleted rather than kept for a future caller: an unused allocator with a subtle contract (gaps are safe,
 * REUSE is not) is the thing somebody reaches for without reading it.
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
 * seqs are small monotonic counters (`nextSeq` increments by 1), so they sit far
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

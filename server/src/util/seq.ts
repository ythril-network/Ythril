import { col, asFilter } from '../db/mongo.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { eachMemberMarkOf } from '../sync/receive-marks.js';
import { log } from './log.js';
import type { SpaceCounterDoc } from '../config/types.js';
import type { SpacePart } from '../db/space-collection.js';

/*
 * ── What `seq` is, now that a position exists (bundle-81) ─────────────────────────────────────────────────────
 *
 * A record's `seq` is its VERSION: the number two copies of it are compared by, so an edit beats what it replaces and a peer takes a
 * copy only when it is newer. It is stamped by `util/version-stamp.ts` (`max(V + 1, the stored version + 1, …)`, `V` the space's counter)
 * and a record keeps its AUTHOR's version when it replicates. It is NOT where a record sits in a stream: paging, acknowledgement and
 * the default list order read the record's POSITION (`pos`), which this instance takes when the record lands, however it got here
 * (`util/position-clock.ts`, `sync/record-position-stream.ts`). That split is what ended Q-196's horizon on versions (a version needs
 * no horizon, since nothing pages by it) and Q-278, Q-238 and Q-394 with it (a relayed record, a relayed tombstone and a tombstone-only
 * cycle all took their position at receipt and so were offered once).
 *
 * This module keeps what is still a fact about versions and nothing else: which collections carry them, the ceilings, and the counter's
 * read. The counter is written by `versionsFor` and `raiseVersionTo` only.
 */

/**
 * The collections whose records carry a space seq and a position. The version floor reads the highest seq stored in each, the records
 * stream's seed the highest `pos`, and `a-pull-never-passes-an-uncommitted-position-db` derives the pull routes and fails on any route
 * whose collection this misses.
 */
export const SEQ_CARRYING: readonly SpacePart[] = ['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones'];

/** Read the current counter for a space (0 when it does not exist yet). */
export async function currentSeq(spaceId: string): Promise<number> {
  const doc = await col<SpaceCounterDoc>('ythril_counters')
    .findOne(asFilter<SpaceCounterDoc>({ _id: spaceId })) as SpaceCounterDoc | null;
  return doc?.seq ?? 0;
}

/**
 * The protocol sequence ceiling — the one definition: the `Incoming*` schemas in `api/sync/_shared.ts`
 * validate against this constant (`<= 2^50`), and it had a second copy there until `Q-107`. A document at or
 * above this cannot be represented, so it is never a legitimate value on the wire. Kept within safe-integer
 * arithmetic so a version can never round. Every position of the clock band is above it (`util/position-clock.ts`).
 */
export const MAX_SYNC_SEQ = 2 ** 50;

/**
 * Headroom kept below `MAX_SYNC_SEQ`. A peer that pushes one document with `seq` near the ceiling must not be able to take this
 * instance's own versions with it, or the space's *next* local write exceeds `MAX_SYNC_SEQ` and is rejected by every peer: silent,
 * unrecoverable write loss (Q-241). Arrivals no longer move the counter at all (D-19 B), and what a held record raises is capped
 * ({@link VERSION_FLOOR_CAP}), so the headroom is what a local stamp may still climb through.
 *
 * The guard is absolute rather than relative to the current counter: legitimate seqs are small monotonic counters (an allocation
 * increments by its block size), so they sit far below `MAX_SYNC_SEQ - SEQ_CEILING_RESERVE` regardless of a space's history,
 * while the poisoning value (near 2^50) is caught. A relative "max jump" guard would instead false-positive on the initial sync of a
 * high-volume space to a fresh peer. 2^40 (~1.1e12) of reserve leaves an unreachable number of future writes before the ceiling.
 */
export const SEQ_CEILING_RESERVE = 2 ** 40;

/** The highest `seq` an ingested document may carry. */
export const MAX_INGEST_SEQ = MAX_SYNC_SEQ - SEQ_CEILING_RESERVE;

/**
 * The highest value the space's counter `V` may hold, and the highest a held version may raise a local stamp's floor to: `MAX_INGEST_SEQ`
 * less the reserve. A stamp above it is still written when it is at or below `MAX_INGEST_SEQ` (an edit of a near-ceiling arrival is one
 * above it), but it never raises `V`, so one edit cannot drag every later create up to the ceiling. Every stamp at or below it leaves
 * `SEQ_CEILING_RESERVE` creates of headroom.
 */
export const VERSION_FLOOR_CAP = MAX_INGEST_SEQ - SEQ_CEILING_RESERVE;

/**
 * True when `seq` is out of range or so close to the protocol ceiling that
 * ingesting it would strand a record's next version. Callers reject such documents.
 * Synchronous — the bound does not depend on the current counter.
 */
export function isSeqImplausible(seq: number): boolean {
  return !Number.isFinite(seq) || seq < 0 || seq > MAX_INGEST_SEQ;
}

/**
 * Detects the bind-mount / volume mismatch that occurs when `docker compose
 * down -v` wipes MongoDB but leaves config.json intact on the host bind-mount.
 *
 * Symptom: `ythril_counters` is empty — the counter lived in the wiped volume — yet one or more network
 * members still carry watermarks from the previous run. Local seqs now restart at 1 while the watermarks
 * describe a history of numbers that will be reused for entirely different records.
 *
 * ## It used to clear ONE of them, and the others fail in different directions
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
 * The last two of those fail toward PRUNING, which `sync/served-watermark.ts` names as the dangerous direction:
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

  // EVERY per-space mark is a lie once the counter restarts at zero (`PER_SPACE_WATERMARKS`), on every member and on the member a join
  // round in flight carries (`pendingMember`): the one loop over them visits both, so the reset cannot miss a carrier the forget reaches.
  // A map that must SURVIVE a counter wipe would be passed over here, by name, with its reason; none does.
  for (const net of cfg.networks) {
    eachMemberMarkOf(net, null, (marks, mark, who) => {
      for (const spaceId of Object.keys(marks)) delete marks[spaceId];
      cleared.push(`${who}.${mark}`);
    });
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

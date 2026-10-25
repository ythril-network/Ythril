import { col, asFilter } from '../db/mongo.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { eachMemberMarkOf } from '../sync/receive-marks.js';
import { RECEIVE_MARKS } from '../config/types-networks.js';
import { log } from './log.js';
import { highestStored } from './index-top.js';
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
 * The highest version stored in any of `collections` that is at or below {@link VERSION_FLOOR_CAP}, or 0 when they hold none: what a counter may continue from. The ONE
 * reading of the version maximum, over the collections it is handed: `highestVersionBelowCap` (`util/version-stamp.ts`) hands it a space's own, and the rollback tool
 * (`sync/positions-rollback.ts`, which runs with no instance up and so holds a driver `Db` of its own) hands it that database's.
 */
export async function highestVersionBelowCapOf(collections: ReadonlyArray<{ readonly find: unknown }>): Promise<number> {
  return await highestStored<number>(collections, 'seq', { $type: 'number', $lte: VERSION_FLOOR_CAP }) ?? 0;
}

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
 * down -v` wipes MongoDB but leaves config.json intact on the host bind-mount, and forgets what was RECEIVED
 * (bundle-81, design rev 8 section 3a; it cleared every mark when a mark was a seq of this instance's counter).
 *
 * Symptom: `ythril_counters` is empty - the counter lived in the wiped volume - yet one or more network
 * members still carry marks from the previous run. The store holds none of what those marks say was received.
 *
 * ## Which marks are lies after a wipe, and which stay true
 *
 * | mark | what it means | after a wipe |
 * |---|---|---|
 * | `lastPosReceived` | our position in the peer's stream | a lie: the records are gone, the peer must send them again (`RECEIVE_MARKS`) |
 * | `tombstoneRereadAt`, `fileMetaRereadAt` | the one-time re-reads done | a lie, for the same reason (`RECEIVE_MARKS`) |
 * | `lastPosPushed`, `lastPosServed` | what we sent, and what the peer took of ours | true: positions are clock-stamped and seeded from the store, so the wiped space's next position is above them, and a mark that is too low costs a re-send, never a miss |
 * | `lastFileTombstoneAckedAt` | file deletions a peer has taken | true (a time) |
 *
 * That is the same list a restore forgets (`forgetWhatWasReceived`, `sync/receive-marks.ts`), and it is walked through the same one loop over
 * the member marks, for every space (`null`) and for the member a join round in flight carries, so the reset cannot miss a carrier the forget reaches.
 * The frozen 5.6 marks (`ROLLBACK_MARKS`) are neither: nothing in 6.0 reads them and a rollback needs them as they were.
 *
 * Safe to call at every startup: a no-op when `ythril_counters` is non-empty (a normal restart) or when no mark is set.
 */
export async function forgetWhatWasReceivedAfterCounterWipe(): Promise<void> {
  const count = await col<SpaceCounterDoc>('ythril_counters').estimatedDocumentCount();
  if (count > 0) return; // MongoDB intact - nothing to do

  const cfg = getConfig();
  const cleared: string[] = [];

  for (const net of cfg.networks) {
    eachMemberMarkOf(net, null, (marks, mark, who) => {
      for (const spaceId of Object.keys(marks)) delete marks[spaceId];
      cleared.push(`${who}.${mark}`);
    }, RECEIVE_MARKS);
  }

  if (cleared.length > 0) {
    saveConfig(cfg);
    log.warn(
      `Counters absent but ${cleared.length} receive mark map(s) were set - forgotten (bind-mount/volume mismatch `
      + `recovery). The peers send again what this instance no longer holds: ${cleared.join(', ')}`,
    );
  }
}

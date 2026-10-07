/**
 * Everything one member's tombstone pull for one space owes, in the order it is owed — the one call the sync cycle makes
 * where it used to call `pullTombstones` alone (bundle-51, D-14 = C).
 *
 * ## What it answers
 *
 * *"Pull this peer's tombstones for this space, with the one-time repairs the upstream deletion rule created."* Three steps,
 * and the ORDER is the reason this is a function and not three lines in the engine:
 *
 *  1. **The stamp back-fill** (`stampDeliveriesOnce`) first: a tombstone applied before its target carries the stamp the
 *     upstream ground reads is declined, so the first pull after upgrading would lose the deletion it could have made.
 *  2. **The ordinary pull** (`pullTombstones`), whose outcome is the one the cycle's receive watermark depends on.
 *  3. **The re-read** (`rereadUpstreamTombstones`) after it, which needs that pull's start and outcome (a member whose first
 *     read ran from the start to the end is owed nothing) and whose own outcome is NOT returned: the repair is not part of
 *     the record watermark's completeness, and a stop in it must never hold what the ordinary pull earned.
 *
 * What the engine gets back is the ordinary pull's outcome, unchanged. The engine is frozen against growth
 * (`no-new-god-files`), which is the other reason the sequence lives here.
 */
import { stampDeliveriesOnce } from './delivered-by-backfill.js';
import { pullTombstones } from './tombstone-transfer.js';
import { rereadUpstreamTombstones } from './tombstone-reread.js';
import type { NetworkMember } from '../config/types.js';
import type { TransferOutcome } from './watermark.js';

export async function pullSpaceTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  sinceSeq: number;
  requestInit: () => RequestInit;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit } = opts;
  await stampDeliveriesOnce(spaceId);
  const outcome = await pullTombstones({ member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit });
  await rereadUpstreamTombstones({ member, spaceId, remoteSpaceId, networkId, requestInit, ordinary: { sinceSeq, outcome } });
  return outcome;
}

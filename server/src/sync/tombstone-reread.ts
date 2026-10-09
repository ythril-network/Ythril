/**
 * The ONE-TIME RE-READ of an upstream's tombstones (bundle-51 plan §4, D-14 = C): the repair that goes with giving an
 * upstream the power to delete what it relayed.
 *
 * ## What it repairs
 *
 * Before D-14 a tombstone the upstream issued for a record some third author wrote was DECLINED, and the receive watermark
 * moved past it: no ordinary cycle asks for it again, so the record stayed on the subscriber for good and the publisher's
 * deletion was lost. The rule now deletes it — but only for a tombstone the apply SEES, and an ordinary pull starts at the
 * watermark. So each upstream is asked once more for the tombstones it still holds, from the start, and they go through
 * the same apply (`applyPeerTombstones`: ground `issuer` or `upstream`, the same verdict, the same bound in the write).
 *
 * ## The state, and what it prevents
 *
 * `tombstoneRereadAt[space]` on the upstream's member row (`config/types-networks.ts`, in `PER_SPACE_WATERMARKS`, so a rename
 * carries it and a counter wipe re-owes it — harmless, the re-read is idempotent): absent = owed from the start, a decimal seq
 * = owed from there, `'done'` = finished and never asked again. `nextRereadState` (`sync/deletion-authority.ts`) is the pure
 * fold, and `foldRepairMark` (`sync/member-space-mark.ts`) moves it on the live config.
 *
 *  - **A second full read.** A member whose FIRST ordinary pull already read from the start to the end has seen everything the
 *    upstream holds and is marked done without a second read.
 *  - **A repair that holds what it is not part of.** It is its own outcome, kept out of `resolveWatermark`'s `alsoCheck`: a
 *    tombstone seq is not a position in the record stream, and the record watermark the ordinary pull earned in the same
 *    cycle must survive a re-read that stops.
 *  - **A re-created record taken with it.** A re-read tombstone is old; it deletes a row only if the row's seq is not above the
 *    tombstone's (`TombstoneApplyOptions.repair`), so a record re-created after the deletion survives — it fails toward
 *    KEEPING. Stated: a re-creation by an author whose counter is lower than the tombstone's is the gap this cannot see.
 *  - **A silent stall.** A stop that goes on being the same stop is said once per window (`sync/tombstone-transfer.ts`) and the
 *    repair stays owed, which `ythril_sync_tombstone_rereads_owed` reports; a failure is the space's, isolated and reported once
 *    per window by the shared reporter, and the space is tried again next cycle.
 *
 * Only an UPSTREAM is re-read: a peer that is not this space's direct upstream could never have deleted what it relayed, so
 * there is nothing to repair for it. What it recovers is the deletions the upstream still holds — an older tombstone the source
 * already pruned is gone for good (release notes say so). Upgrading root-first matters on a tree: a middle node that repairs
 * after its children have passed the relayed seq leaves them holding the record (the ordering limit owned by Q-238).
 */
import type { NetworkMember } from '../config/types.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { log, peerText } from '../util/log.js';
import { parseSeqText } from '../util/seq-keyset.js';
import { deliveryOfMember, nextRereadState } from './deletion-authority.js';
import { foldRepairMark, readMemberSpaceMark } from './member-space-mark.js';
import { pullTombstones } from './tombstone-transfer.js';
import type { TransferOutcome } from './watermark.js';

const STEP = 'sync tombstone re-read';

/**
 * Where a state says to start: a decimal seq a cursor can carry (`parseSeqText`, the one reading of a seq written as text) is
 * the position, anything else (absent included, and a number past what a seq may be) is the start — read again, never skipped.
 */
function startOf(state: string | undefined): number {
  return (state === undefined ? undefined : parseSeqText(state)) ?? 0;
}

/** The state this member row holds for the space, read from the LIVE config. */
function stateOf(networkId: string, memberId: string, spaceId: string): string | undefined {
  return readMemberSpaceMark(networkId, memberId, spaceId, 'tombstoneRereadAt');
}

/** Fold one outcome into every row that holds the mark, and save once when anything changed. */
function record(memberId: string, spaceId: string, outcome: { complete: boolean; cursor?: string; stopped?: boolean }): void {
  foldRepairMark(memberId, spaceId, 'tombstoneRereadAt', (current) => nextRereadState(current, outcome));
}

/**
 * Re-read `member`'s tombstones for `spaceId` if it is this space's upstream and the re-read is still owed. Called once per
 * member and space from the pull step, after the ordinary tombstone pull, with that pull's start and outcome. Never throws.
 */
export async function rereadUpstreamTombstones(o: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  requestInit: () => RequestInit;
  /** The ordinary tombstone pull this cycle made: where it started and how it ended. */
  ordinary: { sinceSeq: number; outcome: TransferOutcome };
}): Promise<void> {
  const { member, spaceId, remoteSpaceId, networkId, requestInit, ordinary } = o;
  if (!deliveryOfMember(spaceId, member).upstream) return;
  const current = stateOf(networkId, member.instanceId, spaceId);
  if (current === 'done') return;

  // The first read of a new member started at the beginning and ran to the end: nothing is owed beyond it.
  if (ordinary.sinceSeq === 0 && !ordinary.outcome.truncated) { record(member.instanceId, spaceId, { complete: true }); return; }

  const start = startOf(current);
  const tally = { issuer: 0, upstream: 0 };
  try {
    const outcome = await pullTombstones({ member, spaceId, remoteSpaceId, networkId, sinceSeq: start, requestInit, repair: true, tally });
    const complete = !outcome.truncated;
    const progressed = outcome.deliveredThrough > start;
    record(member.instanceId, spaceId, {
      complete,
      ...(progressed ? { cursor: String(outcome.deliveredThrough) } : {}),
      stopped: !complete && !progressed,
    });
    if (complete) {
      log.info(`Re-read of the tombstones of upstream ${peerText(member.label ?? member.instanceId)} for space '${peerText(spaceId)}' `
        + `finished (one time, after upgrading): ${tally.upstream + tally.issuer} record(s) deleted that it had deleted before — `
        + `${tally.upstream} on its say-so over what it relayed, ${tally.issuer} on the issuer's own authority.`);
    }
  } catch (err) {
    // The space's failure (its counter could not move, its store failed): said once per window, and the repair stays owed.
    // Not thrown — the cycle's own pull has already finished, and a repair must never be what fails it.
    reportSpaceFailure(STEP, spaceId, err, { when: 'next cycle' });
  }
}

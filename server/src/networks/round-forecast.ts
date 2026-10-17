/**
 * Would this instance's own yes alone pass a deletion or wipe it proposed on a network — "acts now" or "opens a vote"? Answered by the
 * REAL pass rule on a scratch copy (bundle-106, design v5 §1.1 W22, §2.8).
 *
 * ## What it prevents
 *
 * The client's danger tab promised "opens a vote" for a click that, on a club, a pub/sub this instance publishes, or a network where it
 * is the only member, empties the space at once. Writing the pass rule again for the forecast would be a second implementation of it
 * that drifts from the first; so the forecast asks the real one — `roundVerdict`, the pure half of `concludeRoundIfReady` — of a COPY of
 * the network and an unsigned scratch round. It concludes nothing and applies nothing, which is why it is no exemption of the "every
 * conclusion is inside `settleRounds`" gate and why `GET /api/networks`, a read door, reaches no write through it. No Ed25519 is
 * spent per request: the scratch cast is unsigned.
 */
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import { roundVerdict } from '../sync/governance.js';

/** Would a `space_wipe` (or `space_deletion`) this instance proposes on `net` pass at open, here, now? */
export function ownYesCarries(net: NetworkConfig, cfg: Pick<Config, 'instanceId' | 'instanceLabel'>, now: number = Date.now()): boolean {
  const scratch: VoteRound = {
    roundId: 'forecast', type: 'space_wipe', subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel, subjectUrl: '',
    openedAt: new Date(now).toISOString(), deadline: new Date(now + 3_600_000).toISOString(),
    votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: new Date(now).toISOString() }],
    proposedHere: true,
  };
  try {
    return roundVerdict(net, scratch, now) === 'passed';
  } catch {
    return false;
  }
}

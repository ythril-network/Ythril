/**
 * Vote-round retention: which governance rounds a network still has to keep (P14).
 *
 * Moved out of `sync/engine.ts` (bundle-30) along its own seam: the engine decides WHEN to prune and what to
 * re-serve, this module answers the one question both ask — is this round finished for good. It is a rule about
 * rounds, not about transfers, and it has its own tests (`vote-round-prune.test.js`).
 */

import type { NetworkConfig, VoteRound } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { roundPastDeadline } from '../networks/round-state.js';
import { recordRoundOutcome } from '../networks/round-outcomes.js';
import { spaceActStands } from '../spaces/space-act-runner.js';
import { roundSpaceLocalId } from './space-map.js';

/** A round is prunable once it is concluded AND past its deadline. After the deadline
 *  every peer concludes the round independently (the deadline path in
 *  `concludeRoundIfReady`), so such a round can no longer influence any decision and
 *  never needs re-serving or re-propagating. A deadline nobody can read counts as past
 *  (`roundPastDeadline`): a concluded round that cannot be dated would otherwise be held
 *  for ever, and nothing is lost by pruning it, because the prune records how it ended
 *  first. An OPEN round is never prunable, whatever its deadline says. */
export function isRoundPrunable(
  round: { concluded?: boolean; deadline?: string | null },
  now: number = Date.now(),
): boolean {
  return Boolean(round.concluded) && roundPastDeadline(round, now);
}

/**
 * Are this round's casts still pushed to a peer (W19)? Open rounds and rounds concluded within their deadline: a concluding cast
 * must still reach a peer that has not concluded. A round KEPT past its deadline because its act is owed here is kept for the
 * retry and the hold, not to be re-pushed every cycle - kept and re-propagated are two questions, so two functions.
 */
export function roundCastsStillPropagate(round: { deadline?: string | null }, now: number = Date.now()): boolean {
  return !roundPastDeadline(round, now);
}

/**
 * Is this deletion or wipe round's act still to finish here? Such a round is the debt a retry needs and the hold rides on, so
 * the prune keeps it past its deadline until the act completes. A round whose act completed (`appliedHere`) is done; for one that
 * has not, whether its act stands is asked through the one standing predicate (`spaceActStands`), which reads the entry - the
 * entry is the act, and no door decides from the round's own owed state.
 */
function actStandsForRound(net: NetworkConfig, round: VoteRound): boolean {
  if ((round.type !== 'space_deletion' && round.type !== 'space_wipe') || round.appliedHere === true) return false;
  try {
    const localId = roundSpaceLocalId(net, round) ?? (typeof round.spaceId === 'string' ? round.spaceId : null);
    return localId !== null && spaceActStands(getConfig(), localId) !== null;
  } catch {
    return false;
  }
}

/** Drop concluded-and-expired rounds from a network's `pendingRounds` in place.
 *  `concludeRoundIfReady` marks a round `concluded` but never removes it, so without
 *  this `pendingRounds` grows for the life of the network — bloating `config.json`, the
 *  `GET /votes` scan, and gossip payloads. Each round is recorded in the network's outcome
 *  log before it goes (a round that concluded before outcomes were recorded becomes an
 *  `ended` entry; one already recorded is left as it was), so the prune loses nothing an
 *  operator can read. Returns the number of rounds removed. */
export function pruneExpiredRounds(net: NetworkConfig, now: number = Date.now()): number {
  const rounds = net.pendingRounds;
  if (!rounds || rounds.length === 0) return 0;
  const kept = rounds.filter(r => !isRoundPrunable(r, now) || actStandsForRound(net, r));
  const removed = rounds.length - kept.length;
  if (removed > 0) {
    for (const r of rounds) if (!kept.includes(r)) recordRoundOutcome(net, r, now);
    net.pendingRounds = kept;
  }
  return removed;
}

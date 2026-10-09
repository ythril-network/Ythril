/**
 * Vote-round retention: which governance rounds a network still has to keep (P14).
 *
 * Moved out of `sync/engine.ts` (bundle-30) along its own seam: the engine decides WHEN to prune and what to
 * re-serve, this module answers the one question both ask — is this round finished for good. It is a rule about
 * rounds, not about transfers, and it has its own tests (`vote-round-prune.test.js`).
 */

import type { NetworkConfig } from '../config/types.js';
import { roundPastDeadline } from '../networks/round-state.js';
import { recordRoundOutcome } from '../networks/round-outcomes.js';

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
  const kept = rounds.filter(r => !isRoundPrunable(r, now));
  const removed = rounds.length - kept.length;
  if (removed > 0) {
    for (const r of rounds) if (!kept.includes(r)) recordRoundOutcome(net, r, now);
    net.pendingRounds = kept;
  }
  return removed;
}

/**
 * Vote-round retention: which governance rounds a network still has to keep (P14).
 *
 * Moved out of `sync/engine.ts` (bundle-30) along its own seam: the engine decides WHEN to prune and what to
 * re-serve, this module answers the one question both ask — is this round finished for good. It is a rule about
 * rounds, not about transfers, and it has its own tests (`vote-round-prune.test.js`).
 */

import type { NetworkConfig } from '../config/types.js';

/** A round is prunable once it is concluded AND past its deadline. After the deadline
 *  every peer concludes the round independently (the deadline path in
 *  `concludeRoundIfReady`), so such a round can no longer influence any decision and
 *  never needs re-serving or re-propagating. A malformed/unparseable deadline yields
 *  `NaN`, and `NaN < now` is false, so we keep the round rather than prune on doubt. */
export function isRoundPrunable(
  round: { concluded?: boolean; deadline: string },
  now: number = Date.now(),
): boolean {
  return Boolean(round.concluded) && new Date(round.deadline).getTime() < now;
}

/** Drop concluded-and-expired rounds from a network's `pendingRounds` in place.
 *  `concludeRoundIfReady` marks a round `concluded` but never removes it, so without
 *  this `pendingRounds` grows for the life of the network — bloating `config.json`, the
 *  `GET /votes` scan, and gossip payloads. Returns the number of rounds removed. */
export function pruneExpiredRounds(net: NetworkConfig, now: number = Date.now()): number {
  const rounds = net.pendingRounds;
  if (!rounds || rounds.length === 0) return 0;
  const kept = rounds.filter(r => !isRoundPrunable(r, now));
  const removed = rounds.length - kept.length;
  if (removed > 0) net.pendingRounds = kept;
  return removed;
}

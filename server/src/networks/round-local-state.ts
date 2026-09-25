/**
 * What on a vote round belongs to THIS instance alone — and the only place a round is added to a network.
 *
 * A round travels: it is opened on one instance, served to peers, adopted by gossip on each of them. Most of it is
 * the network's — who is voted on, the casts, the deadline. Two fields are not, and each was once a security hole
 * because a peer could set it:
 *
 * - `appliedHere` (`S-9`): this instance already acted on the concluded round, so gossip re-delivering it does nothing.
 *   Taken from a peer, a round arrives "already applied" and never acts, or is re-applied when a peer clears it.
 * - `proposedHere` (`S-7`): this instance opened the round. It used to be inferred from `subjectInstanceId === self`,
 *   a wire field — so a peer naming the victim as subject made the victim treat the round as its own: a
 *   `space_addition` skipped the guard that keeps a same-named private space out, and a `meta_change` wrote the
 *   victim's OWN definitions instead of the network's layer.
 *
 * So every `pendingRounds.push` lives here, and a new site cannot forget the flag: opening a round records it, adopting
 * one strips whatever a peer sent, and serving one strips it on the way out. `a-round-proposer-is-a-local-fact.test.js`
 * refuses a push anywhere else.
 */
import type { NetworkConfig, VoteRound } from '../config/types.js';

/** The fields that describe this instance, never the network. A peer never sends them and never receives them. */
export const LOCAL_ROUND_FIELDS = ['appliedHere', 'proposedHere'] as const;
type LocalField = typeof LOCAL_ROUND_FIELDS[number];

/** `round` with every local field removed. */
function withoutLocalState<T extends Partial<Record<LocalField, unknown>>>(round: T): Omit<T, LocalField> {
  const copy = { ...round };
  for (const f of LOCAL_ROUND_FIELDS) delete copy[f];
  return copy;
}

/**
 * Open a round on this instance: it is ours, so it says so. Stores `round` ITSELF, not a copy — callers go on casting
 * into and concluding the object they built, and a copy would leave the stored round without those writes.
 */
export function openRoundHere(net: NetworkConfig, round: VoteRound): VoteRound {
  delete round.appliedHere;
  round.proposedHere = true;
  net.pendingRounds.push(round);
  return round;
}

/**
 * Adopt a round a peer served. Nothing local is taken from it, its casts are merged one by one by the caller (each
 * has to pass `acceptVoteCast`), and it is open here until THIS instance concludes it. Returns the stored round.
 */
export function adoptPeerRound(net: NetworkConfig, peerRound: VoteRound): VoteRound {
  const stored: VoteRound = { ...withoutLocalState(peerRound), votes: [], concluded: false };
  net.pendingRounds.push(stored);
  return stored;
}

/** A round as a peer may see it: without this instance's own state. */
export function roundForPeer<T extends Partial<Record<LocalField, unknown>>>(round: T): Omit<T, LocalField> {
  return withoutLocalState(round);
}

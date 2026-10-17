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
 * - `outcome` and `concludedAt`: how THIS instance's conclusion read the round, and when. An instance's own reading, unsigned, which
 *   no decision reads back (`a-round-outcome-decides-nothing-and-is-never-markup.test.js`); taken from a peer it would let one
 *   instance label another's round.
 * - `refusedHere`: why THIS instance did not read the schema a `meta_change` round carries (R6-6). What one member could not parse
 *   says nothing of another, and taken from a peer it would let one instance tell another's operator its own round is unreadable.
 *
 * So every `pendingRounds.push` lives here, and a new site cannot forget the flag: opening a round records it, adopting
 * one strips whatever a peer sent, and serving one strips it on the way out. `a-round-proposer-is-a-local-fact.test.js`
 * refuses a push anywhere else.
 */
import type { NetworkConfig, SpaceMeta, VoteRound } from '../config/types.js';
import { inlineResolvableRefs } from '../spaces/schema-validation.js';
import { isSpaceActRound, roundDeadlineBeyondCap, roundPastDeadline } from './round-state.js';
import { publishesOn } from './network-role.js';
import { hasRoundShape, canonicalRoundWipeTypes } from './round-shape.js';
import { DEFAULT_STAMP_SKEW_WARN_MINUTES } from '../brain/stamp-skew.js';

/** The fields that describe this instance, never the network. A peer never sends them and never receives them. */
export const LOCAL_ROUND_FIELDS = ['appliedHere', 'proposedHere', 'outcome', 'concludedAt', 'refusedHere', 'actLocalId', 'peersConcluded'] as const;
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

/** Why a round a peer served is not adopted — a short phrase, counted per pass and said once as a debug line. */
export type AdoptionRefusal = 'past its deadline or undatable' | 'deadline beyond what a network allows' | 'already recorded here'
  | 'proposed by a subscriber' | 'malformed';

/**
 * Does the round's `openedAt` lie ahead of this instance's clock by more than the one clock tolerance the server names (X11)? Such a
 * round is ADOPTED — a proposer whose clock runs ahead is not an attacker — and the caller counts it and says so once per network and
 * peer. Undatable reads as not ahead: the deadline checks already refuse a round that cannot be dated.
 */
export function roundOpenedAhead(round: { openedAt?: string | null }, now: number): boolean {
  const opened = typeof round.openedAt === 'string' ? Date.parse(round.openedAt) : Number.NaN;
  return Number.isFinite(opened) && opened > now + DEFAULT_STAMP_SKEW_WARN_MINUTES * 60_000;
}

/**
 * Should this instance adopt `peerRound`? `null` when it should; otherwise why not.
 *
 * Adoption used to take every round a peer served, as open, and the next pass concluded it. So a round that had ended
 * elsewhere (the peer list also serves PASSED `space_addition` and `meta_change` rounds, for the late joiner) came back to life
 * for one pass and ended as a failure, one this instance had already recorded ended a second time, and a round with a deadline
 * years away stayed open here for as long as the peer chose. Refused now: past its deadline, undatable (it counts as past),
 * further than `openedAt` + the longest a network allows, or a `roundId` this instance has an outcome for.
 */
export function adoptionRefusal(net: NetworkConfig, peerRound: VoteRound, now: number): AdoptionRefusal | null {
  // Its declared keys first (X11): a string `wipeTypes` or an object `spaceId` would reach every later reader as what it is not.
  if (!hasRoundShape(peerRound)) return 'malformed';
  if (roundPastDeadline(peerRound, now)) return 'past its deadline or undatable';
  if (roundDeadlineBeyondCap(peerRound)) return 'deadline beyond what a network allows';
  if ((net.roundOutcomes ?? []).some(e => e.roundId === peerRound.roundId)) return 'already recorded here';
  // D-40: on pub/sub a subscriber's deletion or wipe is its own local act. A publisher holds no round it did not open of those two
  // types — every other instance there is a subscriber — decided from this instance's role, never from a field a relayer could set.
  if (isSpaceActRound(peerRound.type) && publishesOn(net)) return 'proposed by a subscriber';
  return null;
}

/**
 * Adopt a round a peer served. Nothing local is taken from it, its casts are merged one by one by the caller (each
 * has to pass `acceptVoteCast`), and it is open here until THIS instance concludes it. Returns the stored round.
 */
export function adoptPeerRound(net: NetworkConfig, peerRound: VoteRound): VoteRound {
  const stored: VoteRound = { ...withoutLocalState(peerRound), votes: [], concluded: false };
  // Stored canonical (X11): every reader — the act's key, the hold, a door's repeat — reads one spelling of what a wipe covers, and the
  // signatures over the round bind the same message for the list as sent and as stored (`util/signing.ts`).
  if (Array.isArray(stored.wipeTypes)) stored.wipeTypes = canonicalRoundWipeTypes(stored.wipeTypes);
  net.pendingRounds.push(stored);
  return stored;
}

/**
 * A round as a peer may see it: without this instance's own state, and with the schema it carries written without
 * library references this instance can resolve (`Q-60`) — a peer's library is its own, and a `$ref` it lacks
 * would land in its layer pointing at nothing. The one door a round leaves by, so no sender can skip either half.
 */
export function roundForPeer<T extends Partial<Record<LocalField, unknown>> & { pendingMeta?: SpaceMeta; type?: string; concluded?: boolean }>(
  round: T,
): Omit<T, LocalField> {
  const copy = withoutLocalState(round) as Omit<T, LocalField> & { pendingMeta?: SpaceMeta; concluded?: boolean };
  // A deletion or wipe is served concluded only once its act has completed here (design v5 §3.1): a peer lifts its hold on the
  // word of a member that has APPLIED, never one that has only decided. Read from the local fields before they were stripped.
  if (isSpaceActRound(round.type)) {
    copy.concluded = round.concluded === true && round.appliedHere === true;
  }
  if (copy.pendingMeta) copy.pendingMeta = inlineResolvableRefs(copy.pendingMeta);
  return copy;
}

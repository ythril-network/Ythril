import type { NetworkConfig } from '../config/types.js';
import { roundSpaceLocalId } from '../sync/space-map.js';

export interface SpaceNetworkInfo {
  networks: { id: string; label: string; type: NetworkConfig['type'] }[];
  networkStatus: 'vote' | 'degraded' | 'syncing' | 'idle';
}

/** Consecutive failed sync cycles before a peer reads as "degraded" rather than a
 *  transient blip that the next cycle recovers. Keeps the red indicator meaningful
 *  ("investigate") instead of firing on every retried hiccup. */
export const DEGRADE_THRESHOLD = 3;

/**
 * Aggregate a space's network membership plus a single status for the Brain
 * space-chip indicator (F8).
 *
 * Membership lives on the network side (`network.spaces`), so this reverse-looks-up
 * across all networks the space belongs to. Status priority is
 *   degraded > syncing > vote > idle
 * A persistent failure ("investigate") is not masked by the doomed retry in flight
 * (degraded above syncing), and the vote nudge sits below both transient/ops states.
 * There is no true "fully synced" signal (sync is eventual), so an idle-and-healthy
 * member is simply `idle` (the chip shows a muted, uncoloured icon).
 *
 * The 'vote' state is **actionable**: it fires only for an open round *awaiting this
 * instance's own vote* — one this instance is eligible for and has not yet cast. A
 * round we've already voted on, or one restricted to other required voters, does not
 * light the chip. This keeps a busy network from sitting permanently blue: blue means
 * "you have a vote to cast", not "some vote exists somewhere". It clears once we vote.
 *
 * Returns `undefined` when the space is in no network — the chip then shows no
 * indicator at all.
 *
 * `isSyncing(networkId)` is injected (rather than imported) so this stays a pure,
 * unit-testable function; the route passes the sync engine's in-flight check.
 * `myInstanceId` is this brain's own instance id (`config.instanceId`).
 */
export function spaceNetworkInfo(
  networks: NetworkConfig[],
  spaceId: string,
  isSyncing: (networkId: string) => boolean,
  myInstanceId: string,
): SpaceNetworkInfo | undefined {
  const nets = networks.filter(n => n.spaces.includes(spaceId));
  if (nets.length === 0) return undefined;

  // Actionable vote: an open round that affects this space AND is awaiting our own
  // cast. A network-wide round (no spaceId — join/remove) affects every member
  // space; a space-scoped round (space_deletion/meta_change) only its own space.
  const awaitingMyVote = nets.some(n =>
    n.pendingRounds.some(r =>
      !r.concluded &&
      // Resolved to THIS instance's name for the space (Q-133): a round names it by the network's id, or by its
      // proposer's local id, and neither is this instance's name once the two differ.
      (!r.spaceId || roundSpaceLocalId(n, r) === spaceId) &&
      // eligible: braintree rounds restrict to requiredVoters; others are open to all members
      (!r.requiredVoters || r.requiredVoters.includes(myInstanceId)) &&
      // not yet cast by us
      !(r.votes ?? []).some(v => v.instanceId === myInstanceId)));
  const degraded = nets.some(n =>
    n.members.some(m => (m.consecutiveFailures ?? 0) >= DEGRADE_THRESHOLD));
  const syncing = nets.some(n => isSyncing(n.id));

  const networkStatus = degraded ? 'degraded' : syncing ? 'syncing' : awaitingMyVote ? 'vote' : 'idle';
  return {
    networks: nets.map(n => ({ id: n.id, label: n.label, type: n.type })),
    networkStatus,
  };
}

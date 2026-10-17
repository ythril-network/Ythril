/**
 * Record that a member has concluded AND finished a deletion or wipe, on this instance's own copy of the round
 * (bundle-106, design v5 section 3.1 VR1, section 3.3).
 *
 * ## Why it exists
 *
 * The hold (`sync/space-exchange-set.ts`) lifts for a member only on evidence that the member applied the same wipe. The
 * evidence arrives on the vote pull, and only there; the inbound doors and the file routes see no vote pull, so the evidence
 * is PERSISTED on the round (`peersConcluded`) where every door's question can read it.
 *
 * ## What a hand-written copy drops
 *
 * The signal's exact shape. A member's served copy says it concluded only when BOTH `concluded === true` and `passed === true`:
 * an older build that merely adopted an upgraded proposer's passed round serves `{ passed: true, concluded: false }`, and a
 * member whose own act is still running, queued or failed serves the round as open. Reading `passed` alone, or `concluded`
 * alone, lifts a hold on the word of a member that has only decided. A peer copy is read totally: anything but those two
 * literal booleans is no evidence.
 *
 * `peersConcluded` is LOCAL: never served, never adopted, and it goes with the round at the prune. With no local twin (the round
 * was refused for adoption) there is no evidence, and the hold is bounded by this instance's prune.
 */
import type { NetworkConfig, VoteRound } from '../config/types.js';

const ACT_ROUND_TYPES: ReadonlySet<string> = new Set(['space_wipe', 'space_deletion']);

/** Add `memberId` to the local twin's `peersConcluded` when `peerRound` says the member concluded and passed it. Returns whether the round changed. */
export function recordPeerConcluded(net: NetworkConfig, peerRound: unknown, memberId: string): boolean {
  const served = peerRound as { roundId?: unknown; type?: unknown; concluded?: unknown; passed?: unknown } | null;
  if (!served || typeof served.roundId !== 'string' || typeof served.type !== 'string') return false;
  if (!ACT_ROUND_TYPES.has(served.type) || served.concluded !== true || served.passed !== true) return false;
  const local = net.pendingRounds.find(r => r.roundId === served.roundId) as (VoteRound & { peersConcluded?: string[] }) | undefined;
  if (!local || local.type !== served.type) return false;
  const known = Array.isArray(local.peersConcluded) ? local.peersConcluded : [];
  if (known.includes(memberId)) return false;
  local.peersConcluded = [...known, memberId];
  return true;
}

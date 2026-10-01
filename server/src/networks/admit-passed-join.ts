/**
 * Whether a join round that PASSED adds its joiner to this instance's member list — the one rule for the three places
 * a passed round lands: a local vote (`networks/vote-acts.ts`), a peer's vote relayed here (`api/sync/votes.ts`) and
 * a round concluded by the gossip pull (`sync/engine.ts`).
 *
 * ## Why this exists
 *
 * It was three hand-written copies, and the local-vote copy was the weaker one: it admitted on any voted network
 * without asking whether this instance holds the joiner's credential. A round copy learned by gossip has
 * `pendingMember.tokenHash` stripped, so admitting it added a member that could never authenticate here. The guard
 * that refuses that case is the line a copy drops, so it lives here and nowhere else.
 *
 * The rule: a passed, unvetoed join round whose joiner is not yet a member admits it — in a braintree only on the
 * direct parent (ancestor-voters must not add the joiner to their own lists), on any other voted network only on the
 * instance holding the joiner's credential. Returns whether it admitted; the caller logs and saves.
 */
import type { NetworkConfig, VoteRound } from '../config/types.js';

export function admitPassedJoin(net: NetworkConfig, selfId: string, round: VoteRound): boolean {
  if (round.type !== 'join' || !round.concluded || !round.passed) return false;
  if (round.votes.some(v => v.vote === 'veto')) return false;
  if (net.members.some(m => m.instanceId === round.subjectInstanceId)) return false;
  const pm = round.pendingMember;
  if (!pm) return false;
  const mayAdmit = net.type === 'braintree'
    ? (!pm.parentInstanceId || pm.parentInstanceId === selfId)
    : Boolean(pm.tokenHash);
  if (!mayAdmit) return false;
  net.members.push(pm);
  return true;
}

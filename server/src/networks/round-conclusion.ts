/**
 * What a concluded round DOES here — written once, and called by every place that concludes one.
 *
 * ## What it prevents
 *
 * A round concludes in four places: an operator's own cast (`networks/vote-acts.ts`), a peer's relayed cast
 * (`api/sync/votes.ts`), the gossip pass of the sync engine (`sync/engine.ts`) and the expiry job (`networks/round-expiry.ts`).
 * The first three each wrote out the same steps — admit or introduce a passed join, apply a passed space round, tell an ejected
 * member — and `apply-wipe-round.ts` said so in its own docblock ("one function, three callers, on purpose") while two of the
 * steps stayed written three times. A fourth copy is how a conclusion by the clock would have skipped a step a conclusion by a
 * vote takes. `a-round-conclusion-is-applied-by-one-function.test.js` holds that each site calls this and that none calls the steps.
 *
 * ## What each step is guarded by, so a round handed twice acts once
 *
 * - a passed JOIN: `applyPassedJoin` admits or introduces only a member that is not one yet;
 * - a passed space round: `applyConcludedSpaceRounds` marks it `appliedHere` and acts once (a `space_addition` is retried until
 *   it lands, which is why the gossip pass hands the whole set to {@link applyRoundConclusion}'s `retrySpaceRounds`);
 * - a passed REMOVE: the ejected member is told. This one has no mark of its own, so it is done ONLY for `rounds` — the ones
 *   that concluded now — never for `retrySpaceRounds`, or every held passed removal would be announced again on every pass.
 *
 * What a round that FAILED does is not here: `concludeRoundIfReady` revokes a failed join's provisioned credentials itself.
 */
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { applyConcludedSpaceRounds } from '../spaces/apply-wipe-round.js';
import { sendMemberRemovedNotify } from '../sync/governance.js';
import { log, peerText } from '../util/log.js';
import { applyPassedJoin } from './member-introductions.js';

/**
 * Apply what the rounds in `rounds` decided. The caller saves the config it came from.
 *
 * @param rounds the rounds that concluded now (or that a cast was just taken on); each is admitted, applied and, for a passed
 *   removal, announced
 * @param via where the conclusion came from, in the words of the log line: `local vote`, `peer vote`, `gossip`, `expiry`
 * @param retrySpaceRounds further rounds whose SPACE-scoped effect is applied or retried too (gossip passes every held round, so a
 *   `space_addition` that did not land is tried again); nothing else is done for them
 */
export function applyRoundConclusion(
  net: NetworkConfig, cfg: { instanceId: string }, rounds: readonly VoteRound[], via: string,
  retrySpaceRounds: readonly VoteRound[] = [],
): void {
  // A passed join: the credential holder admits, every other member of a voted network introduces (Q-154). Admitting on a
  // gossip copy, whose token hash is stripped, would add a member with no credential, which never paired.
  for (const round of rounds) {
    if (applyPassedJoin(net, cfg.instanceId, round) === 'admitted') {
      log.info(`Join round ${peerText(round.roundId)} concluded via ${peerText(via)} — added ${peerText(round.subjectLabel)} to network ${peerText(net.id)}`);
    }
  }
  // Deletion, wipe and addition (X-5, F-38.4).
  applyConcludedSpaceRounds(net, [...new Set([...rounds, ...retrySpaceRounds])], via);
  for (const round of rounds) {
    if (round.concluded && round.passed && round.type === 'remove') {
      sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
    }
  }
}

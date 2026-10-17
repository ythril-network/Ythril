/**
 * What a concluded round DOES here — evaluated and applied in ONE step, `settleRounds`, which every place a round concludes calls.
 *
 * ## What it prevents
 *
 * The same evaluate-then-apply was written at five sites, four of which differed only in which rounds they handed on — and a fifth (the
 * openers) where the apply was left out, which is Q-453: a deletion or wipe opened with the proposer's yes already deciding it was never
 * evaluated, so on a network with nobody else to evaluate it the round ended `expired` and nothing happened. And a settle that let one
 * round's throw cost the others their save. `settleRounds` is the one step: it concludes each round it is handed (each in its own `try`),
 * applies what concluded through {@link applyRoundConclusion}, and says what it did. `a-round-conclusion-is-applied-by-one-function` and
 * `every-round-is-opened-and-settled-by-one-function` hold that nothing else concludes or applies a round.
 *
 * ## What each step is guarded by, so a round handed twice acts once
 *
 * - a passed JOIN: `applyPassedJoin` admits or introduces only a member that is not one yet;
 * - a passed space round: `applyConcludedSpaceRounds` registers its act once (an entry carrying the round is joined, never doubled) and
 *   `appliedHere` is written when the act completes; a `space_addition` is retried until it lands or a later deletion supersedes it,
 *   which is why the gossip pass hands the whole held set as `retrySpaceRounds`;
 * - a passed REMOVE: the ejected member is told. This one has no mark of its own, so it is done ONLY for the rounds that concluded now —
 *   never for `retrySpaceRounds`, or every held passed removal would be announced again on every pass.
 *
 * What a round that FAILED does is not here: `concludeRoundIfReady` revokes a failed join's provisioned credentials itself.
 */
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import { applyConcludedSpaceRounds, saveIfUnsaved } from '../spaces/apply-wipe-round.js';
import { configWriteGeneration } from '../config/loader.js';
import type { SpaceRoundSettled } from '../spaces/space-act-runner.js';
import type { AdditionSettled } from './network-spaces.js';
import { concludeRoundIfReady, sendMemberRemovedNotify } from '../sync/governance.js';
import { roundSettleFailuresTotal } from '../metrics/registry.js';
import { log, peerText } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { applyPassedJoin } from './member-introductions.js';
import { auditRoundEffect, ROUND_MEMBER_ADMITTED_OPERATION } from './round-audit.js';

/** Who settled a round — the closed vocabulary of every settle site, every metric label and every audit gate that names one. */
export const SETTLE_VIAS = ['gossip', 'expiry', 'retry', 'local vote', 'peer vote', 'proposer'] as const;
export type SettleVia = typeof SETTLE_VIAS[number];

/**
 * The via whose effect IS the operator's own request: its route audits that effect (`space.delete`, `space.wipe`, `network.space.add`,
 * `network.member.*`), so the settle writes no entry of its own for it. A cast (`local vote`) is not in it: the cast route audits only
 * the VOTE (`network.vote`), not the deletion, wipe or admission it concluded.
 */
export const REQUEST_VIAS: readonly SettleVia[] = ['proposer'];

/** One settled space act or addition: what the space-act runner or the addition answered. */
export type SettledSpaceRound = SpaceRoundSettled | AdditionSettled;

/** What one settle did. */
export interface Settled {
  /** The rounds that concluded in this call. */
  concluded: VoteRound[];
  /** Rounds whose conclusion or application threw; the others are unaffected. */
  failed: { round: VoteRound; cause: unknown }[];
  /** The space acts and additions it started; never rejects. Awaited only by a door that opened the round. */
  settled: Promise<SettledSpaceRound[]>;
  /** The act entries it starts; a door that awaited them releases each when it has answered. */
  acts: string[];
  /** It changed the config it was handed in any way — the caller saves on it, or a marking made without a conclusion is lost. */
  wrote: boolean;
  /** Rethrow the first failure's cause — the two request-bound sites call it AFTER saving, so a failing cast still answers a failure. */
  throwIfFailed(): void;
}

const failureSaid = warnOnce<string>({ max: 20, every: 10 * 60_000 });

function recordFailure(failed: Settled['failed'], via: SettleVia, net: NetworkConfig, round: VoteRound, cause: unknown): void {
  failed.push({ round, cause });
  try { roundSettleFailuresTotal.inc({ via }); } catch { /* a counter never changes the settle */ }
  failureSaid(`${via}|${net.id}|${round.roundId}`, () =>
    log.warn(`round ${peerText(round.roundId)} of network ${peerText(net.id)} could not be settled (${via}): ${peerText(cause)}`));
}

/**
 * Evaluate `rounds` and apply what concluded. The caller saves the config it came from (on `wrote`), then may await `settled`.
 *
 * @param rounds the rounds to evaluate; one already concluded is not evaluated again
 * @param via who is settling them
 * @param now the ONE reading of the clock the caller took
 * @param retrySpaceRounds further rounds whose SPACE-scoped effect is applied or retried (gossip and the tick hand the held ones); nothing
 *   else is done for them
 */
export function settleRounds(
  net: NetworkConfig, cfg: Config, rounds: readonly VoteRound[], via: SettleVia, now: number,
  retrySpaceRounds: readonly VoteRound[] = [],
): Settled {
  const generation = configWriteGeneration();
  const concluded: VoteRound[] = [];
  const failed: Settled['failed'] = [];
  for (const round of rounds) {
    if (round.concluded) continue;
    try {
      concludeRoundIfReady(net, round, now);
      if (round.concluded) concluded.push(round);
    } catch (cause) {
      recordFailure(failed, via, net, round, cause);
    }
  }
  const applied = applyRoundConclusion(net, cfg, concluded, via, retrySpaceRounds, now);
  for (const f of applied.failed) recordFailure(failed, via, net, f.round, f.cause);
  const wrote = concluded.length > 0 || applied.wrote;
  // The caller saves on `wrote`, synchronously; a caller that saved nothing has it saved after this turn, before any other writer's
  // reload from disk could read the conclusion away (W15).
  if (wrote) setImmediate(() => saveIfUnsaved(cfg, generation, `the settle of network ${peerText(net.id)}`));
  return {
    concluded, failed, settled: applied.settled, acts: applied.acts,
    wrote,
    throwIfFailed() { if (failed.length > 0) throw failed[0]!.cause; },
  };
}

/**
 * Apply what `rounds` decided — called by {@link settleRounds} alone. Each round's application is its own `try`.
 *
 * @param rounds the rounds that concluded now; each is admitted, applied and, for a passed removal, announced
 * @param retrySpaceRounds further rounds whose space-scoped effect is applied or retried too
 */
export function applyRoundConclusion(
  net: NetworkConfig, cfg: Config, rounds: readonly VoteRound[], via: SettleVia,
  retrySpaceRounds: readonly VoteRound[] = [], now: number = Date.now(),
): { settled: Promise<SettledSpaceRound[]>; acts: string[]; wrote: boolean; failed: { round: VoteRound; cause: unknown }[] } {
  const failed: { round: VoteRound; cause: unknown }[] = [];
  let wrote = false;
  // A passed join: the credential holder admits, every other member of a voted network introduces (Q-154). Admitting on a
  // gossip copy, whose token hash is stripped, would add a member with no credential, which never paired.
  for (const round of rounds) {
    try {
      if (applyPassedJoin(net, cfg.instanceId, round) === 'admitted') {
        wrote = true;
        log.info(`Join round ${peerText(round.roundId)} concluded via ${peerText(via)} — added ${peerText(round.subjectLabel)} to network ${peerText(net.id)}`);
        // No request of this instance's operator asked for this admission unless the via is one (VR7).
        if (!REQUEST_VIAS.includes(via)) auditRoundEffect(ROUND_MEMBER_ADMITTED_OPERATION, net.id, round.roundId);
      }
    } catch (cause) {
      failed.push({ round, cause });
    }
  }
  // Deletion, wipe and addition (X-5, F-38.4).
  const space = applyConcludedSpaceRounds(net, cfg, [...new Set([...rounds, ...retrySpaceRounds])], via, { now, waiter: REQUEST_VIAS.includes(via) });
  failed.push(...space.failed);
  for (const round of rounds) {
    try {
      if (round.concluded && round.passed && round.type === 'remove') {
        sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
      }
    } catch (cause) {
      failed.push({ round, cause });
    }
  }
  return { settled: space.settled, acts: space.acts, wrote: wrote || space.wrote, failed };
}

/**
 * The `space_rebase` round: opened by a shared space's door, applied on each member at the round's DEADLINE (Q-748, design r4 §4.1 rule 4;
 * owner, 2026-11-18: a base change on a shared space is its own vote, counted like a deletion and applied at the vote's deadline, and a
 * member that left keeps its base).
 *
 * ## What it prevents
 *
 * - **A base that moves at the pass.** On a club or a pub/sub network the proposer's yes passes a round at once, so a change applied at the
 *   pass would leave a member no time to leave before every address of the space changed. Applied at the deadline, the voting period is
 *   every member's time to veto or leave; a member that leaves takes the network and its rounds off its config (`leaveNetworkAct`), so the
 *   round is never applied there and it keeps its base, its epoch and every name it gave out.
 * - **An application lost to a restart.** What is owed is the round itself, held in the network config until it is applied (the prune
 *   keeps it: `rebaseRoundUnapplied`), and the expiry tick applies every owed one ({@link applyOwedRebaseRounds}); nothing is held in memory.
 * - **An application twice.** The round is marked `appliedHere`, and the setting refuses an epoch it already holds (`settleRdf`,
 *   `rebase-round`), so a second tick or a second copy of the round moves nothing.
 *
 * It rewrites no record and closes no write: the base is a setting, and the RDF form is computed from it when asked.
 */
import type { Config, NetworkConfig } from '../config/types.js';
import { logInternalAudit } from '../audit/audit.js';
import { log, peerText } from '../util/log.js';
import { localToRemote } from '../sync/space-map.js';
import { proposeRound } from '../networks/propose-round.js';
import { rebaseRoundOwed, rebaseRoundUnapplied, roundIsOpen } from '../networks/round-state.js';
import { roundAnswer, roundDecided, type RoundAnswer } from '../networks/vote-acts.js';
import { rebaseRoundSpaceOf, settleRdf, type RebaseProposal } from './rdf-settle.js';
import { settleSpaceAct } from './apply-wipe-round.js';

/** The audit operation of one application of a passed rebase round, one row per member that applied it. */
export const SPACE_RDF_REBASE_OPERATION = 'space.rdf_rebase';

/**
 * Open a `space_rebase` round for `localSpaceId` on every network of `cfg` carrying it, carrying the new `{ base, vocab, epoch }` (bound by
 * every cast's `bsig`). A round of this instance's own for the same space and base that is open or still to land is answered again instead
 * of opening a second. The caller saves `cfg`.
 */
export function openRebaseRounds(cfg: Config, localSpaceId: string, proposal: RebaseProposal, now: number = Date.now()): RoundAnswer[] {
  const answers: RoundAnswer[] = [];
  for (const net of cfg.networks.filter(n => n.spaces.includes(localSpaceId))) {
    const spaceId = localToRemote(net, localSpaceId);
    const held = net.pendingRounds.find(r => r.proposedHere === true && r.type === 'space_rebase' && r.spaceId === spaceId
      && r.rebase?.base === proposal.base && (roundIsOpen(r, now) || rebaseRoundUnapplied(r)));
    if (held) { answers.push(roundAnswer(net, held, roundDecided(held))); continue; }
    const { answer } = proposeRound(net, cfg, {
      type: 'space_rebase', subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel, subjectUrl: '', spaceId, rebase: { ...proposal },
    }, { now });
    answers.push(answer);
  }
  return answers;
}

/**
 * Apply every rebase round of `net` that is owed at `now` (passed, unvetoed, its deadline come, not applied here): set the space's base,
 * vocab and epoch in its own definitions and its effective meta, mark the round `appliedHere`, and write one `space.rdf_rebase` audit row.
 * A round for a space this instance does not carry there is marked and moves nothing. SYNCHRONOUS, for the expiry tick's one save; returns
 * whether it changed the config.
 */
export function applyOwedRebaseRounds(net: NetworkConfig, cfg: Config, now: number): boolean {
  let wrote = false;
  for (const round of net.pendingRounds ?? []) {
    if (!rebaseRoundOwed(round, now)) continue;
    wrote = true;
    const local = rebaseRoundSpaceOf(net, round);
    const space = local === undefined ? undefined : cfg.spaces.find(s => s.id === local);
    if (!space || !round.rebase) { settleSpaceAct(net, round, 'not-carried'); continue; }
    const settled = settleRdf(space.ownMeta?.rdf ?? space.meta?.rdf, round.rebase, 'rebase-round');
    // Marked in the same synchronous step as the setting it writes, so the tick's one save holds both or neither (`settleSpaceAct`).
    settleSpaceAct(net, round, 'completed');
    if (!settled.ok || !settled.rebased || !settled.rdf) continue;
    space.meta = { ...(space.meta ?? {}), rdf: settled.rdf };
    if (space.ownMeta) space.ownMeta = { ...space.ownMeta, rdf: settled.rdf };
    if (space.meta.rdfBaseConflict) delete space.meta.rdfBaseConflict;
    log.info(`space '${peerText(space.id)}': RDF base moved from ${peerText(settled.rebased.from)} to ${peerText(settled.rebased.to)} `
      + `(epoch ${settled.rebased.epoch}) by round ${peerText(round.roundId)} of network ${peerText(net.id)}`);
    try {
      logInternalAudit({
        method: 'SYNC', path: `internal:round:${String(net.id).slice(0, 80)}:${String(round.roundId).slice(0, 80)}`,
        operation: SPACE_RDF_REBASE_OPERATION, spaceId: space.id,
      });
    } catch (err) {
      log.warn(`the audit entry ${SPACE_RDF_REBASE_OPERATION} for round ${peerText(round.roundId)} was not written: ${peerText(err)}`);
    }
  }
  return wrote;
}

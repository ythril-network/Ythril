/**
 * Land a passed `space_rebase` round at its DEADLINE (Q-748, design r4 §4.1 rule 4; owner, 2026-11-18: a base change on a shared space is
 * counted like a deletion and applied at the vote's deadline, and a member that left keeps its base).
 *
 * ## What it prevents
 *
 * - **A base that moves at the pass.** On a club or a pub/sub network the proposer's yes passes a round at once, so a change applied at the
 *   pass would leave a member no time to leave before every address of the space changed. Landed at the deadline, the voting period is
 *   every member's time to veto or leave; a member that leaves takes the network and its rounds off its config, so the round never lands
 *   there and it keeps its base, its epoch and every name it gave out.
 * - **A landing lost to a restart.** What is owed is the round itself, kept in the network config by the prune until it has landed
 *   (`rebaseRoundUnapplied`); the expiry tick lands every owed one through {@link applyOwedRebaseRounds}; nothing is held in memory.
 * - **A landing twice.** The round is marked through `settleSpaceAct`, and the setting refuses an epoch it already holds (`settleRdf`,
 *   `rebase-round`).
 * - **Two members on two bases at one epoch** (review finding 1 of slice A). A door refuses a rebase while one is held, but two members can
 *   still propose at the same moment, each round taking the same epoch. Of the passed rounds for one space and one epoch, exactly one
 *   lands, the same one on every member: the first by `rebaseLandingOrder` (earlier deadline, then lower round id), read from the rounds
 *   themselves, never from the order a member received them in. Every other is concluded as SUPERSEDED, said in the log and audited
 *   (`space.rdf_rebase_superseded`), never marked landed in silence; so is a round for an epoch the space already holds.
 *
 * It rewrites no record and holds no write: the base is a setting. It opens no round (the door does, in `applySpaceMetaUpdate`), so it
 * stays out of the server's largest import cycle.
 */
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import { auditRoundEffect, SPACE_RDF_REBASE_OPERATION, SPACE_RDF_REBASE_SUPERSEDED_OPERATION } from '../networks/round-audit.js';
import { log, peerText } from '../util/log.js';
import { rebaseLandingOrder, rebaseRoundOwed, roundPassedUnvetoed } from '../networks/round-state.js';
import { rebaseRoundSpaceOf, settleRdf } from './rdf-settle.js';
import { storeMovedRdf } from './rdf-store.js';
import { settleSpaceAct } from './apply-wipe-round.js';

/** The audit operations of a landing (declared with the other round effects, `networks/round-audit.ts`, which the audit table gate reads). */
export { SPACE_RDF_REBASE_OPERATION, SPACE_RDF_REBASE_SUPERSEDED_OPERATION };

/** The round that lands `epoch` of `localSpaceId`: the first by landing order of every passed rebase round held for it, over every network. */
function winnerOf(cfg: Config, localSpaceId: string, epoch: number): VoteRound | undefined {
  const rivals = cfg.networks.flatMap(n => (n.pendingRounds ?? []).filter(r => r.type === 'space_rebase' && r.rebase?.epoch === epoch
    && roundPassedUnvetoed(r) && rebaseRoundSpaceOf(n, r) === localSpaceId));
  return rivals.sort(rebaseLandingOrder)[0];
}

/** Conclude `round` here without landing it: said, audited, and marked so the prune lets it go. */
function supersede(net: NetworkConfig, round: VoteRound, spaceId: string, why: string): void {
  settleSpaceAct(net, round, 'superseded');
  log.info(`space '${peerText(spaceId)}': rebase round ${peerText(round.roundId)} of network ${peerText(net.id)} to ${peerText(round.rebase?.base)} `
    + `does not land: ${why}`);
  auditRoundEffect(SPACE_RDF_REBASE_SUPERSEDED_OPERATION, net.id, round.roundId, spaceId);
}

/**
 * Land every rebase round of `net` owed at `now` (passed, unvetoed, its deadline come, not applied here), in landing order: set the space's
 * base, vocab and epoch, and clear the space's recorded base conflicts (`storeMovedRdf`); mark the round; write one `space.rdf_rebase` audit
 * row. A round another one for the same epoch wins over, or whose epoch the space already holds, is superseded. A round for a space not
 * carried here is marked and moves nothing. SYNCHRONOUS, for the expiry tick's one save; returns whether it changed the config.
 */
export function applyOwedRebaseRounds(net: NetworkConfig, cfg: Config, now: number): boolean {
  let wrote = false;
  const owed = (net.pendingRounds ?? []).filter(r => rebaseRoundOwed(r, now)).sort(rebaseLandingOrder);
  for (const round of owed) {
    wrote = true;
    const local = rebaseRoundSpaceOf(net, round);
    const space = local === undefined ? undefined : cfg.spaces.find(s => s.id === local);
    if (!space || !round.rebase) { settleSpaceAct(net, round, 'not-carried'); continue; }
    const winner = winnerOf(cfg, space.id, round.rebase.epoch);
    if (winner && winner !== round && (winner.rebase?.base !== round.rebase.base || winner.rebase?.vocab !== round.rebase.vocab)) {
      supersede(net, round, space.id, `round ${peerText(winner.roundId)} lands epoch ${round.rebase.epoch} (the earlier deadline, then the lower round id)`);
      continue;
    }
    const stored = space.ownMeta?.rdf ?? space.meta?.rdf;
    if ((stored?.baseEpoch ?? -1) >= round.rebase.epoch) {
      // Its twin (the same names, opened on another network carrying the space) already landed them: nothing to say. Anything else lost.
      if (stored?.base === round.rebase.base && stored.vocab === round.rebase.vocab) settleSpaceAct(net, round, 'completed');
      else supersede(net, round, space.id, `the space already holds epoch ${stored?.baseEpoch ?? 0}`);
      continue;
    }
    const settled = settleRdf(stored, round.rebase, 'rebase-round');
    settleSpaceAct(net, round, 'completed');
    if (!settled.ok || !settled.rebased || !settled.rdf) continue;
    if (!storeMovedRdf(cfg, space, settled.rdf)) continue;
    log.info(`space '${peerText(space.id)}': RDF base moved from ${peerText(settled.rebased.from)} to ${peerText(settled.rebased.to)} `
      + `(epoch ${settled.rebased.epoch}) by round ${peerText(round.roundId)} of network ${peerText(net.id)}`);
    // Through the one writer of a round's effects, which never throws and names the network and the round in the path.
    auditRoundEffect(SPACE_RDF_REBASE_OPERATION, net.id, round.roundId, space.id);
  }
  return wrote;
}

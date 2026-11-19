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
 * - **One network's yes over another's veto.** A space in several networks gets one round per network (the door opens one on each), and a
 *   deletion removes a space's copy only once no network carries it, so a veto in one network keeps it. A base cannot leave one network and
 *   stay in another, so the rebase takes that rule's destructive half: the names land only once every network carrying the space here has
 *   passed a round to the same names and come due; while one is still open nothing lands, and a veto or an expiry there supersedes it.
 * - **A landing marked before its store** (review finding 13 of slice A). The round is marked only after the store succeeded: a store that
 *   throws leaves it owed for the next tick, said once per window; a moved setting no stored meta can hold concludes the round as FAILED
 *   (`refusedHere`, a log line, `space.rdf_rebase_failed`), never as landed.
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
import {
  auditRoundEffect, SPACE_RDF_REBASE_FAILED_OPERATION, SPACE_RDF_REBASE_OPERATION, SPACE_RDF_REBASE_SUPERSEDED_OPERATION,
} from '../networks/round-audit.js';
import { log, peerText } from '../util/log.js';
import { SAY_ONCE_WINDOW_MS, warnOnce } from '../util/warn-once.js';
import { rebaseLandingOrder, rebaseRoundOwed, roundIsOpen, roundPassedUnvetoed, roundPastDeadline } from '../networks/round-state.js';
import { rebaseRoundSpaceOf, settleRdf } from './rdf-settle.js';
import { storeMovedRdf } from './rdf-store.js';
import { settleSpaceAct } from './apply-wipe-round.js';

/** The audit operations of a landing (declared with the other round effects, `networks/round-audit.ts`, which the audit table gate reads). */
export { SPACE_RDF_REBASE_OPERATION, SPACE_RDF_REBASE_SUPERSEDED_OPERATION, SPACE_RDF_REBASE_FAILED_OPERATION };

/** A store that threw: said once per round per window, so a fault that lasts does not write a line every tick. */
const storeFault = warnOnce<string>({ max: 10, every: SAY_ONCE_WINDOW_MS });

/** The round that lands `epoch` of `localSpaceId`: the first by landing order of every passed rebase round held for it, over every network. */
function winnerOf(cfg: Config, localSpaceId: string, epoch: number): VoteRound | undefined {
  const rivals = cfg.networks.flatMap(n => (n.pendingRounds ?? []).filter(r => r.type === 'space_rebase' && r.rebase?.epoch === epoch
    && roundPassedUnvetoed(r) && rebaseRoundSpaceOf(n, r) === localSpaceId));
  return rivals.sort(rebaseLandingOrder)[0];
}

/**
 * What the OTHER networks carrying `localSpaceId` here say about `round`'s names, as a deletion asks before it removes a space's copy (the
 * copy goes only once no network carries it): `'let'` when every one of them holds a passed rebase round to the same names whose deadline
 * has come, `'wait'` while one of them still holds such a round open or before its deadline, `'held'` (naming the network) when one vetoed
 * it, let it expire, or holds no rebase to these names.
 */
function otherNetworks(cfg: Config, net: NetworkConfig, localSpaceId: string, round: VoteRound, now: number): 'let' | 'wait' | { held: string } {
  let wait = false;
  for (const other of cfg.networks) {
    if (other === net || !other.spaces.includes(localSpaceId)) continue;
    const same = (other.pendingRounds ?? []).filter(r => r.type === 'space_rebase' && rebaseRoundSpaceOf(other, r) === localSpaceId
      && r.rebase?.base === round.rebase?.base && r.rebase?.vocab === round.rebase?.vocab && r.rebase?.epoch === round.rebase?.epoch);
    if (same.some(r => roundPassedUnvetoed(r) && roundPastDeadline(r, now))) continue;
    if (same.some(r => roundPassedUnvetoed(r) || roundIsOpen(r, now))) { wait = true; continue; }
    return { held: other.id };
  }
  return wait ? 'wait' : 'let';
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
    const local = rebaseRoundSpaceOf(net, round);
    const space = local === undefined ? undefined : cfg.spaces.find(s => s.id === local);
    if (!space || !round.rebase) { settleSpaceAct(net, round, 'not-carried'); wrote = true; continue; }
    const winner = winnerOf(cfg, space.id, round.rebase.epoch);
    if (winner && winner !== round && (winner.rebase?.base !== round.rebase.base || winner.rebase?.vocab !== round.rebase.vocab)) {
      supersede(net, round, space.id, `round ${peerText(winner.roundId)} lands epoch ${round.rebase.epoch} (the earlier deadline, then the lower round id)`);
      wrote = true;
      continue;
    }
    // A space in several networks moves only once every network carrying it here has let it (the deletion's rule): a veto in one holds it.
    const others = otherNetworks(cfg, net, space.id, round, now);
    if (others === 'wait') continue;
    wrote = true;
    if (others !== 'let') { supersede(net, round, space.id, `network ${peerText(others.held)}, which carries the space here too, did not pass a rebase to these names`); continue; }
    const stored = space.ownMeta?.rdf ?? space.meta?.rdf;
    if ((stored?.baseEpoch ?? -1) >= round.rebase.epoch) {
      // Its twin (the same names, opened on another network carrying the space) already landed them: nothing to say. Anything else lost.
      if (stored?.base === round.rebase.base && stored.vocab === round.rebase.vocab) settleSpaceAct(net, round, 'completed');
      else supersede(net, round, space.id, `the space already holds epoch ${stored?.baseEpoch ?? 0}`);
      continue;
    }
    const settled = settleRdf(stored, round.rebase, 'rebase-round');
    if (!settled.ok || !settled.rebased || !settled.rdf) { settleSpaceAct(net, round, 'completed'); continue; }
    // Marked only once the store succeeded (review finding 13): a store that throws leaves the round owed, landed by the next tick.
    let storedHere: boolean;
    try {
      storedHere = storeMovedRdf(cfg, space, settled.rdf);
    } catch (err) {
      storeFault(round.roundId, () => log.warn(`space '${peerText(space.id)}': rebase round ${peerText(round.roundId)} could not be stored now, `
        + `and is tried again at the next tick: ${peerText(err)}`));
      continue;
    }
    if (!storedHere) {
      // A moved setting no stored meta can hold never stores: concluded as FAILED here, said on the round and audited, never as landed.
      round.refusedHere = `the moved RDF setting (${peerText(round.rebase.base)}) could not be stored in this space's meta, so the base did not move here`;
      log.warn(`space '${peerText(space.id)}': rebase round ${peerText(round.roundId)} of network ${peerText(net.id)} failed here: ${round.refusedHere}`);
      auditRoundEffect(SPACE_RDF_REBASE_FAILED_OPERATION, net.id, round.roundId, space.id);
      continue;
    }
    settleSpaceAct(net, round, 'completed');
    log.info(`space '${peerText(space.id)}': RDF base moved from ${peerText(settled.rebased.from)} to ${peerText(settled.rebased.to)} `
      + `(epoch ${settled.rebased.epoch}) by round ${peerText(round.roundId)} of network ${peerText(net.id)}`);
    // Through the one writer of a round's effects, which never throws and names the network and the round in the path.
    auditRoundEffect(SPACE_RDF_REBASE_OPERATION, net.id, round.roundId, space.id);
  }
  return wrote;
}

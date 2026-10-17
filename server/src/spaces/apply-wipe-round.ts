/**
 * The side-effect of a concluded `space_wipe` round: empty the space, here, now.
 *
 * ## One function, three callers, on purpose
 *
 * A round concludes in three places — an operator's own vote (`api/networks/votes.ts`), a peer's vote
 * arriving over sync (`api/sync/votes.ts`), and the gossip pass in the sync engine. `space_deletion` has its
 * side-effect written out at all three, and that is the shape this repo keeps paying for: three copies of
 * one rule, where a change to two of them leaves the third quietly doing the old thing.
 *
 * So the wipe lands as ONE function the three call. It is not more indirection than the alternative — it is
 * the same code, named once.
 *
 * ## Veto counting matches `space_deletion` exactly
 *
 * A single veto stops it. That is deliberately stricter than a majority: a member that does not want its
 * copy of a space emptied is not outvoted, because the wipe is irreversible on their instance too.
 *
 * ## Which space, and when — `spaceRoundAction` (`S-9`)
 *
 * A deletion or wipe acts only on a round that PASSED — `concluded` alone includes a round that expired without
 * enough yes — on the space the round names mapped to this instance's id AND carried by the network the round
 * belongs to, and once. Each was missing: the id was used as the round carried it, so any member of any network
 * could name any space here, including one no network shares; an expired proposal deleted like a passed one; and
 * gossip hands this every round the network ever held, so an old deletion re-applied to a space re-created under
 * the same name. `appliedHere` is local state — adopting or serving a round strips it.
 */
import { log, peerText } from '../util/log.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import type { WipeCollectionType } from './lifecycle.js';
import { roundSpaceLocalId } from '../sync/space-map.js';

/** What a concluded space round does here, if anything. */
export type SpaceRoundAction =
  | { kind: 'delete'; localId: string }
  | { kind: 'wipe'; localId: string; types?: WipeCollectionType[] };

/** The decision, pure: a passed, unvetoed, not-yet-applied deletion or wipe of a space this network carries. */
export function spaceRoundAction(
  net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>,
  round: Pick<VoteRound, 'type' | 'spaceId' | 'networkSpaceId' | 'concluded' | 'passed' | 'votes' | 'wipeTypes'> & { appliedHere?: boolean },
): SpaceRoundAction | null {
  if (round.type !== 'space_deletion' && round.type !== 'space_wipe') return null;
  if (!round.concluded || !round.passed || round.appliedHere || !round.spaceId) return null;
  // A single veto stops it.
  if (round.votes.some(v => v.vote === 'veto')) return null;
  const localId = roundSpaceLocalId(net, round);
  if (!localId) return null;
  if (round.type === 'space_deletion') return { kind: 'delete', localId };
  // The types the members VOTED for, never a fresh default. A round approved for `files` must not conclude
  // by emptying the knowledge graph, which is what resolving this at conclusion time would risk.
  const types = round.wipeTypes as WipeCollectionType[] | undefined;
  return { kind: 'wipe', localId, ...(types ? { types } : {}) };
}

/**
 * How a concluded space round came to need nothing more from this instance:
 * - `completed` — its act ran here (the runner's completion);
 * - `absent` — the space it names is gone here, so there is nothing to act on;
 * - `not-carried` — this instance does not carry the space the round names;
 * - `superseded` — an addition retired by a later deletion of the same network space.
 */
export type SpaceActSettlement = 'completed' | 'absent' | 'not-carried' | 'superseded';

/**
 * Mark `round` of `net` as needing nothing more here — THE writer of `appliedHere` (design v5 §2.1, W23).
 *
 * `appliedHere` is what stops a round being acted on again: gossip hands every held round back on every changed pass. Written in
 * more than one place, one copy marked a round applied BEFORE its act ran, and a crash between the two lost the act; another never
 * marked it at all, and the act ran again on a space re-created under the same name. So every settlement goes through here, and the
 * caller makes it part of the SAME config write as whatever completed the act (the runner removes its entry in that write).
 *
 * Mutates `round` in place — it must be the round held by the config the caller saves, found by network and round id inside that
 * caller's `mutateConfig`, never one read before an await.
 */
export function settleSpaceAct(net: Pick<NetworkConfig, 'id'>, round: VoteRound, how: SpaceActSettlement): void {
  const local = round as VoteRound & { appliedHere?: boolean };
  if (local.appliedHere === true) return;
  local.appliedHere = true;
  if (how !== 'completed') {
    log.info(`${round.type} round ${peerText(round.roundId)} of network ${peerText(net.id)} settled here: ${how}`);
  }
}

/**
 * Apply every space-scoped side-effect for a list of rounds — deletion, wipe and addition.
 *
 * The gossip pass in `sync/engine.ts` concludes rounds nobody on this instance voted on, and had the
 * `space_deletion` side-effect written out inline there: a third copy of the same eight lines that already
 * existed in the two vote handlers. Adding `space_wipe` beside it would have made six.
 *
 * So the loop moved here. `no-new-god-files.test.js` is what forced it, and it was right — engine.ts is one
 * of the largest files in the tree, and the reason it is large is that every change lands where the code
 * already is. A round acted on is marked `appliedHere` at once; the caller saves the config it came from.
 */
export function applyConcludedSpaceRounds(net: NetworkConfig, rounds: readonly VoteRound[], where: string): void {
  for (const round of rounds) {
    // F-38.4: a passed space_addition adds the space here. The two vote routes call this too, so a round carried by
    // a local vote, a peer's vote or gossip lands the same way.
    if (round.concluded && round.passed && round.type === 'space_addition') {
      void import('../networks/network-spaces.js')
        .then(({ applySpaceAdditionRound }) => applySpaceAdditionRound(net, round, where))
        .catch((err: unknown) => log.error(`space_addition side-effect (${peerText(where)}): ${peerText(err)}`));
    }
    const action = spaceRoundAction(net, round);
    if (!action) continue;
    (round as VoteRound & { appliedHere?: boolean }).appliedHere = true;
    if (action.kind === 'delete') {
      // A network never deletes a member's space (Q-70): the space leaves the network here, every member keeps its
      // copy, and only the instance whose operator asked for the delete removes its own — once no other network
      // still carries it, since the operator's delete opened a round on each of them.
      void import('../networks/network-spaces.js').then(({ removeSpaceFromNetwork }) => {
        removeSpaceFromNetwork(net.id, action.localId, `space_deletion round ${round.roundId} passed, ${where}`);
        if (!round.proposedHere) return;
        setImmediate(() => {
          void import('../config/loader.js').then(async ({ getConfig }) => {
            if (getConfig().networks.some(n => n.spaces.includes(action.localId))) {
              log.info(`space_deletion round ${peerText(round.roundId)} passed (${peerText(where)}): '${peerText(action.localId)}' is still in another network, kept until that round passes`);
              return;
            }
            const { removeSpace } = await import('./lifecycle.js');
            await removeSpace(action.localId);
            log.info(`space_deletion round ${peerText(round.roundId)} passed (${peerText(where)}): removed this instance's own '${peerText(action.localId)}'`);
          }).catch((err: unknown) => log.error(`space_deletion side-effect (${peerText(where)}): ${peerText(err)}`));
        });
      }).catch((err: unknown) => log.error(`space_deletion side-effect (${peerText(where)}): ${peerText(err)}`));
    } else {
      void import('./lifecycle.js').then(({ wipeSpace }) =>
        wipeSpace(action.localId, action.types)
          .then(r => log.info(
            `space_wipe round ${peerText(round.roundId)} passed (${peerText(where)}): emptied '${peerText(action.localId)}' — `
            + `${r.facts} facts, ${r.entities} entities, ${r.edges} edges, ${r.chrono} chrono, ${r.files} files`,
          ))
          .catch((err: unknown) => log.error(`space_wipe side-effect (${peerText(where)}): ${peerText(err)}`)),
      ).catch((err: unknown) => log.error(`space_wipe import (${peerText(where)}): ${peerText(err)}`));
    }
  }
}

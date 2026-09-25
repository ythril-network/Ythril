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
import { log } from '../util/log.js';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import type { WipeCollectionType } from './lifecycle.js';
import { remoteToLocal } from '../sync/space-map.js';

/** What a concluded space round does here, if anything. */
export type SpaceRoundAction =
  | { kind: 'delete'; localId: string }
  | { kind: 'wipe'; localId: string; types?: WipeCollectionType[] };

/** The decision, pure: a passed, unvetoed, not-yet-applied deletion or wipe of a space this network carries. */
export function spaceRoundAction(
  net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>,
  round: Pick<VoteRound, 'type' | 'spaceId' | 'concluded' | 'passed' | 'votes' | 'wipeTypes'> & { appliedHere?: boolean },
): SpaceRoundAction | null {
  if (round.type !== 'space_deletion' && round.type !== 'space_wipe') return null;
  if (!round.concluded || !round.passed || round.appliedHere || !round.spaceId) return null;
  // A single veto stops it.
  if (round.votes.some(v => v.vote === 'veto')) return null;
  const localId = remoteToLocal(net as NetworkConfig, round.spaceId);
  if (!net.spaces.includes(localId)) return null;
  if (round.type === 'space_deletion') return { kind: 'delete', localId };
  // The types the members VOTED for, never a fresh default. A round approved for `files` must not conclude
  // by emptying the knowledge graph, which is what resolving this at conclusion time would risk.
  const types = round.wipeTypes as WipeCollectionType[] | undefined;
  return { kind: 'wipe', localId, ...(types ? { types } : {}) };
}

/**
 * Apply every space-scoped side-effect for a list of rounds — deletion and wipe.
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
    const action = spaceRoundAction(net, round);
    if (!action) continue;
    (round as VoteRound & { appliedHere?: boolean }).appliedHere = true;
    if (action.kind === 'delete') {
      void import('./lifecycle.js')
        .then(({ removeSpace }) => removeSpace(action.localId))
        .then(() => log.info(`space_deletion round ${round.roundId} passed (${where}): removed '${action.localId}'`))
        .catch((err: unknown) => log.error(`space_deletion side-effect (${where}): ${err}`));
    } else {
      void import('./lifecycle.js').then(({ wipeSpace }) =>
        wipeSpace(action.localId, action.types)
          .then(r => log.info(
            `space_wipe round ${round.roundId} passed (${where}): emptied '${action.localId}' — `
            + `${r.facts} facts, ${r.entities} entities, ${r.edges} edges, ${r.chrono} chrono, ${r.files} files`,
          ))
          .catch((err: unknown) => log.error(`space_wipe side-effect (${where}): ${err}`)),
      ).catch((err: unknown) => log.error(`space_wipe import (${where}): ${err}`));
    }
  }
}

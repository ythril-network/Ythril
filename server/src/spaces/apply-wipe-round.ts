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
 */
import { log } from '../util/log.js';
import type { VoteRound } from '../config/types.js';
import type { WipeCollectionType } from './lifecycle.js';

/**
 * Apply a concluded round if — and only if — it is a `space_wipe` that carried.
 *
 * Returns whether the wipe was started, so a caller can log or test the decision without waiting on the
 * write. Fire-and-forget beyond that: a wipe that fails must not abort the vote handling that produced it,
 * for the same reason `space_deletion`'s does not.
 */
export function applyWipeRoundIfPassed(round: VoteRound, where: string): boolean {
  if (!round.concluded || round.type !== 'space_wipe') return false;
  if (!round.spaceId) return false;
  // A single veto stops it, exactly as for space_deletion.
  if (round.votes.some(v => v.vote === 'veto')) return false;

  // The types the members VOTED for, never a fresh default. A round approved for `files` must not conclude
  // by emptying the knowledge graph, which is what resolving this at conclusion time would risk.
  const types = round.wipeTypes as WipeCollectionType[] | undefined;

  void import('./lifecycle.js').then(({ wipeSpace }) =>
    wipeSpace(round.spaceId!, types)
      .then(r => log.info(
        `space_wipe round ${round.roundId} passed (${where}): emptied '${round.spaceId}' — `
        + `${r.facts} memories, ${r.entities} entities, ${r.edges} edges, ${r.chrono} chrono, ${r.files} files`,
      ))
      .catch((err: unknown) => log.error(`space_wipe side-effect (${where}): ${err}`)),
  ).catch((err: unknown) => log.error(`space_wipe import (${where}): ${err}`));

  return true;
}

/**
 * Apply every space-scoped side-effect for a list of rounds — deletion and wipe both.
 *
 * The gossip pass in `sync/engine.ts` concludes rounds nobody on this instance voted on, and had the
 * `space_deletion` side-effect written out inline there: a third copy of the same eight lines that already
 * existed in the two vote handlers. Adding `space_wipe` beside it would have made six.
 *
 * So the loop moved here. `no-new-god-files.test.js` is what forced it, and it was right — engine.ts is one
 * of the largest files in the tree, and the reason it is large is that every change lands where the code
 * already is.
 */
export function applyConcludedSpaceRounds(rounds: readonly VoteRound[], where: string): void {
  for (const round of rounds) {
    if (round.concluded && round.type === 'space_deletion') {
      // Unchanged: zero vetoes, and a space id to act on. Moved, not rewritten.
      if (!round.votes.some(v => v.vote === 'veto') && round.spaceId) {
        void import('./lifecycle.js')
          .then(({ removeSpace }) => removeSpace(round.spaceId!))
          .catch((err: unknown) => log.error(`space_deletion side-effect (${where}): ${err}`));
      }
    }
    applyWipeRoundIfPassed(round, where);
  }
}

/**
 * How many unresolved versions a space holds, per kind, and how many of them are a decision another instance already made (Q-624, design §13, S8).
 *
 * ## The question, and the two askers
 *
 * One question: *"how many fork rows does this space hold, and how many carry the `_resolvedElsewhere` mark?"* Two places ask it and must not answer
 * it differently: the gauge `ythril_unresolved_forks` (an operator's alert, summed over the spaces at scrape time) and the `MERKLE_DIVERGENCE` line
 * (which names the forks awaiting a decision, so a divergence that is the cost of the owner's decision reads as that and not as lost data).
 *
 * ## What it prevents
 *
 * A count written twice differs in what it calls a fork. A fork is a row whose `forkOf` is present, read through the sparse `{ forkOf: 1 }` index of
 * each forking collection (`FORK_INDEXES`), so a count is a walk of the forks and never of the collection. A mark counts when its array holds an entry
 * (`_resolvedElsewhere.0`): an emptied array is no decision owed. The kinds are DERIVED from `FORKING_FAMILIES`, so a fifth forking family is counted
 * by being declared, and the answer names every kind, zero included: an absent series and a zero one look alike on a graph and mean opposite things.
 *
 * It is a leaf on purpose: the metrics registry imports it, so it imports nothing that imports the registry (the fork module does, through the
 * recorders), and the kind type is imported as a type only.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { FORKING_FAMILIES } from '../sync/upsert-plan.js';
import { RESOLVED_ELSEWHERE } from '../sync/local-only-fields.js';
import { TOMBSTONE_TYPE_OF } from '../config/types-knowledge.js';
import type { ForkKind } from './forks.js';

/** What one kind holds: every fork row, and the ones that carry a decision another instance made. */
export interface ForkCounts { unresolved: number; resolvedElsewhere: number }

/** The kinds that fork, by record type, in `FORKING_FAMILIES` order: the keys of every answer here. */
export const COUNTED_FORK_KINDS: readonly { kind: ForkKind; family: (typeof FORKING_FAMILIES)[number] }[] = Object.freeze(
  FORKING_FAMILIES.map(family => Object.freeze({ kind: TOMBSTONE_TYPE_OF[family] as ForkKind, family })),
);

/** Per kind: the fork rows of `spaceId` and how many carry a mark. Every kind is answered. Throws what the store throws; a caller decides what that means. */
export async function forkCountsOf(spaceId: string): Promise<Record<ForkKind, ForkCounts>> {
  const out = {} as Record<ForkKind, ForkCounts>;
  for (const { kind, family } of COUNTED_FORK_KINDS) {
    const coll = col<{ _id: string }>(spaceCollection(spaceId, family));
    const [unresolved, resolvedElsewhere] = await Promise.all([
      coll.countDocuments(asFilter<{ _id: string }>({ forkOf: { $exists: true } })),
      coll.countDocuments(asFilter<{ _id: string }>({ forkOf: { $exists: true }, [`${RESOLVED_ELSEWHERE}.0`]: { $exists: true } })),
    ]);
    out[kind] = { unresolved, resolvedElsewhere };
  }
  return out;
}

/** How many versions of `spaceId` await a decision here that another instance already made: the sum of the marks over every kind. */
export async function forksAwaitingADecision(spaceId: string): Promise<number> {
  return Object.values(await forkCountsOf(spaceId)).reduce((n, c) => n + c.resolvedElsewhere, 0);
}

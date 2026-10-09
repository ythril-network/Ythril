/**
 * The index the functional guard collides on, declared ONCE, built through ONE function, and said out loud when it cannot be
 * (`Q-439`).
 *
 * ## What it prevents
 *
 * A strict space's functional label allows a subject one edge. Two writers that both count zero edges at `(from, label)` both
 * insert, and only a UNIQUE index can refuse the second: the guard is `_functionalGuard = functionalSubjectKey(from, label)`
 * on an edge inserted under such a label, and this is the index over it. The options are the guard itself — without `unique`
 * nothing collides, and without the partial filter every unmarked edge is one `null` key and the second of them collides — so
 * they live in the declaration next to the keys and no build site writes them by hand (`LINK_INDEXES` is built as
 * `createIndex(ix.keys, ix.unique ? { unique: true } : {})` at two sites: the keys shared, the options spelled twice).
 *
 * The sites that build it are `initSpace` (a space at boot and at creation), the `ensureQueryIndexes` unit (a space whose
 * collection existed before the index did) and the online restore (which drops every collection and so every index). Each
 * calls {@link ensureEdgeGuardIndex}.
 *
 * ## A build that fails, and what the caller is told
 *
 * - **A duplicate marker** (the one failure a build over data can have): two edges holding one guard cannot be indexed, and the
 *   index that refuses the second is what is missing. A marker is a function of the edge carrying it, so the surplus ones are
 *   removable without losing anything: {@link thinGuards} clears every marker that does not name its own `(from, label)`, and
 *   of the markers that do, all but the lowest `_id` per subject. The thinned edges stay; they are unguarded, not deleted, and
 *   the planner's count still refuses a second edge under the label. The thinning is counted and said once through the
 *   housekeeping reporter, and the build is retried once in the same call.
 * - **Anything else** (a store that refused the command, one that stopped answering, an option conflict with an index already
 *   there): it propagates. It is not "a duplicate", and treating it as one would answer a failing build as a built index.
 *
 * It never swallows a failure itself: the caller says it ({@link edgeIndexFailure}), because only the caller knows whether the
 * space is initialising (never to be stopped by this) or being restored (whose answer names it).
 */
import type { CreateIndexesOptions } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { isDuplicateKeyOnly } from '../db/write-errors.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { peerText } from '../util/log.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { guardNamesItsEdge } from '../brain/functional-subject.js';
import { clearStaleWriteGuard } from '../brain/write-plan/commit.js';
import type { EdgeDoc } from '../config/types.js';

/** The step a failed edge index build is counted and said under (`ythril_housekeeping_space_failures_total{step}`). */
export const EDGE_INDEX_STEP = declareStep('Edge indexes');

/** An index of the edges collection: its keys and the options it is built with, both read by the one builder. */
interface EdgeIndexDeclaration {
  readonly keys: Readonly<Record<string, 1>>;
  readonly options: CreateIndexesOptions;
}

/**
 * The write guard's index. `$type: 'string'` and not `$exists: true`: `$exists` indexes a stored `null`, and every edge whose
 * marker was cleared to `null` would then collide with the next.
 */
export const EDGE_GUARD_INDEXES: readonly EdgeIndexDeclaration[] = [
  { keys: { _functionalGuard: 1 }, options: { unique: true, partialFilterExpression: { _functionalGuard: { $type: 'string' } } } },
];

/** What the thinning reads of an edge: the guard, and the subject it should name. */
const THINNING_PROJECTION = { _id: 1, from: 1, label: 1, _functionalGuard: 1 } as const;

/**
 * Clear the markers a unique index could not be built over, and say how many were cleared.
 *
 * A marker is kept when it names the `(from, label)` of its edge AND no edge of a lower `_id` holds it, so the keeper is the
 * same on every run and on every instance. The read is a projected, `_id`-ordered pass over the MARKED edges only, and each
 * clear is a compare-and-swap (`clearStaleWriteGuard`): an edge relabelled, deleted or already cleared since it was read is
 * left alone.
 */
async function thinGuards(spaceId: string): Promise<number> {
  const marked = col<EdgeDoc>(spaceCollection(spaceId, 'edges')).aggregate<Pick<EdgeDoc, '_id' | 'from' | 'label' | '_functionalGuard'>>([
    { $match: asFilter<EdgeDoc>({ _functionalGuard: { $type: 'string' } }) },
    { $sort: { _id: 1 } },
    { $project: THINNING_PROJECTION },
  ], { allowDiskUse: true });
  const kept = new Set<string>();
  let cleared = 0;
  for await (const row of marked) {
    const guard = row._functionalGuard;
    if (typeof guard !== 'string') continue;
    if (guardNamesItsEdge(row) && !kept.has(guard)) { kept.add(guard); continue; }
    if (await clearStaleWriteGuard(spaceId, row, guard)) cleared++;
  }
  return cleared;
}

/**
 * Build every index of {@link EDGE_GUARD_INDEXES} on a space's edges. Idempotent: an index already there is a no-op.
 *
 * A build that fails on a duplicate marker thins the markers ({@link thinGuards}, counted and reported) and is tried once more;
 * a second refusal, and every other failure, propagates to the caller.
 */
export async function ensureEdgeGuardIndex(spaceId: string): Promise<void> {
  const edges = col(spaceCollection(spaceId, 'edges'));
  for (const ix of EDGE_GUARD_INDEXES) {
    try {
      await edges.createIndex(ix.keys, ix.options);
    } catch (err) {
      if (!isDuplicateKeyOnly(err)) throw err;
      const cleared = await thinGuards(spaceId);
      if (cleared > 0) {
        reportSpaceFailure(EDGE_INDEX_STEP, spaceId,
          new Error('edges held write guards that duplicated another edge\'s or named another subject; the surplus guards were cleared so the index could be built'),
          { unit: 'guard index', count: cleared, when: 'at once' });
      }
      await edges.createIndex(ix.keys, ix.options);
    }
  }
}

/**
 * Say a failed edge index build, once per window, through the housekeeping reporter; returns the words for a caller that also
 * answers with it (the online restore). Never throws, so it is safe in a `catch`.
 *
 * @param unit which index: `guard index` or `identity index`.
 * @param when when it is tried again, in the line's words.
 */
export function edgeIndexFailure(spaceId: string, unit: string, err: unknown, when: string): string {
  reportSpaceFailure(EDGE_INDEX_STEP, spaceId, err, { unit, when });
  return `${unit}: ${peerText(err)}`;
}

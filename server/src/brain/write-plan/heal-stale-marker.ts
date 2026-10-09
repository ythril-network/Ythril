/**
 * What a write that lost on the functional guard asks of the store, and the ONE place a phantom guard is cleared (`Q-439`).
 *
 * ## What it prevents
 *
 * The guard is `_functionalGuard = functionalSubjectKey(from, label)`, and a unique partial index refuses a second edge
 * carrying the same one. Every writer that moves an edge's `from` or `label` drops or restamps it in the same write, so a stored
 * marker always names the edge it sits on. When one does not — a write path that missed it, a backup restored by an older
 * build, a hand edit — it is a PHANTOM: it holds a subject's slot for an edge that is not under that subject, and refuses
 * every legitimate write there, for ever, with a duplicate-key error nobody can explain. This is the one function that asks
 * which it is, so a door cannot treat a phantom as a lost race (answering a conflict for a write nothing contends with), nor
 * a lost race as a phantom (clearing the marker of the edge that rightly won).
 *
 * ## The question, answered from the holder
 *
 * A write whose insert was refused on the guard reads WHO holds it, by the marker, and the answer is one of three:
 *
 *  - `healed` — the holder is not under the subject its marker names. It was cleared (a compare-and-swap, so a holder that
 *    changed since the read is left alone), the heal is counted and said once through the housekeeping reporter, and the
 *    caller may retry at once: the retry is not charged to its attempts.
 *  - `held` — the holder IS under the subject. This write lost a race to a real edge; it is counted
 *    (`ythril_functional_race_lost_total`), and the caller re-plans against what now exists, which refuses it with the
 *    ordinary functional violation.
 *  - `none` — nobody holds the marker any more (a delete or a relabel in flight), the holder is the edge being written
 *    (an identical-triplet race, which converges), or the clear lost its swap. Nothing was healed and nothing was lost to a
 *    peer; the caller's own attempts decide.
 *
 * It never throws: it runs on the failure path of a write, where a second failure would replace the one being answered. A
 * store that does not answer is said through the same reporter, and the caller's next read raises it.
 *
 * The holder is read with an EXPLICIT projection that names the guard: the marker is withheld from every answer
 * (`NEVER_RETURNED_FIELDS`), so a read that wanted it has to say so, and this is one of the two readers that do.
 */
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { declareStep } from '../../util/housekeeping-signals.js';
import { reportSpaceFailure } from '../../util/space-failure.js';
import { functionalRaceLostTotal } from '../../metrics/registry.js';
import { guardNamesItsEdge } from '../functional-subject.js';
import { clearStaleWriteGuard } from './commit.js';
import type { EdgeDoc } from '../../config/types.js';

/** The step a phantom guard is reported and counted under (`ythril_housekeeping_space_failures_total{step}`). */
const STEP = declareStep('Functional guard heal');

export type GuardVerdict = 'healed' | 'held' | 'none';
/** What the holder lookup reads: the identity of the edge and its subject, plus the guard itself. */
const HOLDER_PROJECTION = { _id: 1, from: 1, label: 1, _functionalGuard: 1 } as const;

/**
 * Who holds `guard` in `spaceId`'s edges, and is it a phantom? `ownId` is the id of the edge being written, when the caller
 * has one: a holder with that id is the same edge, not a rival.
 */
export async function healStaleMarker(spaceId: string, guard: string, ownId?: string): Promise<GuardVerdict> {
  try {
    const holder = await col<EdgeDoc>(spaceCollection(spaceId, 'edges'))
      .findOne(asFilter<EdgeDoc>({ _functionalGuard: guard }), { projection: HOLDER_PROJECTION }) as
        Pick<EdgeDoc, '_id' | 'from' | 'label' | '_functionalGuard'> | null;
    if (!holder || holder._id === ownId) return 'none';
    if (guardNamesItsEdge(holder)) {
      functionalRaceLostTotal.labels({ space: spaceId }).inc();
      return 'held';
    }
    if (!(await clearStaleWriteGuard(spaceId, holder, guard))) return 'none';
    reportSpaceFailure(STEP, spaceId,
      new Error('an edge held a write guard that names another subject than the one it is under; the guard was cleared'),
      { unit: holder._id, when: 'at once' });
    return 'healed';
  } catch (err) {
    reportSpaceFailure(STEP, spaceId, err, { when: 'next write' });
    return 'none';
  }
}

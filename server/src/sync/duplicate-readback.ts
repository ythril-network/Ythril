/**
 * What a duplicate key on a guarded write means: read the stored copy back and say how it stands to the version the write planned (bundle-81, design
 * rev 8 §6c, decision 55).
 *
 * ## The question it answers
 *
 * A guarded upsert (`seqGuard`, `sync/upsert-plan.ts`: `{ _id, seq < planned }`) that fails with a duplicate key says one of three things, and the
 * failure alone cannot tell which: a copy at the SAME version landed (a bulk write that failed ambiguously after applying, or a racing push of the
 * same document), a NEWER copy was written between the accept read and the write (the guard did its job and the newer copy is kept), or the key that
 * collided is another unique index (an edge's triplet, a link's endpoints). This module reads the stored copies back by id (`readStoredById`, chunked
 * and projected) and says which, per document, with the stored copy beside it.
 *
 * ## What it prevents
 *
 * The closure lived inside `writeArrivals` (`sync/arrivals.ts`) and the tombstone apply needed it a second time. Written out again it drops the half that
 * matters: a duplicate key read as a FAILURE fails the whole page, so one stale tombstone holds every family's mark (the minimum of `through`) for ever,
 * and one read as "landed" loses the divergent copy. The classification is one function of the stored and the planned version (`isNewerCopy`, the one
 * accept rule), so the two writers cannot disagree about it. What each does with an answer is its own: records fork a divergence, tombstones count
 * `already_newer`.
 */
import { readStoredById, type ReadFields } from '../db/read-by-id.js';
import { isNewerCopy } from './upsert-plan.js';

/** How the stored copy stands to the planned version: the same version, a newer one, or neither (another index collided, or the copy is gone). */
export type StoredCopy = 'same-version' | 'newer' | 'other';

/** One duplicate, read back: the planned document, what is stored under its id, and how they stand. */
export interface ReadBack<D, H> {
  readonly planned: D;
  readonly held: H | undefined;
  readonly relation: StoredCopy;
}

/** How a stored version stands to a planned one — the rule the read-back applies, exposed for the caller that already holds both. */
export function relationOf(heldSeq: unknown, plannedSeq: number | undefined): StoredCopy {
  if (typeof heldSeq !== 'number') return 'other';
  if (heldSeq === plannedSeq) return 'same-version';
  return isNewerCopy(heldSeq, plannedSeq) ? 'newer' : 'other';
}

/**
 * Read the stored copies of `dupes` back and classify each against its planned version. `fields` is the projection the caller needs beside `seq` (a
 * fact's text, to tell a divergence from the same copy); `seq` is always read.
 */
export async function readBackDuplicates<D extends { _id: string; seq?: number | undefined }, H extends { seq?: number }>(
  collName: string, dupes: readonly D[], fields: Readonly<Record<string, 1>> = {},
): Promise<Array<ReadBack<D, H>>> {
  if (dupes.length === 0) return [];
  const read: ReadFields = { ...fields, seq: 1 };
  const held = await readStoredById<H>(collName, dupes.map(d => d._id), read);
  return dupes.map((planned) => {
    const stored = held.get(planned._id);
    return { planned, held: stored, relation: relationOf(stored?.seq, planned.seq) };
  });
}

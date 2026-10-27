/**
 * "Write one record of mine at the version I read, and if it moved meanwhile, read it again and write above it" — the one loop of a
 * local edit (bundle-81, design rev 8 §1a, decision 14).
 *
 * ## The question it answers
 *
 * A local edit reads the record's version, stamps its own above it, and writes. An arrival can land BETWEEN the stamp's read and the write,
 * and arrivals no longer lift the counter, so a write that was filtered by `_id` alone replaced the arrival with a LOWER version and nothing
 * corrected it afterwards: a peer holding the arrival never took this copy as newer. So the write is filtered by the version the stamp read
 * (`writeFilterFor`, `brain/write-precondition.ts`), and this module is what happens on a miss:
 *
 *  - **without `If-Match`**: re-read, re-stamp and write again, at most {@link MAX_ATTEMPTS} times; the last miss is the route's existing
 *    refusal (`null`). Each retry is counted `ythril_brain_write_seq_total{outcome="collision"}`;
 *  - **with `If-Match`**: a miss is that refusal at once, as it has always been — the caller asked for exactly one version;
 *  - **a record that is not there** is not retried: re-reading it finds nothing, and the answer is the route's 404.
 *
 * ## What it prevents, and what is inside so no caller drops it
 *
 * The stamp, the landing hold and the write are one attempt: a caller that stamped once and retried only the write would write a version it
 * had not re-read. The ceiling refusal (`RecordVersionAtCeiling`) comes from the stamp, before anything is written, on the first attempt and
 * on every retry. `write` is handed the landing patch (`{ seq, pos, posAtSeq, writtenHere }`) and the version it read, and returns what its
 * write returned or `null` for "matched nothing".
 */
import { versionsFor, type VersionAllocation } from '../util/version-stamp.js';
import { withLandingStamp, localRow, type LocalLanding } from '../sync/record-position-stream.js';
import { countBrainWriteSeq } from '../metrics/brain-write-count.js';
import type { BrainCollection } from '../config/types.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { refuseForkEdit } from './forks.js';

/** How many times an edit without `If-Match` tries before it answers the precondition refusal. */
export const MAX_ATTEMPTS = 3;

/** What one attempt writes with: the version it read (the write's filter names it) and the landing patch to set. */
export interface AtReadVersion extends VersionAllocation {
  readonly patch: LocalLanding;
}

/**
 * Run `write` at the version this record has now, and again at the version it has then when it moved and the caller sent no `If-Match`.
 * `holder` names who holds the position hold (one word: `fact.update`).
 */
export async function writeAtReadVersion<T>(
  spaceId: string, part: BrainCollection, id: string, ifMatchSeq: number | undefined,
  write: (at: AtReadVersion) => Promise<T | null>, holder: string,
  /** A version of ANOTHER record the new one must also be above (Review's fork resolve: the parent is stamped above both versions). */
  above?: number,
): Promise<T | null> {
  // The stored copy's version AND whether it is a fork (Q-624 §8): `forkOf` is in the projection, or the refusal is handed a row that never says it is
  // one and passes everything. A fork row changes only by resolve, delete, arrival or re-mint, so an ordinary edit of one is refused before it writes.
  const held = await col<{ _id: string; seq?: number; forkOf?: string }>(spaceCollection(spaceId, part))
    .findOne(asFilter<{ _id: string }>({ _id: id }), { projection: { seq: 1, forkOf: 1 } });
  refuseForkEdit(part, held);
  for (let attempt = 1; ; attempt++) {
    const [stamp] = await versionsFor(spaceId, [id], { parts: [part], ...(above !== undefined ? { known: new Map([[id, above]]) } : {}) });
    const at = stamp!;
    const done = await withLandingStamp(spaceId, [localRow(at.version)], ([patch]) => write({ ...at, patch: patch! }), holder);
    if (done !== null) return done;
    if (ifMatchSeq !== undefined || !at.exists || attempt >= MAX_ATTEMPTS) return null;
    countBrainWriteSeq(part, 'collision');
  }
}

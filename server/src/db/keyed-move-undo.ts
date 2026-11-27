/**
 * The call that puts back a move of keyed documents (`_id` from → to, copy then delete), computed from what stood there BEFORE the move (Q-978).
 *
 * ## What it prevents
 *
 * A rename that was refused moves its steps back. The first back of the counter, the change-feed floor, the scan cursors and the usage
 * history was the same move run the other way, so it undid what the step's NAME said and not what the step did: it took the document a
 * deleted space left under the new id (a counter is kept on purpose, so the id continues above every version it handed out), and a step
 * that wrote its copy and then failed before the delete left the document under both ids with nothing to undo it.
 *
 * ## The guard a hand-written copy drops
 *
 * **Read before the move, put back from what was read.** Called before the move runs, it keeps the document at `from` and whatever stood at
 * `to`. The call it returns writes the `from` document back and restores `to` to what it was (the document, or no document), so a move that
 * never ran, one that ran half-way and one that finished are all put right by the same call. A key with no document at `from` is not a pair
 * to undo: that move takes nothing, so nothing at `to` is touched.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Collection, Document } from 'mongodb';
import { asFilter, asDoc } from './mongo.js';

export async function snapshotKeyedMove<T extends Document>(
  coll: Collection<T>, pairs: ReadonlyArray<readonly [from: string, to: string]>, afterRestore?: () => void,
  /**
   * For a document something else keeps writing to (a counter that is incremented, a usage bucket): what to put back at `from` when a document stands
   * there at the put-back that is not the one read before the move, given that document and the one read before. Without it the document read before
   * the move is put back as it was, and what was written to `from` meanwhile is lost (Q-978). A document that stands there unchanged is put back as it was.
   */
  merge?: (current: T, before: T) => T,
): Promise<() => Promise<void>> {
  const rows: Array<{ from: string; to: string; fromDoc: T; toDoc: T | null }> = [];
  for (const [from, to] of pairs) {
    const fromDoc = await coll.findOne(asFilter<T>({ _id: from })) as T | null;
    if (!fromDoc) continue;
    rows.push({ from, to, fromDoc, toDoc: await coll.findOne(asFilter<T>({ _id: to })) as T | null });
  }
  return async () => {
    // The documents at `from` first: a failure between the two loops leaves the space whole at `from` and a copy at `to`, which the retry moves again.
    for (const r of rows) {
      const current = merge ? await coll.findOne(asFilter<T>({ _id: r.from })) as T | null : null;
      const put = current && merge && !isDeepStrictEqual(current, r.fromDoc) ? merge(current, r.fromDoc) : r.fromDoc;
      await coll.replaceOne(asFilter<T>({ _id: r.from }), asDoc<T>(put), { upsert: true });
    }
    for (const r of rows) {
      if (r.toDoc) await coll.replaceOne(asFilter<T>({ _id: r.to }), asDoc<T>(r.toDoc), { upsert: true });
      else await coll.deleteOne(asFilter<T>({ _id: r.to }));
    }
    afterRestore?.();
  };
}

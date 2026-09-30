/**
 * Does this collection of a space hold at least one record right now?
 *
 * The question a search index's existence now follows (Q-165): an index is built on a collection's first record
 * and dropped when its last one goes. Asked by the lifecycle that makes it so, by the readiness wait that must
 * not wait for an index nobody will build, and by the index status an operator reads — three callers, and the
 * spelling they need to share is the one that is cheap AND exact.
 *
 * `findOne` with an `_id` projection, not `estimatedDocumentCount`: the estimate is read from collection
 * metadata, and after an unclean shutdown it can say zero about a collection that holds records. An index
 * dropped on that answer would leave those records unsearchable, which is the one outcome this lifecycle must
 * never produce. The exact answer costs one index-walk step.
 */
import { col } from '../db/mongo.js';

export async function collectionHoldsRecord(collectionName: string): Promise<boolean> {
  const one = await col(collectionName).findOne({}, { projection: { _id: 1 } });
  return one !== null;
}

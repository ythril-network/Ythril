/**
 * Ensure a TTL index — MongoDB deletes a document once its `field` (a BSON Date) is `expireAfterSeconds` past.
 *
 * ## Why a module
 *
 * Four collections needed one — the audit log, webhook deliveries, per-space activity and the read-spill store —
 * and each wrote `createIndex` by hand. Three remembered the forgettable half and one did not:
 *
 * - **`createIndex` REFUSES a changed option.** An index that already exists on the same key with another
 *   lifetime makes the call throw, so without a fallback a changed retention is never applied — the old
 *   lifetime stays for ever, and nothing says so. The fallback is `collMod`, keyed by the KEY PATTERN, so it
 *   finds the index whatever it was named (an index made by hand, or by an older version under another name).
 * - **A failure is logged naming the collection**, never swallowed: a missing TTL index is invisible until the
 *   collection is the largest in the instance.
 *
 * Not `brain/ttl.ts` `ensureTtlIndex`: that one indexes the per-space `_expireAt` fields the TTL SWEEP queries,
 * with no `expireAfterSeconds`, because those records are deleted through the normal delete path and never by
 * MongoDB. A different question.
 */
import { getDb } from './mongo.js';
import { log, peerText } from '../util/log.js';
import { messageOf } from '../util/errors.js';

export async function ensureExpiryIndex(
  collection: string,
  field: string,
  expireAfterSeconds: number,
  /** Kept for the indexes that already carry one; a new caller may omit it. */
  name?: string,
): Promise<void> {
  const db = getDb();
  try {
    await db.collection(collection).createIndex({ [field]: 1 }, { expireAfterSeconds, ...(name ? { name } : {}) });
  } catch {
    try {
      await db.command({ collMod: collection, index: { keyPattern: { [field]: 1 }, expireAfterSeconds } });
    } catch (err) {
      log.warn(`Could not ensure the TTL index on ${peerText(collection)}.${peerText(field)}: ${peerText(messageOf(err))}`);
    }
  }
}

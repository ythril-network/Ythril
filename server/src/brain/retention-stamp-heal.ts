/**
 * The heal of retention stamps already stored as anything but a Date (bundle-40, Q-223).
 *
 * ## What it prevents
 *
 * An import before 5.6.2 stored a restored stamp as it came: text the import could not read, an EJSON `{"$date": ...}` object, a number, a boolean.
 * A stored stamp that is not a BSON Date never matches the sweep's `{ _expireAt: { $lte: now } }`, so the record is skipped by every sweep for
 * ever and the window the operator set never reaches it. Fixing the import (`retentionStampOf`, `brain/retention-stamp.ts`) does not reach the rows
 * already stored. `_expireAt` and `_contentExpireAt` are local-only fields (never replicated), so a pass of the sweep may repair them in place, with no
 * marker and no boot migration: what is left to do is a QUERY (a stamp that is not a Date), and healing a row takes it out of the query.
 *
 * ## The rule, one row at a time
 *
 * - a stamp {@link retentionStampOf} accepts (a Date, or text with an explicit zone and real components) becomes the Date it names;
 * - anything else is restamped the way D-9 stamps an arrival with no stamp of its own (`retentionStamps`): from the record's OWN `createdAt` by this
 *   instance's `schema > space` window. Never bare-unset where a window applies: a bare unset would make a record the operator meant to expire
 *   immortal. Where no window applies (no policy, or no readable `createdAt` to count from) the junk stamp is unset, which is what an unstamped record is;
 * - the write is **guarded on the stamp that was read** (`$eq`: a bare equality filter would read an EJSON `{"$date": ...}` stamp as an operator
 *   and fail), so a Date a local write gave the record between the read and the write wins;
 * - a stamp healed to an instant already past is deleted by the following cycle's expiry pass, through the normal delete.
 *
 * ## Cost
 *
 * One bounded page ({@link STAMP_HEAL_PAGE}) per space, collection and field per cycle, served by the sparse TTL index where the space has it. A
 * collection whose pass found nothing is not asked again until something that can store a non-Date stamp has run: the latch
 * ({@link resetStampHealLatch}), set by an empty pass and reset by an import. A peer's arrival never carries a stamp and a local write stamps a Date,
 * so an import is the only door left.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { assertSpaceTakesWrites, isSpaceNotWritable } from '../spaces/space-write-gate.js';
import { RECORD_TYPE_OF } from '../sync/replicated-families.js';
import { retentionStampOf } from './retention-stamp.js';
import { retentionSpace, retentionStamps, type BrainCollection } from './ttl.js';

/** The most stamps one pass reads, and so heals, per space, collection and field per cycle. */
export const STAMP_HEAL_PAGE = 500;

/** The stamps that replicate nowhere and name a deadline. */
export type StampField = '_expireAt' | '_contentExpireAt';

/** Per space, the passes (`collection|field`) that found nothing to heal. Process-lifetime: a restart asks once more. */
const clean = new Map<string, Set<string>>();

const passKey = (collection: string, field: StampField): string => `${collection}|${field}`;

/**
 * Forget what the heal found clean in this space: something that can store a stamp of any shape ran (an import).
 * Called by every import into the space, after its records have landed.
 */
export function resetStampHealLatch(spaceId: string): void {
  clean.delete(spaceId);
}

/**
 * Heal one page of the stamps of one field in one collection of a space.
 *
 * @returns how many stamps it rewrote (a row a concurrent write got to first is not counted)
 */
export async function healStoredStamps(spaceId: string, collection: BrainCollection, field: StampField): Promise<number> {
  const bucket = RECORD_TYPE_OF[collection];
  if (bucket === null) return 0; // links carry no stamp
  const key = passKey(collection, field);
  if (clean.get(spaceId)?.has(key)) return 0;
  // Housekeeping: a space an act is emptying has nothing worth healing, and the sweep must not count it a failure. Not latched: it was not asked.
  try { assertSpaceTakesWrites(spaceId, collection); } catch (err) { if (isSpaceNotWritable(err)) return 0; throw err; }

  const name = `${spaceId}_${collection}`;
  const page = await col(name).find(
    // Every stored stamp that is not a Date, whatever its shape; the type test is what the sparse TTL index serves.
    asFilter({ [field]: { $exists: true, $not: { $type: 'date' } } }),
    { projection: { _id: 1, [field]: 1, createdAt: 1, type: 1, label: 1 }, limit: STAMP_HEAL_PAGE },
  ).toArray() as unknown as Array<Record<string, unknown> & { _id: string }>;

  if (page.length === 0) {
    let passes = clean.get(spaceId);
    if (!passes) clean.set(spaceId, passes = new Set());
    passes.add(key);
    return 0;
  }

  const space = retentionSpace(spaceId);
  let healed = 0;
  for (const row of page) {
    const read = row[field];
    // The stamp's own instant where it names one; else this instance's window counted from the record's own creation.
    const to = retentionStampOf(read) ?? (space ? retentionStamps(space, bucket, row)[field] : undefined);
    const r = await col(name).updateOne(
      asFilter({ _id: row._id, [field]: { $eq: read } }),
      asUpdate(to ? { $set: { [field]: to } } : { $unset: { [field]: '' } }),
    );
    if (r.modifiedCount > 0) healed++;
  }
  return healed;
}

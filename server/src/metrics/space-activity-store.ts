/**
 * Persisting per-space activity: the half that makes it affordable.
 *
 * The counters in `space-activity.ts` live in memory and cost ~19 ns per request. What could have made this
 * feature expensive is writing them down, and the shape here is chosen so it does not:
 *
 *   - **One `bulkWrite` of `$inc`s per flush**, not per call. The write cost is a function of how many spaces
 *     were touched, never of how many times — one upsert per active space per interval whether that space
 *     served ten calls or a hundred thousand.
 *   - **`$inc`, not read-modify-write.** Two instances against one database, or a flush overlapping the next,
 *     add rather than clobber. There is no read at all on the write path.
 *   - **A derivable `_id`** (`<space>:<hour>`), so an upsert needs no lookup to find its document.
 *
 * ## Why hourly documents rather than a rolling total
 *
 * A single total per space cannot answer "is this space still being used" — the number a space earned last
 * quarter is indistinguishable from one it earned this morning. Hourly buckets sum into any window an operator
 * chooses, which is what "tell the spaces apart" actually needs, and they age out cleanly.
 *
 * ## Losing a flush
 *
 * `drainSpaceActivity()` clears as it reads, so a failed flush loses under a minute of counts. That is
 * deliberate: merging them back risks double-counting on a partially-applied `bulkWrite`, and for a usefulness
 * gauge "occasionally a minute short" is far better than "sometimes overstated". A dropped batch logs a warning
 * with what it was carrying.
 */
import { col, asFilter } from '../db/mongo.js';
import { log } from '../util/log.js';
import { drainSpaceActivity, hourBucket, activityDocId, type CallClass } from './space-activity.js';

/** The collection is instance-wide, not per space: comparing spaces means reading them together. */
export const ACTIVITY_COLLECTION = 'space_activity';

/** How long buckets are kept. 90 days answers "this quarter" and bounds the collection at (spaces × 2160). */
export const ACTIVITY_RETENTION_DAYS = 90;

/** Flush cadence. Long enough that the write cost is negligible, short enough that a crash loses little. */
export const ACTIVITY_FLUSH_INTERVAL_MS = 60_000;

export interface ActivityDoc {
  _id: string;
  space: string;
  /** `2026-08-01T14` — the UTC hour, kept as a string so it is greppable and sorts lexically. */
  bucket: string;
  /** BSON date for the TTL index. Set on insert only, so a bucket's expiry is fixed at its first write. */
  bucketAt: Date;
  /** Per class: `{ n, answered, sumTopScore, sumMs, maxMs, over1s }`. */
  calls: Partial<Record<CallClass, {
    n: number; answered: number; sumTopScore: number; sumMs: number; maxMs: number; over1s: number;
  }>>;
  /** Last time anything touched this space. The cheapest useful signal there is. */
  lastUsedAt: Date;
}

/**
 * Create the indexes this collection needs. Idempotent, so it runs on every boot.
 *
 * Two, for the two questions asked of it: one space's recent buckets (the Overview), and every space's recent
 * buckets (the comparison). The TTL index is what stops an activity log becoming the largest collection in the
 * instance — the failure mode of every metrics table that was added without one.
 */
export async function ensureActivityIndexes(): Promise<void> {
  const c = col<ActivityDoc>(ACTIVITY_COLLECTION);
  await c.createIndex({ space: 1, bucket: -1 });
  await c.createIndex({ bucket: -1 });
  await c.createIndex({ bucketAt: 1 }, {
    name: 'ttl_bucketAt',
    expireAfterSeconds: ACTIVITY_RETENTION_DAYS * 24 * 60 * 60,
  });
}

/**
 * Write everything accumulated since the last flush. Returns how many space-hours were touched.
 *
 * `maxMs` uses `$max` rather than `$inc` — a maximum is not additive, and summing them would produce a number
 * no request ever took.
 */
export async function flushSpaceActivity(now = Date.now()): Promise<number> {
  const rows = drainSpaceActivity();
  if (rows.length === 0) return 0;

  const bucket = hourBucket(now);
  const bucketAt = new Date(new Date(now).toISOString().slice(0, 13) + ':00:00.000Z');
  const bySpace = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySpace.get(r.space) ?? [];
    list.push(r);
    bySpace.set(r.space, list);
  }

  const ops = [...bySpace].map(([space, spaceRows]) => {
    const inc: Record<string, number> = {};
    const max: Record<string, number> = {};
    for (const { cls, totals } of spaceRows) {
      inc[`calls.${cls}.n`] = totals.n;
      inc[`calls.${cls}.answered`] = totals.answered;
      inc[`calls.${cls}.sumTopScore`] = totals.sumTopScore;
      inc[`calls.${cls}.sumMs`] = totals.sumMs;
      inc[`calls.${cls}.over1s`] = totals.over1s;
      max[`calls.${cls}.maxMs`] = totals.maxMs;
    }
    return {
      updateOne: {
        filter: { _id: activityDocId(space, bucket) },
        update: {
          $inc: inc,
          $max: max,
          $set: { lastUsedAt: new Date(now) },
          // `$setOnInsert` for the identity fields: they never change for a bucket, and re-setting `bucketAt`
          // on every flush would push the TTL expiry forward for as long as the space stays busy — a bucket
          // that never ages out.
          $setOnInsert: { space, bucket, bucketAt },
        },
        upsert: true,
      },
    };
  });

  try {
    await col<ActivityDoc>(ACTIVITY_COLLECTION).bulkWrite(ops as any, { ordered: false });
    return ops.length;
  } catch (err) {
    // The counts are already drained, so they are gone. Say what was lost rather than failing a timer.
    const calls = rows.reduce((sum, r) => sum + r.totals.n, 0);
    log.warn(`Space activity: dropped a flush of ${calls} call(s) across ${ops.length} space(s): `
      + `${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic flush. Unref'd, so it never holds the process open — a pending activity write must not
 * be the reason a container takes longer to exit.
 */
export function startSpaceActivityFlush(intervalMs = ACTIVITY_FLUSH_INTERVAL_MS): void {
  if (_timer) return;
  _timer = setInterval(() => { void flushSpaceActivity(); }, intervalMs);
  _timer.unref();
}

/** Stop the timer and write what is pending — call from the shutdown path so the last minute is not lost. */
export async function stopSpaceActivityFlush(): Promise<void> {
  if (_timer) { clearInterval(_timer); _timer = null; }
  await flushSpaceActivity();
}

/**
 * Forget a space's usage. Called when the space is deleted or wiped.
 *
 * `space_activity` is instance-wide, so the prefix drop in `dropSpaceData` — which removes every
 * `<spaceId>_*` collection — cannot reach it. Without this the rows outlive the space for up to the
 * retention window, and a space recreated with the same id inherits usage it never served: a fresh space
 * whose Usage panel claims hundreds of recalls, which is worse than showing nothing.
 */
export async function purgeSpaceActivity(spaceId: string): Promise<number> {
  const res = await col<ActivityDoc>(ACTIVITY_COLLECTION).deleteMany(
    asFilter<ActivityDoc>({ space: spaceId }),
  );
  return res.deletedCount ?? 0;
}

/**
 * Carry a space's usage across a rename.
 *
 * A rename preserves the space and its data, so its history should follow — losing it would make every
 * rename look like a space that had never been used. The bucket `_id` embeds the space id, so the rows
 * cannot be updated in place: each is re-inserted under the new key and the old one removed, in one
 * `bulkWrite`. Bounded by the retention window (at most 24 x retention days of rows for one space).
 *
 * `ordered: false` so one collision — a target row that somehow already exists — does not abandon the rest.
 */
export async function renameSpaceActivity(fromId: string, toId: string): Promise<number> {
  if (fromId === toId) return 0;
  const c = col<ActivityDoc>(ACTIVITY_COLLECTION);
  const rows = await c.find(asFilter<ActivityDoc>({ space: fromId })).toArray() as ActivityDoc[];
  if (rows.length === 0) return 0;

  const ops = rows.flatMap(row => [
    { insertOne: { document: { ...row, _id: activityDocId(toId, row.bucket), space: toId } } },
    { deleteOne: { filter: { _id: row._id } } },
  ]);
  await c.bulkWrite(ops as any, { ordered: false });
  return rows.length;
}
export interface SpaceActivitySummary {
  space: string;
  calls: number;
  recall: number;
  /** Recall calls that came back with something. The discriminator: demand without this is not usefulness. */
  answered: number;
  writes: number;
  meanMs: number | null;
  maxMs: number;
  over1s: number;
  /** Mean top score across answered recalls, or null when nothing was answered. */
  meanTopScore: number | null;
  lastUsedAt: string | null;
}

/**
 * Summarise a window for every space, newest bucket first.
 *
 * Summed in the database rather than in the caller: the buckets for 65 spaces over 7 days are 10 920 documents,
 * and shipping those to Node to add them up would make the Overview slower than the thing it measures.
 */
export async function summariseActivity(
  sinceHoursAgo = 24,
  now = Date.now(),
  /**
   * Restrict to one space.
   *
   * Not a convenience: a space-scoped token asking for its own Overview must not learn how heavily every
   * OTHER space is used. Filtering in the `$match` rather than in the caller means the rows never leave the
   * database, so there is nothing to leak by forgetting a filter later.
   */
  space?: string,
): Promise<SpaceActivitySummary[]> {
  const from = hourBucket(now - sinceHoursAgo * 3_600_000);
  const rows = await col<ActivityDoc>(ACTIVITY_COLLECTION).aggregate([
    {
      $match: asFilter<ActivityDoc>({
        bucket: { $gte: from } as unknown as string,
        ...(space ? { space } : {}),
      }),
    },
    {
      $group: {
        _id: '$space',
        recall: { $sum: { $ifNull: ['$calls.recall.n', 0] } },
        answered: { $sum: { $ifNull: ['$calls.recall.answered', 0] } },
        sumTopScore: { $sum: { $ifNull: ['$calls.recall.sumTopScore', 0] } },
        writes: { $sum: { $ifNull: ['$calls.write.n', 0] } },
        reads: { $sum: { $ifNull: ['$calls.read.n', 0] } },
        files: { $sum: { $ifNull: ['$calls.file.n', 0] } },
        sumMs: {
          $sum: {
            $add: [
              { $ifNull: ['$calls.recall.sumMs', 0] }, { $ifNull: ['$calls.read.sumMs', 0] },
              { $ifNull: ['$calls.write.sumMs', 0] }, { $ifNull: ['$calls.file.sumMs', 0] },
            ],
          },
        },
        over1s: {
          $sum: {
            $add: [
              { $ifNull: ['$calls.recall.over1s', 0] }, { $ifNull: ['$calls.read.over1s', 0] },
              { $ifNull: ['$calls.write.over1s', 0] }, { $ifNull: ['$calls.file.over1s', 0] },
            ],
          },
        },
        maxMs: {
          $max: {
            $max: [
              { $ifNull: ['$calls.recall.maxMs', 0] }, { $ifNull: ['$calls.read.maxMs', 0] },
              { $ifNull: ['$calls.write.maxMs', 0] }, { $ifNull: ['$calls.file.maxMs', 0] },
            ],
          },
        },
        lastUsedAt: { $max: '$lastUsedAt' },
      },
    },
  ]).toArray() as Array<Record<string, number | string | Date | null> & { _id: string }>;

  return rows.map(r => {
    const calls = Number(r['recall'] ?? 0) + Number(r['reads'] ?? 0) + Number(r['writes'] ?? 0)
      + Number(r['files'] ?? 0);
    const answered = Number(r['answered'] ?? 0);
    return {
      space: r._id,
      calls,
      recall: Number(r['recall'] ?? 0),
      answered,
      writes: Number(r['writes'] ?? 0),
      // Guarded: a window with buckets but no calls would otherwise divide by zero and report NaN, which
      // serialises to null in JSON and reads in the UI as "no data" rather than "no calls".
      meanMs: calls > 0 ? Math.round(Number(r['sumMs'] ?? 0) / calls) : null,
      maxMs: Number(r['maxMs'] ?? 0),
      over1s: Number(r['over1s'] ?? 0),
      meanTopScore: answered > 0 ? Number((Number(r['sumTopScore'] ?? 0) / answered).toFixed(3)) : null,
      lastUsedAt: r['lastUsedAt'] ? new Date(r['lastUsedAt'] as Date).toISOString() : null,
    };
  }).sort((a, b) => b.calls - a.calls);
}

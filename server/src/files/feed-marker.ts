/**
 * The FEED MARKER: what a deleted file leaves at its path where soft delete is off, so the client file change feed can say "deleted" (bundle-255, Q-724).
 *
 * ## The question it answers
 *
 * "What does a file's path hold after the file is gone, when this instance keeps no audit record?" Exactly
 * `{ _id, spaceId, path, deletedAt, feedMarker: true, pos, posAtSeq }`: the path, when, and the position the deletion took. Nothing a person wrote
 * (tags, description, properties, author) and nothing the bytes made (hash, size, vector) outlives the delete in it (vet-privacy). It carries `deletedAt`,
 * so every live-row read (`LIVE_FILE_ROW`, `NOT_A_FLAGGED_ROW`) already leaves it out, and it carries no `seq`, so it is on no wire and the position repair
 * (which reads rows by `seq`) never touches it.
 *
 * ## Its life
 *
 * Written by the retirement of a file row (`retireFileMetaMany`/`retireFileMetaUnder`, soft delete off), a move's source and a legacy re-key's old
 * spelling; replaced by any write to the path (it is treated as absent: the new file starts clean); purged by the TTL sweep once older than the feed
 * window ({@link feedWindowDays}, config `fileChangeFeedWindowDays`, default 30 days, minimum 0), the floor raised first (`files/file-feed-floor.ts`).
 * Retention is by KIND, stored on the row: a feed marker is purged by the feed window whatever the soft-delete setting is now; an audit row (soft delete
 * on) by the Files window, as before.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { getConfig } from '../config/loader.js';
import { raiseFileFeedFloorOver } from './file-feed-floor.js';
import { RETIRED_BY } from '../sync/local-only-fields.js';

/** The feed window's default, in days: how long a feed marker is kept before the sweep purges it. */
export const DEFAULT_FILE_CHANGE_FEED_WINDOW_DAYS = 30;

/** The predicate of a feed marker, for a filter. Frozen. */
export const FEED_MARKER = Object.freeze({ feedMarker: true as const });

/** The marker a deletion leaves at `id`: the path, the deletion time, the position it took (`landing`), and nothing else. */
export function feedMarkerRow(
  spaceId: string, id: string, landing: { readonly pos: number; readonly posAtSeq: number }, deletedAt: string = new Date().toISOString(),
): { _id: string; spaceId: string; path: string; deletedAt: string; feedMarker: true; pos: number; posAtSeq: number } {
  return { _id: id, spaceId, path: id, deletedAt, feedMarker: true, pos: landing.pos, posAtSeq: landing.posAtSeq };
}

/**
 * The update PIPELINE that turns a live row into its feed marker in one write: the row is replaced by {@link feedMarkerRow}'s shape, `posAtSeq` read from
 * the row's own `seq` inside the write (0 for a row with none), so an edit between the read and the write cannot leave a position taken for another version.
 */
export function feedMarkerStages(spaceId: string, pos: number, deletedAt: string, retiredBy?: RetiredBy): object[] {
  return [{
    $replaceWith: {
      _id: '$_id', spaceId: { $literal: spaceId }, path: '$_id', deletedAt: { $literal: deletedAt }, feedMarker: true,
      pos: { $literal: pos }, posAtSeq: { $ifNull: ['$seq', 0] },
      ...(retiredBy !== undefined ? { [RETIRED_BY]: { $literal: retiredBy } } : {}),
    },
  }];
}

/**
 * Why a row was retired, when it was not a person's delete: `'bytes-lost'` is the absent-bytes sweep (`files/absent-bytes-sweep.ts`, Q-337),
 * which took the record of a file whose bytes this disk lost. Carried on the feed marker (or the soft-delete flag) so the change feed can say
 * `reason: 'bytes_lost'` and a client mirroring the space keeps its own copy. A retirement with no reason is a delete.
 */
export type RetiredBy = 'bytes-lost';

declare module '../config/types.js' {
  interface FileMetaDoc {
    /**
     * LOCAL, on a RETIRED row only (a feed marker or a soft-delete flag): why this instance retired it when no person did ({@link RetiredBy}).
     * Spelled `RETIRED_BY` (`sync/local-only-fields.ts`); every writer that makes a row live again clears it. Declared here, beside the type it
     * holds, rather than in the frozen `types.ts`.
     */
    retiredBy?: RetiredBy;
  }
}

/** Whether a stored row is a feed marker. */
export const isFeedMarker = (row: { feedMarker?: unknown } | null | undefined): boolean => row?.feedMarker === true;

/**
 * The feed window in days (`fileChangeFeedWindowDays`): a whole number of 0 or more, the default when unset or not one. 0 purges every feed marker at the
 * next sweep, so every cursor from before it re-lists.
 */
export function feedWindowDays(): number {
  const v = (getConfig() as { fileChangeFeedWindowDays?: unknown }).fileChangeFeedWindowDays;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_FILE_CHANGE_FEED_WINDOW_DAYS;
}

/** The most feed markers one purge batch removes (one read, one floor raise, one `deleteMany`). */
export const FEED_MARKER_PURGE_BATCH = 1000;
/** The most batches one sweep cycle runs per space: a folder delete of `FEED_MARKER_PURGE_BATCH * FEED_MARKER_PURGE_BATCHES` files is purged in one cycle. */
export const FEED_MARKER_PURGE_BATCHES = 50;

/**
 * Purge the space's feed markers older than the feed window, a batch at a time: each batch reads `{ _id, pos }`, raises the floor to its highest position,
 * THEN removes exactly those rows while they are still markers (a write to the path meanwhile replaced it with a live row, which stays). Answers how many
 * it removed.
 */
export async function purgeFeedMarkers(spaceId: string, now: Date): Promise<number> {
  const due = new Date(now.getTime() - feedWindowDays() * 86_400_000).toISOString();
  const coll = col<{ _id: string; pos?: number }>(spaceCollection(spaceId, 'files'));
  let removed = 0;
  for (let batch = 0; batch < FEED_MARKER_PURGE_BATCHES; batch += 1) {
    const rows = await coll.find(asFilter<{ _id: string }>({ ...FEED_MARKER, deletedAt: { $lte: due } }), { projection: { _id: 1, pos: 1 }, limit: FEED_MARKER_PURGE_BATCH })
      .toArray();
    if (rows.length === 0) break;
    await raiseFileFeedFloorOver(spaceId, rows);
    const r = await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: rows.map(x => x._id) }, ...FEED_MARKER }));
    removed += r.deletedCount ?? 0;
    if (rows.length < FEED_MARKER_PURGE_BATCH) break;
  }
  return removed;
}

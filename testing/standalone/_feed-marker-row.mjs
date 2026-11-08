/**
 * Is this stored file row a FEED MARKER, the row a deletion leaves at a file's path where soft delete is off (bundle-255, Q-724)? Answered once for
 * every test that reads what a delete, a move or a peer's tombstone left behind.
 *
 * ## What it prevents
 *
 * Since bundle-255 a file that goes leaves `{ _id, spaceId, path, deletedAt, feedMarker, pos, posAtSeq }` at its path (`server/src/files/feed-marker.ts`)
 * so the client change feed can say "deleted". A test that asks "is the row gone?" with `findOne(...) === null` then reads that marker as "the file is
 * still there"; a test that accepts any row with `feedMarker: true` reads a LIVE row someone tagged with the key as a deletion. The strict check below
 * takes a marker only when it carries exactly the marker's keys and nothing a person wrote or the bytes made.
 *
 * A case about soft delete ON (an audit row, flagged with `deletedAt`) does not use this: that row is a flagged file row, not a marker.
 */

/** The keys a feed marker carries, sorted: nothing else (no author, tags, hash, size or vector) outlives the delete in it. */
export const FEED_MARKER_KEYS = Object.freeze(['_id', 'deletedAt', 'feedMarker', 'path', 'pos', 'posAtSeq', 'spaceId']);

/** The Mongo filter for "not a feed marker": a live row, a flagged audit row or a derived row, never what a delete left. Frozen. */
export const NOT_A_FEED_MARKER = Object.freeze({ feedMarker: Object.freeze({ $exists: false }) });

/** The Mongo filter for "a feed marker". Frozen. */
export const A_FEED_MARKER = Object.freeze({ feedMarker: true });

/** True only for a whole stored row that is exactly a feed marker: `feedMarker === true` and exactly {@link FEED_MARKER_KEYS}. */
export function isFeedMarkerRow(row) {
  if (row === null || typeof row !== 'object' || row.feedMarker !== true) return false;
  const keys = Object.keys(row).sort();
  return keys.length === FEED_MARKER_KEYS.length && keys.every((k, i) => k === FEED_MARKER_KEYS[i]);
}

/**
 * True for a row read through a PROJECTION that kept `feedMarker`: the key alone says it, since the projection dropped the rest. Use
 * {@link isFeedMarkerRow} for a whole row.
 */
export function carriesFeedMarker(row) {
  return row !== null && typeof row === 'object' && row.feedMarker === true;
}

/** "The file is gone from this path": nothing is stored there, or only its feed marker. */
export function goneOrMarker(row) {
  return row === null || row === undefined || isFeedMarkerRow(row);
}

/**
 * Which stored rows of a space's `files` collection are LIVE FILES — the one filter that answers "is this row a file the
 * space has".
 *
 * ## What it prevents
 *
 * A `files` row is not always a file. It is also a chunk or a face record derived from one (`parentFileId`), and, with
 * `softDeleteFileMeta` on, the audit record a deleted file leaves (`deletedAt`, local state that is never offered to a peer
 * and never hashed: bundle-48, `Q-257`). Every question about the space's files — a listing, a delete's "is there anything
 * left", what a peer is offered, what the space hash covers — has to leave both out, and the question was spelled out at
 * each site in its own words: the listing and the live-record reads asked it whole, the push and the hash asked for parents
 * only, so a flagged row was pushed stripped of its flag (it landed LIVE on the peer and removed the tombstone the peer held
 * for the file) and hashed on one instance and not on the next. A site that spells `deletedAt: { $exists: false }` itself
 * is the next one to forget the half beside it.
 *
 * ## The rule
 *
 * A live file row has no `parentFileId` and no `deletedAt`. Spread it into a filter (`{ ...LIVE_FILE_ROW, _id }`); it is
 * frozen, so a caller cannot narrow it for everyone else. It answers only this question: where a site wants chunks or
 * flagged rows themselves (the sweep that removes a flagged file's chunks, the soft delete that flags the parents) it asks
 * for exactly that, and does not borrow this.
 */
export const LIVE_FILE_ROW = Object.freeze({
  parentFileId: Object.freeze({ $exists: false }),
  deletedAt: Object.freeze({ $exists: false }),
});

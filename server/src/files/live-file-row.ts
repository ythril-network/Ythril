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

/**
 * The OTHER question about a `files` row: is this row itself not the audit record of a deleted file — at ANY tier.
 *
 * ## Why it is separate from {@link LIVE_FILE_ROW} rather than a narrowing of it
 *
 * `LIVE_FILE_ROW` also demands `parentFileId` absent, which is right for "what files does this space have" and WRONG
 * everywhere a chunk, caption or face row is a legitimate subject. Spreading it into the embed path, the embed sweep or
 * recall's file branch would make every derived row unembeddable and invisible, because every one of them carries a
 * `parentFileId`. That is not a theoretical slip: three separate design reviews reached for `LIVE_FILE_ROW` at exactly
 * those sites before this constant existed.
 *
 * ## The limit, stated because it is the thing to get wrong
 *
 * This is ROW-LOCAL. A chunk, caption or face row NEVER carries `deletedAt` — the flag is written on the parent file row
 * alone — so this predicate on a chunk's own filter is vacuous: it matches, and says nothing about whether the file it
 * belongs to was deleted. A site that needs "is this row's FILE still here" has to read the parent, and must not reach for
 * this and believe it has asked.
 */
export const NOT_A_FLAGGED_ROW = Object.freeze({
  deletedAt: Object.freeze({ $exists: false }),
});

/**
 * The guard a read of a record of `kind` carries so a soft-deleted file's record is not found: {@link NOT_A_FLAGGED_ROW}
 * for a file, nothing for any other kind. `kind` is the record kind (`'file'`) or its collection suffix (`'files'`) —
 * both spellings reach the reads that ask, and a read that tested one while holding the other would silently skip the
 * guard. Spread it into a filter (`{ ...notFlaggedIfFile(kind) }`) or pass it where a filter is optional.
 *
 * The one place the choice is made: `a-kind-chooses-the-flagged-row-guard-in-one-place` refuses a read that compares a
 * kind with the file kind to pick the guard itself.
 */
export function notFlaggedIfFile(kind: string | undefined): typeof NOT_A_FLAGGED_ROW | undefined {
  return kind === 'file' || kind === 'files' ? NOT_A_FLAGGED_ROW : undefined;
}

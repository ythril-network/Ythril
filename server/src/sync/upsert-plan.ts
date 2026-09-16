/**
 * Deciding which pulled documents actually get written, and re-tagging them to the local space.
 *
 * Extracted from `sync/engine.ts` as slice 2 of the god-file split. Pure: no Mongo, no network. The
 * engine keeps the IO (the `find` for existing seqs, the `bulkWrite`); everything that decides is here,
 * because every mistake in this decision is silent and expensive.
 *
 * ── Last-writer-wins by `seq`, and why the comparison is strict ─────────────────────────────────
 *
 * Sync applies a pulled record as a whole-document replace. Which of two versions wins is decided by
 * `seq` alone, so this comparison IS the conflict resolution:
 *
 *   - **absent locally** → write it. This is the ordinary new-record path.
 *   - **incoming seq is HIGHER** → write it. The peer has a newer version.
 *   - **incoming seq is EQUAL** → do NOT write. Both sides already agree, and a re-sync must be a
 *     no-op. Loosening this to `>=` would make every cycle rewrite every document it has ever seen:
 *     the data would stay correct, so nothing would fail, while write volume grew with the size of
 *     the space rather than with what changed.
 *   - **incoming seq is LOWER** → do NOT write. A peer that is behind — restored from a backup, or
 *     offline through several local edits — must not roll newer local records backwards. This is the
 *     clause that makes the rule a data-loss guard rather than a bandwidth optimisation.
 *
 * ── Re-tagging is not cosmetic ──────────────────────────────────────────────────────────────────
 *
 * A peer's document carries ITS space id, and under `spaceMap` aliasing that is not ours — yet we
 * store it in OUR collection. Every read path filters on `spaceId` (`listEntities`,
 * `findEntityByName`, the edge-dedup lookup, cascade deletes), so leaving the remote id in place makes
 * a synced document invisible to list and lookup while still being counted. The data reads as lost,
 * and because `findEntityByName` stops matching, `saveFact` starts creating duplicates instead of
 * updating. The collection name is the only real scope: a document written into `{localSpaceId}_*`
 * belongs to `localSpaceId` by definition.
 */

/** The minimum shape this module needs: everything sync replicates carries an id and a seq. */
export interface Replicable {
  _id: string;
  seq: number;
}

/**
 * Stamp every document with the local space id, in place.
 *
 * In place because the caller writes these same objects straight to Mongo — copying would mean the
 * copy is tagged and the written original is not, which is the exact bug this prevents.
 */
export function retagToLocalSpace(docs: readonly unknown[], localSpaceId: string): void {
  for (const doc of docs) {
    (doc as { spaceId?: string }).spaceId = localSpaceId;
  }
}

/**
 * Which of `docs` should be written, given the seq each id currently has locally.
 *
 * An id missing from `existingSeq` means the document does not exist locally yet. Returns the subset
 * to replace, preserving input order; an empty result means the caller should skip the write entirely
 * rather than issue an empty bulkWrite.
 */
export function planSeqUpserts<T extends Replicable>(
  docs: readonly T[],
  existingSeq: ReadonlyMap<string, number>,
): T[] {
  const out: T[] = [];
  for (const doc of docs) {
    const prev = existingSeq.get(doc._id);
    if (prev === undefined || doc.seq > prev) out.push(doc);
  }
  return out;
}

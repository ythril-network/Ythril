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

import { createHash } from 'node:crypto';
import { idPart } from '../brain/edge-id.js';

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
    if (isNewerCopy(doc.seq, existingSeq.get(doc._id))) out.push(doc);
  }
  return out;
}

/**
 * Is a copy at seq `incoming` newer than one held at `held` — the ONE accept rule of the pull (`planSeqUpserts`),
 * the push doors (`pushVerdict` in `api/sync/docs.ts`, which every single route and batch family loop asks), the
 * arrival writer's collapse of a repeated id within one page, and its read-back of a guarded write. Strictly
 * greater, so an equal seq is NOT newer: across peers that makes a re-sync a no-op, and inside one page it means
 * the EARLIER of two equal copies stands — the push door's sequential reading, applied on pull and restore too.
 *
 * Nothing held is beaten by anything; a copy that has no seq (file metadata from before 4.0) beats nothing held
 * at a seq — but a held copy with no seq is overwritten by anything that arrives.
 */
export function isNewerCopy(incoming: number | undefined, held: number | undefined): boolean {
  if (held === undefined) return true;
  if (incoming === undefined) return false;
  return incoming > held;
}

/**
 * A fork's id, DERIVED from what it forks: the parent's id, the seq both copies share, and the diverging text.
 *
 * It was `uuidv4()`, so a push whose 200 was lost and is re-sent forked the record again — the stored parent is
 * unchanged, so the retry is divergent all over again. Derived, the push door finds the fork it already made and
 * answers the retry `forked` with it, writing nothing (`heldFork`, before either fork cap), and two peers forking
 * the same divergence arrive at one id.
 *
 * Shaped as a v4 UUID (version and variant bits set) rather than v5, because a fork id is a fact id and every
 * reader that validates one — link endpoints, the fork-id response — expects that shape. The encoding is
 * `edge-id.ts`'s length-prefixed parts, so no text can forge a separator. The namespace is fixed for ever.
 */
export function forkIdFor(parentId: string, seq: number, text: string): string {
  const h = createHash('sha256')
    .update(`ythril.fork-identity${idPart(parentId)}${idPart(String(seq))}${idPart(text)}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * How an arriving file's METADATA is written, and when the file is then queued — the two halves every writer of a
 * peer's file metadata needs, written once (`Q-107` part 2, bundle-30 `R12`).
 *
 * ## Why a file is MERGED, not replaced
 *
 * A file row carries this instance's own machinery beside what was authored: the size and hash of the bytes held
 * HERE, the excerpt, the media pipeline's state, the vector. A whole-document replace would publish the sender's
 * size and hash for bytes this instance derived itself, so the authored keys are `$set` and nothing is `$unset` that
 * the sender merely did not mention — an older peer cannot erase a field it does not know.
 *
 * ## What each copy had dropped
 *
 * The merge was written twice — the arrival writer's per-document `ingestFileMeta` and the stray drain's
 * peer-written-row branch — and the blob-held check twice, and the copies had drifted:
 *  - **Peer text was set as given.** Safe in a plain `$set`, fatal in an update PIPELINE (the shape that can carry a
 *    default for a missing stamp), where a description `$seq` is read as a FIELD PATH. Every authored value is
 *    wrapped in `$literal` here, so no caller can build the pipeline without it.
 *  - **The drain queued a file with no suppression check** (`queueIfHeld` called `enqueueEmbedJob` directly), so a
 *    file this instance suppresses was queued, claimed and discarded. `embedArrivedFiles` asks the receiver's
 *    `record > space` resolution, for every caller: a suppressed file's vectors are removed, any other is queued.
 *
 * ## What crosses, per document (`Q-230`, `Q-234`)
 *
 * - **A restore** stores the backup's record-tier fields (`RESTORED_LOCAL_FIELDS`: the retention stamps, `syncBase`)
 *   as the backup carried them, a missing stamp from D-9 (the record's own `createdAt` by this instance's window), and
 *   NEVER the replaced copy's — a field the backup does not carry is removed.
 * - **A peer's arrival** keeps a stamp the stored row has and is given D-9's where it has none.
 * - **An arrival this instance suppresses** loses every derived field (`embedding`, `embeddingModel`,
 *   `matchedText`): they describe content it no longer embeds, and `matchedText` would keep removed text findable.
 */
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { enqueueIngestedRecords } from '../brain/embed-queue.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { dropFileVectors } from '../brain/suppression-sweep.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { DERIVED_LOCAL_FIELDS, RESTORED_LOCAL_FIELDS } from './local-only-fields.js';

/** What `fileMetaUpdate` is told besides the document. */
export interface FileMetaUpdateOptions {
  /** The D-9 stamps this instance's policy gives the record, absent where it gives none. */
  defaults?: Readonly<Record<string, unknown>>;
  /** An admin restore: the record-tier fields are the backup's, never the replaced copy's. */
  restore?: boolean;
  /** The receiver suppresses this file: its derived fields go. */
  suppressed?: boolean;
}

/**
 * The update PIPELINE that merges an arriving file's authored keys into its row — see the module docblock. `doc` is
 * the document as the writer prepared it: wire keys only, plus, on a restore, the backup's record-tier fields.
 */
export function fileMetaUpdate(doc: Readonly<Record<string, unknown>>, opts: FileMetaUpdateOptions = {}): object[] {
  const { defaults = {}, restore = false, suppressed = false } = opts;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id' || v === undefined || RESTORED_LOCAL_FIELDS.has(k)) continue;
    set[k] = { $literal: v };
  }
  for (const f of RESTORED_LOCAL_FIELDS) {
    const given = restore ? doc[f] : undefined;
    const fallback = defaults[f];
    if (restore) set[f] = given !== undefined ? { $literal: given } : fallback !== undefined ? { $literal: fallback } : '$$REMOVE';
    else if (fallback !== undefined) set[f] = { $ifNull: [`$${f}`, { $literal: fallback }] };
  }
  return [{ $set: set }, ...(suppressed ? [{ $unset: [...DERIVED_LOCAL_FIELDS] }] : [])];
}

/** Does this instance hold the file's bytes? Its row then carries the size or hash it derived from them. */
export function holdsBlob(row: { sha256?: unknown; sizeBytes?: unknown } | undefined): boolean {
  return row?.sha256 !== undefined || row?.sizeBytes !== undefined;
}

/**
 * Bring landed files' vectors in line with the RECEIVER's rules, after their metadata was written — one read for the
 * set, then:
 *  - **a file this instance suppresses** (its own flag as stored now, or the space: a file has two tiers) holds no
 *    vector, nor do the rows derived from it (`dropFileVectors`) — whoever set the flag, an arriving peer copy or the
 *    stray drain's fill. Queued instead, as the drain's copy of this did, it was claimed and discarded; skipped, as
 *    a suppression check alone would, the old vector stayed;
 *  - **any other file is queued** (one batched enqueue, background lane) when its bytes are here — metadata can
 *    arrive first, and the bytes enqueue the file when they land (`recordArrivedFile`) — or, on a restore, always:
 *    the export carries no bytes, and a restore's promise is that search comes back on its own.
 */
export async function embedArrivedFiles(spaceId: string, ids: readonly string[], { restore = false }: { restore?: boolean } = {}): Promise<void> {
  if (ids.length === 0) return;
  const rows = await readStoredById<{ sha256?: string; sizeBytes?: number; suppressEmbeddings?: boolean }>(
    spaceCollection(spaceId, 'files'), ids, { sha256: 1, sizeBytes: 1, suppressEmbeddings: 1 });
  const meta = getSpaceMeta(spaceId);
  const quiet: string[] = [];
  const wanted: Array<{ _id: string; suppressEmbeddings?: boolean }> = [];
  for (const [_id, r] of rows) {
    const doc = { _id, ...(r.suppressEmbeddings !== undefined ? { suppressEmbeddings: r.suppressEmbeddings } : {}) };
    if (embeddingSuppressedFor(spaceId, 'file', doc, meta)) quiet.push(_id);
    else if (restore || holdsBlob(r)) wanted.push(doc);
  }
  await dropFileVectors(spaceId, quiet);
  await enqueueIngestedRecords(spaceId, 'file', wanted);
}

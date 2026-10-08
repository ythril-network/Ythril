/**
 * What the receiver does with a landed file's vectors, by ITS rules: the half of a file's arrival that comes after the row is
 * written, for every door that writes one (the arrival writer, the stray drain's fill, the bytes that create a row here).
 *
 * ## Why it is a module of its own
 *
 * It was the tail of `sync/file-meta-write.ts`, the metadata merge, and `files/file-meta.ts` imported it from there for the
 * row arriving bytes create. The merge then came to read its removal rule from the wire schema (`api/sync/_shared.ts`, Q-256),
 * and the schema module reaches `files/file-meta.ts` through the deletion authority, so the three formed an import cycle. This
 * half asks nothing of the wire, so it lives where it needs no part of it, and the merge re-exports it for its callers.
 */
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { enqueueIngestedRecords } from '../brain/embed-queue.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { dropFileVectors } from '../brain/suppression-sweep.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';

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

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
import { NOT_A_FLAGGED_ROW } from '../files/live-file-row.js';
import { readStoredById } from '../db/read-by-id.js';
import { enqueueIngestedRecords, EMBED_REPAIR_ROUTE } from '../brain/embed-queue.js';
import { derivedFieldsForWrite } from '../brain/derived-text-on-write.js';
import { writeDerivedFields } from '../files/derived-fields.js';
import { atReadSeq, readSeqOf } from '../db/at-read-seq.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { dropFileVectors } from '../brain/suppression-sweep.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { log, peerList, peerText } from '../util/log.js';

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
  const rows = await readStoredById<FileRowRead>(
    // A flagged row is not queued. The arrival merge keeps the flag and merges `sha256` and `sizeBytes` back in, so
    // without this an arrival onto a deleted file's audit record reads as "the bytes are here" and queues an embed job
    // for it — putting back the vector the flag's own write stripped. The text inputs ride along for the rows this
    // instance suppresses: their text is written below, from this same read.
    spaceCollection(spaceId, 'files'), ids, { sha256: 1, sizeBytes: 1, suppressEmbeddings: 1, seq: 1, tags: 1, description: 1, properties: 1, excerpt: 1 },
    { filter: NOT_A_FLAGGED_ROW });
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
  // Last, so a failed text write never holds back the queue above: a row left without its text is owed by the backfill's walk (its
  // text is stale), which queues it.
  await storeSuppressedFileText(spaceId, quiet.map(id => ({ _id: id, ...rows.get(id)! })));
}

type FileRowRead = {
  sha256?: string; sizeBytes?: number; suppressEmbeddings?: boolean; seq?: number;
  tags?: string[]; description?: string; properties?: Record<string, unknown>; excerpt?: string;
};

/**
 * A suppressed file's `matchedText`, this instance's own: built by its text builder from the row as merged (`Q-262`) and written
 * through the one writer of a derived field, onto the version read. A file's text depends on fields the arrival does not
 * carry (its excerpt is of the bytes THIS instance holds), so it cannot be built before the merge, unlike the other families'.
 * With no vector beside it, it is the lexical channel's text and nothing compares it to one (`derivedFieldsForWrite`).
 */
async function storeSuppressedFileText(spaceId: string, rows: ReadonlyArray<{ _id: string } & FileRowRead>): Promise<void> {
  if (rows.length === 0) return;
  // Imported here, not at the top: `embed-record` reaches the inference host, which reaches the metrics registry, which reaches this
  // module through the file tombstones. A static import is a runtime import cycle (`no-runtime-import-cycles`), and the one that
  // evaluates the registry first reads its embed-phase source before it exists.
  try {
    const { buildEmbedTexts } = await import('../brain/embed-record.js');
    const texts = await buildEmbedTexts(spaceId, 'file', rows as unknown as Array<Record<string, unknown>>);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const text = texts[i];
      // Only a string is a text: `null` is a row with none, and the builder's marker a row whose own field has the wrong type (named
      // once by the builder, and owed by the backfill, whose job then fails where `list_embed_jobs` shows it).
      if (typeof text !== 'string') continue;
      // The `unset` too: a vector that landed after `dropFileVectors` above would otherwise stand beside the new text, the pair the
      // rule exists to refuse, and once the text is current no repair walk would find the row.
      const { set, unset } = await derivedFieldsForWrite({ text: () => text, vector: null, suppressed: true, onto: 'stored' });
      await writeDerivedFields({
        spaceId, collectionSuffix: 'files', tier: 'top-level', filter: atReadSeq(row._id, readSeqOf(row as Record<string, unknown>)), set, unset,
      });
    }
  } catch (err) {
    // The tail of a write that has landed, for callers that must not fail after their merge: a retry is idempotent and the backfill's
    // walk owes a suppressed row without its text (stale), so the failure is named here, once, and not raised into them.
    log.warn(`The lexical text of ${rows.length} suppressed file(s) in space '${peerText(spaceId)}' was NOT stored (${peerText(err)}): `
      + `${peerList(rows.map(r => r._id))}. The files themselves are written; ${EMBED_REPAIR_ROUTE} stores the text.`);
  }
}

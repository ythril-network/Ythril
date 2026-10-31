/**
 * A suppressed file's `matchedText`, this instance's own (`Q-262`).
 *
 * ## The question it answers
 *
 * "A peer's file metadata has just landed on a row this instance keeps out of meaning-ranked search: what text does the row
 * store for the lexical channel?" Its own, built by this instance's text builder from the row AS MERGED, and written
 * with no vector beside it (`derivedFieldsForWrite`).
 *
 * ## What it prevents
 *
 * An arrival this instance suppresses lost every derived field (`Q-230`), `matchedText` included, and nothing queues a
 * suppressed record, so nothing wrote the text again: the file was missing from the lexical index and from the duplicate
 * scanner, while a local write of the same file stores its text either way. The other families are given their text in the
 * replace itself (`sync/arrivals.ts`, `suppressedTexts`); a file cannot be, because its text depends on fields the arrival
 * does not carry (its excerpt is of the bytes THIS instance holds), so it is built after the merge.
 *
 * ## Where it is asked
 *
 * By the one writer of a peer's file metadata (`ingestFileMeta`) and by the stray-filemeta drain's fill
 * (`sync/arrivals.ts`, `fillOnly`): both land a peer's file metadata, and a second way to write the text is a second
 * answer to the question above. A row the instance does NOT suppress is left alone (its job writes the pair).
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { derivedFieldsForWrite } from '../brain/derived-text-on-write.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { atReadSeq, readSeqOf } from '../brain/write-precondition.js';
import { log, peerList, peerText } from '../util/log.js';
import type { FileMetaDoc } from '../config/types.js';

type FileRowRead = {
  _id: string; seq?: number; suppressEmbeddings?: boolean;
  tags?: string[]; description?: string; properties?: Record<string, unknown>; excerpt?: string;
};

/**
 * Store the text of each of these file rows that this instance suppresses, onto the version read (`atReadSeq`): a newer copy
 * that lands meanwhile is not written over with the text of the one read.
 *
 * **It never throws.** It is the tail of a write that has already landed, for callers that must not fail after their merge: a retry
 * is idempotent, and the repair (`reembed`'s stale walk) finds a suppressed row without its text, so a failure is named here, once,
 * with the files and the repair, and not raised into them (where it would be taken for the failure of the write it follows).
 */
export async function storeSuppressedFileText(spaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await writeSuppressedFileText(spaceId, ids);
  } catch (err) {
    log.warn(`The lexical text of ${ids.length} file(s) this instance suppresses in space '${peerText(spaceId)}' was NOT stored (${peerText(err)}): `
      + `${peerList(ids)}. The files themselves are written; POST /api/spaces/:id/reembed stores the text.`);
  }
}

async function writeSuppressedFileText(spaceId: string, ids: readonly string[]): Promise<void> {
  const rows = await readStoredById<FileRowRead>(
    spaceCollection(spaceId, 'files'), ids,
    { seq: 1, suppressEmbeddings: 1, tags: 1, description: 1, properties: 1, excerpt: 1 },
  );
  const quiet = [...rows.values()].filter(r => embeddingSuppressedFor(spaceId, 'file', r as unknown as Record<string, unknown>));
  if (quiet.length === 0) return;
  // Imported here, not at the top: `embed-record` reaches the inference host, which reaches the metrics registry, which
  // reaches this module through the file tombstones, and a static import is a runtime import cycle.
  const { buildEmbedTexts } = await import('../brain/embed-record.js');
  const texts = await buildEmbedTexts(spaceId, 'file', quiet as unknown as Array<Record<string, unknown>>);
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  for (let i = 0; i < quiet.length; i++) {
    const row = quiet[i]!;
    const text = texts[i];
    if (text === null || text === undefined) continue;
    const { set } = await derivedFieldsForWrite({ text: () => text, vector: null, suppressed: true, onto: 'stored' });
    await files.updateOne(asFilter<FileMetaDoc>(atReadSeq(row._id, readSeqOf(row as unknown as Record<string, unknown>)) as never),
      asUpdate<FileMetaDoc>({ $set: set } as never));
  }
}

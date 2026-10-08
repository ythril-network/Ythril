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
 * ## What is removed, and only by the sender's word (`Q-256`)
 *
 * Absence on its own says nothing, so the merge never removed an authored key, and a key the operator REMOVED at the
 * publisher (a description, its source, the properties, the tags, a suppression mark) stayed on every other instance
 * for ever, hashed on both and different. A sender now lists the authored keys its version knows (`authoredKeys`, which
 * is consumed here and never stored), and the SAME update `$unset`s each key that is listed, that this version also
 * authors, and that the document lacks (`removedFileMetaKeys`). Three things keep that from erasing more than was said:
 *  - **a key the sender does not list is never touched** — an older sender has no word on keys it never heard of, and
 *    no list at all (an older sender, the stray drain) removes nothing;
 *  - **a name that is no authored key here is never unset**, whatever the list says — the check is against the set
 *    this version derives from its own wire schema, so `sha256`, `sizeBytes`, `deletedAt` and the rest of what this
 *    instance holds about its own bytes are out of reach, and no name a peer picks reaches the update;
 *  - **the write guard is the arrival writer's own**: a copy that loses on its seq is not written at all, removal included.
 * A RESTORE carries no list because an export is a full record: every authored key its document lacks is removed, and the import
 * summary counts the ones the replaced rows had (`authoredKeysRestoreRemoves`).
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
 *   NEVER the replaced copy's — a field the backup does not carry is removed, the replaced copy's vector, model and
 *   `matchedText` included (`carriedFields`, the arrival writer's own answer; the merge once kept them, D2).
 * - **A peer's arrival** keeps a stamp the stored row has and is given D-9's where it has none — and is stamped with WHO
 *   DELIVERED it (`deliveredBy`, bundle-51), which is not carried: its own step after the carried fields, so a newer version
 *   delivered by another peer is that peer's. A restore stores the backup's own (`''` when it has none); the stray drain's
 *   fill passes none, and the stored stamp stays.
 * - **An arrival this instance suppresses** loses every derived field (`embedding`, `embeddingModel`,
 *   `matchedText`): they describe content it no longer embeds, and `matchedText` would keep removed text findable.
 */
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById } from '../db/read-by-id.js';
import { removedFileMetaKeys, FILE_META_AUTHORED_KEYS } from '../api/sync/_shared.js';
import { carriedFields, stampOfArrival, LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS } from './local-only-fields.js';

/** What `fileMetaUpdate` is told besides the document. */
export interface FileMetaUpdateOptions {
  /** The D-9 stamps this instance's policy gives the record, absent where it gives none. */
  defaults?: Readonly<Record<string, unknown>>;
  /** An admin restore: the record-tier fields are the backup's, never the replaced copy's. */
  restore?: boolean;
  /** The receiver suppresses this file: its derived fields go. */
  suppressed?: boolean;
  /**
   * Who delivered this version (`deliveredBy`, bundle-51): the delivering peer's id, or `''` for nobody (an admin or local
   * push). Stamped explicitly, AFTER the carried fields, because the carry would otherwise keep the stored stamp and a
   * newer version delivered by another peer would stay the first deliverer's. Absent: the stored stamp is left alone —
   * what the stray drain's fill wants, which is not an arrival from a peer at that moment. Ignored by a restore, which
   * stores the backup's own (`''` for a backup that has none).
   */
  deliveredBy?: string;
}

/**
 * The update PIPELINE that merges an arriving file's authored keys into its row, and removes those its sender says
 * were removed — see the module docblock. `doc` is the document as the writer prepared it: wire keys only, plus, on a
 * restore, the backup's record-tier fields. One update per document, whatever it removes.
 */
export function fileMetaUpdate(doc: Readonly<Record<string, unknown>>, opts: FileMetaUpdateOptions = {}): object[] {
  const { defaults = {}, restore = false, suppressed = false } = opts;
  // What the stored row keeps of its local-only fields is the arrival writer's one answer, not this merge's own: a
  // field it does not carry is the backup's (a restore's record tier), D-9's, or gone (bundle-30 I6, D2).
  const carried = carriedFields({ restore, suppressed });
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    // `authoredKeys` is wire control: read below for what it removes, and never written to the row.
    if (k === '_id' || k === 'authoredKeys' || v === undefined || LOCAL_ONLY_FIELDS.has(k)) continue;
    set[k] = { $literal: v };
  }
  for (const f of LOCAL_ONLY_FIELDS) {
    // Only a restore brings a local-only field of its own (its record tier); a peer's was dropped before here.
    const given = restore && RESTORED_LOCAL_FIELDS.has(f) ? doc[f] : undefined;
    const fallback = defaults[f];
    if (carried.has(f)) {
      if (fallback !== undefined) set[f] = { $ifNull: [`$${f}`, { $literal: fallback }] };
    } else {
      set[f] = given !== undefined ? { $literal: given } : fallback !== undefined ? { $literal: fallback } : '$$REMOVE';
    }
  }
  // Who delivered THIS version: its own step, after the loop above, so no carried value can stand in for it.
  // Absent for a caller that is not an arrival from a peer (the stray drain's fill): the stored stamp is left alone.
  if (restore || opts.deliveredBy !== undefined) set['deliveredBy'] = { $literal: stampOfArrival({ restore, doc, deliveredBy: opts.deliveredBy }) };
  const removed = removedFileMetaKeys(doc, { restore });
  return removed.length > 0 ? [{ $set: set }, { $unset: removed }] : [{ $set: set }];
}

/**
 * How many authored keys a restore of `docs` takes off the rows it replaces, per file id (an id that loses none is absent): the
 * keys `removedFileMetaKeys` says the update removes (`fileMetaUpdate` asks the same function of the same document) that the
 * stored row HAS — a key the row never had is removed from nothing. Read BEFORE the write, because the write replaces the row.
 *
 * Asked by the arrival writer for a restore and no other door: a peer's arrival removes only what its sender lists, and an
 * operator is told of a restore's removals because an export is a full record and an older backup over newer edits is silent loss.
 */
export async function authoredKeysRestoreRemoves(spaceId: string, docs: ReadonlyArray<Readonly<Record<string, unknown>> & { _id: string }>): Promise<Map<string, number>> {
  const lacking = new Map(docs.map(d => [d._id, removedFileMetaKeys(d, { restore: true })] as const).filter(([, keys]) => keys.length > 0));
  const counts = new Map<string, number>();
  if (lacking.size === 0) return counts;
  const rows = await readStoredById<Record<string, unknown>>(spaceCollection(spaceId, 'files'), [...lacking.keys()],
    Object.fromEntries([...FILE_META_AUTHORED_KEYS].map(k => [k, 1 as const])));
  for (const [id, keys] of lacking) {
    const row = rows.get(id);
    const n = row === undefined ? 0 : keys.filter(k => row[k] !== undefined).length;
    if (n > 0) counts.set(id, n);
  }
  return counts;
}

// The vector half of an arrival lives in its own module (its docblock says why: an import cycle through the wire schema);
// re-exported so the merge's callers keep one import.
export { holdsBlob, embedArrivedFiles } from './embed-arrived-files.js';

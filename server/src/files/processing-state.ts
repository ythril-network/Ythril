/**
 * What THIS instance did with a file's bytes, written without touching the file's authored half (`Q-240`).
 *
 * ## The question this module answers
 *
 * "How does a pipeline record its progress on a top-level file row?" A row carries two kinds of field. The AUTHORED
 * ones (`description`, `tags`, `properties`, `author`, `seq`, `updatedAt`...) are what `brain/merkle.ts` hashes
 * (`FILE_HASH_PROJECTION`) and what replicates. The PROCESSING ones (`embeddingStatus`, `mediaJobError`, `mediaType`,
 * `chunkCount`, `convertedFileId`, `conversionError`) are derived from this instance's copy of the bytes: never hashed,
 * never sent.
 *
 * ## What it prevents
 *
 * Nine writers said `{ $set: { embeddingStatus, updatedAt: now } }` each in its own place. `updatedAt` is hashed, so a
 * file that arrived from a peer carried the peer's stamp until this instance's worker ran and this instance's after,
 * and two instances holding identical data reported `MERKLE_DIVERGENCE` over a status mark each had made on its own
 * copy. The one-line `updatedAt` was the part nothing stopped a writer adding. So the write lives here and a caller
 * cannot name a field the hash sees: the argument is typed, the keys are checked at run time as well (a cast gets no
 * further than the type), and the module sets no `updatedAt` and no `seq` whatever it is handed.
 *
 * `a-file-row-processing-write-goes-through-one-function` holds the rule over the tree: a write to a space's files
 * collection that touches a processing field anywhere else fails.
 *
 * ## Absent is untouched, `undefined` is removed
 *
 * A key that is not in the argument is left as it is. A key present with the value `undefined` is `$unset` — what the
 * retry and the failure mark meant by `mediaJobError: undefined` while the driver stored it as `null`, which is not
 * the same as a row nothing has touched.
 *
 * ## The local-only set is derived, not listed
 *
 * `localFileFields()` is every `FileMetaDoc` key the divergence hash does not see (`FILE_HASH_PROJECTION`, an
 * inclusion list, exported by `brain/merkle.ts` for this), less the two identity keys that are not hashed and
 * not local either (below). It replaces `LOCAL_FILE_FIELDS` in `file-meta.ts`, a hand-written three, which is how a
 * fourth local field would have stamped `updatedAt` from `updateFileMeta` the day somebody forgot to add it to the list.
 * The key list is typed `Record<keyof FileMetaDoc, true>`, so the COMPILER holds it complete: a field added to
 * `FileMetaDoc` and to neither this nor the hash fails the build.
 */
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { FILE_HASH_PROJECTION } from '../brain/merkle.js';
import { RETAGGED_FIELDS } from '../sync/retagged-fields.js';
import type { FileMetaDoc } from '../config/types.js';

/**
 * The processing state of a top-level file row. Every field is local: derived from this instance's copy of the bytes.
 *
 * `undefined` as a value removes the field; leaving a key out leaves it alone.
 */
export interface FileProcessingState {
  embeddingStatus?: NonNullable<FileMetaDoc['embeddingStatus']> | undefined;
  mediaJobError?: string | undefined;
  mediaType?: NonNullable<FileMetaDoc['mediaType']> | undefined;
  chunkCount?: number | undefined;
  convertedFileId?: string | undefined;
  conversionError?: string | undefined;
}

/** The keys of `FileProcessingState`, held complete by the compiler. */
const PROCESSING_KEYS: Readonly<Record<keyof FileProcessingState, true>> = {
  embeddingStatus: true, mediaJobError: true, mediaType: true, chunkCount: true, convertedFileId: true, conversionError: true,
};

/** Every key a file row can carry, held complete by the compiler: a `FileMetaDoc` field missing here fails the build. */
const FILE_META_KEYS: Readonly<Record<keyof FileMetaDoc, true>> = {
  _id: true, spaceId: true, path: true, description: true, descriptionSource: true, excerpt: true, tags: true,
  properties: true, matchedText: true, createdAt: true, updatedAt: true, sizeBytes: true, sha256: true, author: true,
  seq: true, deletedAt: true, embedding: true, embeddingModel: true, parentFileId: true, chunkIndex: true,
  headingText: true, content: true, convertedFileId: true, chunkCount: true, conversionError: true, mediaType: true,
  embeddingStatus: true, chunkOffsetMs: true, chunkDurationMs: true, mediaJobError: true, faceEmbedding: true,
  faceEntityId: true, faceBbox: true, faceScore: true,
};

/**
 * The keys the hash does not see and that are nonetheless NOT local state.
 *
 * The retagged fields (`RETAGGED_FIELDS`, `sync/retagged-fields.ts`: `spaceId`, the receiver's own retag of an arriving row,
 * which is read from there rather than spelled again) and `parentFileId`, which is declared
 * `never` on the wire so a chunk is refused rather than stripped into a file: both are on `IncomingFileMetaDoc`, and a
 * key that replicates is not local. They are identity, which no processing write has any business setting.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([...RETAGGED_FIELDS, 'parentFileId']);

let localKeys: ReadonlySet<string> | undefined;

/**
 * The file-row fields that are this instance's own: every `FileMetaDoc` key the divergence hash does not see, less the
 * identity keys. Computed on first use, not at load: `brain/merkle.ts` reaches the file modules, and a module-level read
 * of its export would be a read of a binding not yet initialised.
 */
export function localFileFields(): ReadonlySet<string> {
  localKeys ??= new Set(Object.keys(FILE_META_KEYS).filter(k => !Object.hasOwn(FILE_HASH_PROJECTION, k) && !IDENTITY_KEYS.has(k)));
  return localKeys;
}

/** Whether a write to `key` is a local write: one that is not authored, and so stamps neither `updatedAt` nor `seq`. */
export function isLocalFileField(key: string): boolean {
  return localFileFields().has(key);
}

/**
 * Record what this instance did with the bytes of one or several top-level file rows.
 *
 * Sets only the fields named, never `updatedAt` and never `seq`; a field given as `undefined` is removed. A key that is
 * not a processing field, or that the hash sees, THROWS: that is a programming error the type already refuses, and
 * running on it would put a hashed field back on a status mark. An empty state throws too — nothing to record.
 *
 * Several ids are one `updateMany`, so a bulk retry stays one round trip.
 *
 * @throws when `state` names a field that is not a processing field, or is empty
 */
export async function setFileProcessingState(
  spaceId: string,
  target: string | readonly string[],
  state: FileProcessingState,
): Promise<void> {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  const given = Object.keys(state);
  if (given.length === 0) throw new Error('setFileProcessingState: nothing to record');
  for (const key of given) {
    if (Object.hasOwn(FILE_HASH_PROJECTION, key)) {
      throw new Error(`setFileProcessingState: '${key}' is hashed and replicates — a processing mark must not set it`);
    }
    if (!Object.hasOwn(PROCESSING_KEYS, key) || !isLocalFileField(key)) {
      throw new Error(`setFileProcessingState: '${key}' is not a file processing field`);
    }
    const value = (state as Record<string, unknown>)[key];
    if (value === undefined) $unset[key] = '';
    else $set[key] = value;
  }
  const ids = typeof target === 'string' ? [target] : [...target];
  if (ids.length === 0) return;
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateMany(
    asFilter<FileMetaDoc>({ _id: ids.length === 1 ? ids[0]! : { $in: ids } }),
    asUpdate<FileMetaDoc>({
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    }),
  );
}

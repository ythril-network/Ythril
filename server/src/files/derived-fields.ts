/**
 * What THIS instance derived from a file's bytes, and the ONE place every such field is written (`Q-240`, `Q-418`).
 *
 * ## The question this module answers
 *
 * *"Is the file this row belongs to still live, and where does a write of what its bytes produced land?"* A files row
 * carries two kinds of field. The AUTHORED ones (`description`, `tags`, `properties`, `author`, `seq`, `updatedAt`...)
 * are what `brain/merkle.ts` hashes (`FILE_HASH_PROJECTION`) and what replicates. The DERIVED ones — the vector and the
 * model that made it, `matchedText`, `excerpt`, the processing marks (`embeddingStatus`, `mediaJobError`, `mediaType`,
 * `chunkCount`, `convertedFileId`, `conversionError`), and the content and vectors of the chunk, caption and face rows
 * a file produces — are computed from this instance's copy of the bytes: never hashed, never sent.
 *
 * ## What it prevents, and the second half is newer than the first
 *
 * **The hashed field a writer adds by accident.** Nine writers said `{ $set: { embeddingStatus, updatedAt: now } }` each
 * in its own place. `updatedAt` is hashed, so a file that arrived from a peer carried the peer's stamp until this
 * instance's worker ran and this instance's after, and two instances holding identical data reported
 * `MERKLE_DIVERGENCE` over a status mark each had made on its own copy. The one-line `updatedAt` was the part nothing
 * stopped a writer adding.
 *
 * **The write that lands after the file was deleted.** A media job reads a file, spends a long step on it (a vision
 * call, a transcription, an embedding) and then writes. A delete inside that step flags the FILE's row
 * (`softDeleteFileMeta`) and removes the chunk rows it can see; the job then writes the rest — a vector onto an audit
 * row, a caption nobody can reach, a face row recall still finds. Every one of those writes filtered on the row it was
 * writing and asked nothing about the file it belonged to, and **a chunk row never carries `deletedAt`**: the flag sits
 * on the parent, so a predicate on the chunk asks the wrong row's question. That is the forgettable part, so it is
 * INSIDE here — a caller cannot drop it, because a caller does not write the field.
 *
 * ## The tiers, because the question is not the same for both
 *
 * A TOP-LEVEL row asks about itself: the write carries `NOT_A_FLAGGED_ROW` in its own filter, so a flagged row simply
 * does not match. A CHUNK, caption or face row asks about its PARENT: the parent is read first, and a write for a
 * parent that is gone or flagged is not made at all. Not making it is **not a failure** — the file was deleted, which is
 * the right outcome and nothing an operator needs told about; the caller gets `gone` and reports nothing.
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
 *
 * ## The one exception, named rather than hidden
 *
 * {@link setDerivedDescriptionIfUnset} writes a field that IS hashed and DOES replicate. A description derived from the
 * bytes is still the file's description: the publisher derives its own and that one travels, which is why the write is
 * restricted to a file this instance authored and stamps a seq like any authored write. It lives here because what it
 * writes is derived from bytes, and because it was one of the writers landing a description on a deleted file.
 *
 * `a-files-derived-fields-are-written-by-one-module` holds the rule over the tree: a write that touches a derived field
 * anywhere else fails, and `a-file-row-derived-fields-write-goes-through-one-function` holds the processing half of it.
 */
import { col, asFilter, asUpdate, asDoc } from '../db/mongo.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { FILE_HASH_PROJECTION } from '../brain/merkle.js';
import { RETAGGED_FIELDS } from '../sync/retagged-fields.js';
import { NOT_A_FLAGGED_ROW } from './live-file-row.js';
import { withSeqWhen } from '../util/seq.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';
import { deliveredByAPeer, notDeliveredByAPeer } from '../sync/delivered-by.js';
import { authorRef } from '../config/author.js';
import { toDocId } from '../util/paths.js';
import { inChunks } from '../util/chunks.js';
import { enqueueEmbedJob, EMBED_PRIORITY } from '../brain/embed-queue.js';
import type { ClientSession } from 'mongodb';
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

/** What a write of derived fields did. `gone` is a success: the file was deleted, so there was nothing to record. */
export type DerivedWriteOutcome = 'written' | 'superseded' | 'gone';

/**
 * The `descriptionSource` values that say THIS instance made the `description` from the bytes — the only way to tell one from a
 * person's. The one list: the predicate, the Mongo `$in`s, the wire enum and the types all read it, so a third source cannot be
 * added to some and not the others (a description read as a person's, a stamp report that calls a machine's text "edited here").
 */
export const MACHINE_MADE_SOURCES = Object.freeze(['generated', 'extracted'] as const);
export type MachineMadeSource = typeof MACHINE_MADE_SOURCES[number];

/** Whether `value` is a `descriptionSource` that marks a machine-made description. Anything else — absent, a person's — is not. */
export function isMachineMadeSource(value: unknown): value is MachineMadeSource {
  return MACHINE_MADE_SOURCES.some(s => s === value);
}

/** The fields a deleted file's row loses outright: what the bytes made, and the fingerprint of bytes that are gone. */
const STRIPPED = ['embedding', 'embeddingModel', 'matchedText', 'excerpt', 'sha256', 'embeddingStatus'];

/**
 * REMOVE everything a file's bytes made from a row — the stages, so the flag write and the one-off repair below cannot
 * disagree about what "everything" is.
 *
 * It is a pipeline because one removal is conditional and a plain `$unset` cannot ask a question. A `description` is the
 * person's when they wrote it and the file's own prose when a conversion produced it, and only the second is made from
 * bytes the space no longer has; `descriptionSource` tells them apart, so the description goes exactly when that marker
 * says `generated` or `extracted`, and the marker goes with it — it exists only in that case.
 *
 * What stays, deliberately: `path`, `author`, `createdAt`, `deletedAt`, the retention stamp, `tags`, `properties`, and a
 * description a person wrote. Those are what somebody deleted, not what the bytes produced.
 */
export function stripDerivedStages(): object[] {
  return [
    { $unset: STRIPPED },
    { $set: { description: { $cond: [{ $in: ['$descriptionSource', [...MACHINE_MADE_SOURCES]] }, '$$REMOVE', '$description'] } } },
    { $unset: ['descriptionSource'] },
  ];
}

/**
 * Strip the rows of one space that were FLAGGED BEFORE the flag write started stripping — a bounded, idempotent repair.
 *
 * Strip-at-flag is forward-only. A row an earlier release flagged still holds the vector, the matched text, the excerpt,
 * the content hash, the processing state and a machine-made description — bytes' worth of a deleted file, for ever on a
 * space with no file retention window, where the reap never reaches it.
 *
 * **It needs no marker, and that is the design rather than an omission.** The work it has left is a QUERY: a flagged row
 * that still holds any of those fields. Stripping one takes it out of the query for good, so a second pass over the same
 * space matches nothing and writes nothing, and a pass interrupted halfway resumes by asking the same question. (A
 * marker is for a repair whose query would re-match later writes — the delivered-by backfill is that kind; this is not.)
 *
 * The fields are LOCAL, so this is not the boot-time rewrite of synced data that rule warns about: nothing it removes
 * was ever hashed or offered to a peer.
 *
 * @returns how many rows it stripped
 */
export async function stripFlaggedRowsOnce(spaceId: string, limit: number): Promise<number> {
  const owed = {
    deletedAt: { $exists: true },
    $or: [
      ...STRIPPED.map(f => ({ [f]: { $exists: true } })),
      { descriptionSource: { $in: [...MACHINE_MADE_SOURCES] } },
    ],
  };
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const page = await files.find(asFilter<FileMetaDoc>(owed as never), { projection: { _id: 1 }, limit }).toArray();
  if (page.length === 0) return 0;
  const r = await files.updateMany(
    asFilter<FileMetaDoc>({ _id: { $in: page.map(d => String(d._id)) } }),
    stripDerivedStages() as never,
  );
  return r.modifiedCount;
}

/** A derived row names the file it came from; without it there is no liveness question to ask. */
function requireParent(parentFileId: string | undefined): string {
  if (parentFileId === undefined) throw new Error('writeDerivedFields: a derived row names the file it came from');
  return parentFileId;
}

/**
 * Is the file a DERIVED row belongs to still here? Read once per write, by the parent's id.
 *
 * A chunk, caption or face row carries no `deletedAt` of its own, so this is the only form of the question that means
 * anything for one. A parent that is absent (the delete removed it outright) and a parent that is flagged (the delete
 * kept its audit record) answer the same: no.
 *
 * **The window it leaves, stated:** it is a read, then the write, and the check cannot move into the write's filter —
 * the derived row is a different document from its parent. A delete removes a file's derived rows first and flags or
 * removes the file after (`removeWhatSidecarsLeft`), so a write whose read came before the flag and whose write came
 * after the children went leaves one derived row behind a parent that is gone. No default read reaches it (its parent
 * is flagged or absent), and nothing removes it yet: Q-436.
 */
async function parentIsLive(spaceId: string, parentFileId: string): Promise<boolean> {
  const parent = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).findOne(
    asFilter<FileMetaDoc>({ _id: parentFileId, ...NOT_A_FLAGGED_ROW }), { projection: { _id: 1 } },
  );
  return parent !== null;
}

/** Refuse a derived write naming a key the hash covers: a derived field is this instance's own, a hashed one replicates. */
function refuseHashed(where: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (Object.hasOwn(FILE_HASH_PROJECTION, key)) {
      throw new Error(`${where}: '${key}' is hashed and replicates — a derived write must not set it`);
    }
  }
}

/**
 * WHICH ROW is being written, and therefore which liveness question applies. An explicit argument at every call,
 * never inferred, because the wrong answer is silent: `derived` asks about a row that cannot carry the flag, and
 * `not-a-file` asks nothing at all.
 *
 *  - `top-level` — a file's own row. Its filter gains `NOT_A_FLAGGED_ROW`, so a flagged row does not match.
 *  - `derived` — a chunk, caption or face row. Its PARENT is read first (`parentFileId` is then required), because a
 *    derived row never carries `deletedAt` of its own.
 *  - `not-a-file` — a record of another kind, written through the one embed site that serves every kind. There is no
 *    flag to ask about: a delete removes the row, which the caller's own `atReadSeq` precondition already sees.
 */
export type FileRowTier = 'top-level' | 'derived' | 'not-a-file';

/**
 * Write what this instance derived from one record's bytes — the vector and its model, `matchedText`, `excerpt` — on
 * the version the caller read.
 *
 * `filter` is the caller's own precondition (for an embed job, `atReadSeq`: the write lands on the version it read or on
 * nothing). The liveness question is added here, per `tier`. Stamps no `updatedAt` and no `seq`, whatever it is handed,
 * and refuses a hashed key.
 *
 * **It takes a collection SUFFIX because the embed job is one site for every record kind** (`embedStoredRecord` writes
 * the collection of whichever kind it was handed). Splitting that into a file writer and a record writer would make the
 * same update exist twice, and the copy that forgot the file question is exactly what this module exists to prevent.
 * The suffix rather than a whole name is deliberate: a write through a bare variable cannot be attributed to a space's
 * collection at all, so this module's own write would have been the one the gate below it could not see.
 *
 * @throws when `set` or `unset` names a field the divergence hash sees, or when a derived row names no parent
 */
export async function writeDerivedFields(o: {
  spaceId: string;
  /** The collection the row lives in, as a space-collection suffix (`files`, `facts`, ...). */
  collectionSuffix: SpacePart;
  tier: FileRowTier;
  /** The row's own precondition, including its `_id`. */
  filter: Record<string, unknown>;
  /** Required when `tier` is `derived`: the file the row came from, whose liveness decides the write. */
  parentFileId?: string | undefined;
  set?: Record<string, unknown>;
  unset?: Record<string, unknown>;
}): Promise<DerivedWriteOutcome> {
  const { spaceId, collectionSuffix, tier, filter, parentFileId, set, unset } = o;
  refuseHashed('writeDerivedFields', [...Object.keys(set ?? {}), ...Object.keys(unset ?? {})]);
  /*
   * A FILE THAT IS GONE DROPS WHAT A WRITE WOULD ADD AND KEEPS WHAT IT WOULD REMOVE.
   *
   * The guard exists to stop a job landing what the bytes made on a row whose file has been deleted. A REMOVAL is the
   * opposite of that: a chunk whose parent is gone is an orphan, and taking its vector away is what a deleted file's
   * own strip would have done had it been able to see the row. Refusing the whole write would leave the orphan
   * searchable — which is how the first version of this guard turned the suppressed branch of the embed job, whose
   * whole purpose is to remove a stale vector, into a no-op.
   */
  const live = tier !== 'derived' || await parentIsLive(spaceId, requireParent(parentFileId));
  const adds = set && Object.keys(set).length > 0 ? set : undefined;
  const removes = unset && Object.keys(unset).length > 0 ? unset : undefined;
  if (!live && removes === undefined) return 'gone';
  const r = await col(spaceCollection(spaceId, collectionSuffix)).updateOne(
    asFilter({ ...filter, ...(tier === 'top-level' ? NOT_A_FLAGGED_ROW : {}) }),
    asUpdate({
      ...(live && adds ? { $set: adds } : {}),
      ...(removes ? { $unset: removes } : {}),
    }),
  );
  return r.matchedCount === 0 ? 'superseded' : 'written';
}

/**
 * Store a row DERIVED from a file — a conversion chunk, an image caption, a transcript segment, a face — as a whole
 * document, upserted so a retry after a partial failure re-runs cleanly.
 *
 * The parent's liveness is the precondition, and `gone` means the file was deleted while the job ran: the row is not
 * created, which is what the delete had already decided. The upsert is why the check cannot be a predicate in the
 * filter — a non-matching filter on `replaceOne(upsert: true)` INSERTS rather than skipping, which is how a guard put
 * there would have created exactly the row it meant to refuse.
 */
export async function upsertDerivedFileRow(spaceId: string, doc: FileMetaDoc): Promise<DerivedWriteOutcome> {
  const parentFileId = doc.parentFileId;
  if (parentFileId === undefined) throw new Error('upsertDerivedFileRow: a derived row names the file it came from');
  if (!await parentIsLive(spaceId, parentFileId)) return 'gone';
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).replaceOne(
    asFilter<FileMetaDoc>({ _id: doc._id }), asDoc<FileMetaDoc>(doc), { upsert: true },
  );
  return 'written';
}

/**
 * Store the rows a CONVERSION derived from one file — its passages, and the images it extracted — replacing whatever a
 * previous run of the same conversion left.
 *
 * Replace-by-id rather than a bare insert, for two reasons the pipeline paid for: a transaction aborts on its first
 * duplicate key (the old `ordered: false` tolerance cannot exist inside one), and a write conflict makes
 * `withTransaction` run its callback again from the top.
 *
 * **The caller holds the LEASE and this reads the FLAG, and the two are not the same question.** The lease
 * (`writeUnderClaim`) is coordination: it stops a job whose claim another worker has taken, early and cheaply. The flag
 * is the DATA's own answer to "is this file still here", and it is the authoritative one — a row flagged by a delete
 * that never touched the lease (an operator's own write, a peer's tombstone applied) is invisible to the claim and
 * decisive here. Where both are in force the lease usually fires first, which costs nothing; where only one can, this
 * is the one that must.
 */
export async function replaceDerivedFileRows(
  spaceId: string,
  parentFileId: string,
  docs: readonly FileMetaDoc[],
  opts: { session?: ClientSession; batch: number } ,
): Promise<DerivedWriteOutcome> {
  if (docs.length === 0) return 'written';
  if (!await parentIsLive(spaceId, parentFileId)) return 'gone';
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const { session } = opts;
  for (const slice of inChunks(docs, opts.batch)) {
    await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: slice.map(d => d._id) } }), { session });
    await files.insertMany(slice.map(d => asDoc<FileMetaDoc>(d)), { session });
  }
  return 'written';
}

/**
 * Store the EXCERPT a conversion derived from a document's own opening prose.
 *
 * It is local (the hash does not see it), so it stamps neither `seq` nor `updatedAt`, and it goes in even where a person
 * has written their own description: it is the document's own text rather than a competing summary, and it is what makes
 * a remembered phrase find the record. The embed job is re-queued because the excerpt is part of the file's embed text.
 */
export async function setDerivedExcerpt(spaceId: string, filePath: string, excerpt: string): Promise<DerivedWriteOutcome> {
  const _id = toDocId(filePath);
  const outcome = await writeDerivedFields({
    spaceId, collectionSuffix: 'files', tier: 'top-level', filter: { _id }, set: { excerpt },
  });
  if (outcome === 'written') await enqueueEmbedJob(spaceId, 'file', _id, { priority: EMBED_PRIORITY.write });
  return outcome;
}

/**
 * Rewrite the derived content of a row that already exists — the video re-embed, which replaces a transcript segment's
 * text and vector with the keyframe captions that overlap it.
 *
 * `updatedAt` is accepted here and nowhere else in this module, because a derived row is never hashed: it carries no
 * authored half, and its `updatedAt` is a local note of when the pipeline last touched it.
 */
export async function updateDerivedFileRow(
  spaceId: string, rowId: string, parentFileId: string, set: Record<string, unknown>,
): Promise<DerivedWriteOutcome> {
  if (!await parentIsLive(spaceId, parentFileId)) return 'gone';
  const r = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
    asFilter<FileMetaDoc>({ _id: rowId }), asUpdate<FileMetaDoc>({ $set: set }),
  );
  return r.matchedCount === 0 ? 'superseded' : 'written';
}

/**
 * Record what this instance did with the bytes of one or several top-level file rows.
 *
 * Sets only the fields named, never `updatedAt` and never `seq`; a field given as `undefined` is removed. A key that is
 * not a processing field, or that the hash sees, THROWS: that is a programming error the type already refuses, and
 * running on it would put a hashed field back on a status mark. An empty state throws too — nothing to record.
 *
 * A row a soft delete flagged takes no mark: the file is deleted, so there is no progress on it to record.
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
  refuseHashed('setFileProcessingState', given);
  for (const key of given) {
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
    asFilter<FileMetaDoc>({ _id: ids.length === 1 ? ids[0]! : { $in: ids }, ...NOT_A_FLAGGED_ROW }),
    asUpdate<FileMetaDoc>({
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    }),
  );
}

/**
 * The decline {@link setDerivedDescriptionIfUnset} says out loud, keyed per space and row: a retry of the same job does not
 * repeat it, a different row is said again, and a restart says each once more. A boolean latch would mute every row after
 * the first, which is the one-row-reported-and-the-rest-invisible shape a `warnOnce` exists to prevent.
 */
const saidPeerDelivered = warnOnce<string>();

/**
 * Store a description DERIVED from a file's bytes, only where the operator has not written one — decided by the
 * DATABASE, in one operation. The one derived write of a field the hash sees.
 *
 * Returns whether it wrote, so a caller can log the difference rather than infer it. **False is routine, not a
 * failure**: a person's description is already there, the file was authored by another instance, it has no author
 * and a peer delivered it, there is no row for the path, or the row is the audit record of a deleted file. Only the
 * author-less peer-delivered case is said, because it is the only one with nothing else to show for it.
 *
 * ## Why this is not `updateFileMeta` with a read in front of it
 *
 * The media worker used to do exactly that: `findOne`, compute `operatorWrote` from the result, then write on that
 * decision. The intent was right and documented — *"Only the description itself is theirs to keep"* — but a
 * read-modify-write cannot win the race it exists to win. An operator PATCH landing between the read and the write was
 * silently overwritten by the derived text, and nothing reported it: no field is missing, no status is wrong, the
 * description is simply somebody else's.
 *
 * Same shape as the 2.5.1 embedding defect, which computed a vector from the record *as the write had read it*.
 *
 * The filter carries the condition, so MongoDB arbitrates: if the stored description became non-empty in the meantime,
 * the update matches nothing and the operator's text stands. `^\s*$` rather than `''` because the guard it replaces
 * used `.trim()`, and a whitespace-only description was treated as absent.
 *
 * ## Why the author clause (`Q-143`)
 *
 * A description is hashed and replicates by `seq`. Derived on a RECEIVER it either stamps a seq that outranks the
 * publisher's next edit, or — unstamped — can never replicate and reports a divergence for ever. The publisher derives
 * its own from the same bytes, and that one travels.
 */
export async function setDerivedDescriptionIfUnset(
  spaceId: string,
  filePath: string,
  description: string,
  /**
   * Where the text came from, stored beside it as `descriptionSource`. Omitted leaves the marker UNSET and removes a
   * stored one, because a caller that does not say where a derived description came from must not leave the previous
   * marker standing over new text.
   */
  descriptionSource?: MachineMadeSource,
): Promise<boolean> {
  const _id = toDocId(filePath);
  const self = authorRef().instanceId ?? null;
  /**
   * The conditions — built from named PARTS, and every filter below is a combination of them.
   *
   * Written once, deliberately. The first version of the pre-read below spelled them again as a JS predicate over the
   * row, and the two disagreed immediately: a stored `author.instanceId` of `null` on an instance with none
   * configured matches this filter (`{field: null}` matches null AND missing) and fails `===`, so every file was
   * declined. One rule, two implementations.
   */
  // Never onto the audit record of a deleted file: the flag write strips a machine-made description, so a flagged row
  // SATISFIES the "no description" condition, and this write would put derived text back on it and stamp it a seq —
  // which the flag itself deliberately does not do.
  const thisRow = { _id, ...NOT_A_FLAGGED_ROW };
  const noDescription = { $or: [
    { description: { $exists: false } },
    { description: null },
    // Built from a RegExp rather than a string literal, because `'^\s*$'` in a JS string is `^s*$` — the backslash is
    // dropped and the pattern matches "sss" instead of whitespace. It did exactly that here, and the whitespace-only
    // assertion is what caught it. A RegExp literal cannot lose the escape.
    { description: { $regex: /^\s*$/ } },
  ] };
  /*
   * WHOSE ROW IT IS. This instance's by authorship, or — for a row with no author at all, written before authorship was
   * stamped — this instance's only when no PEER delivered it (E4 item 3, `Q-280`). An author-less row a peer delivered
   * is the publisher's, and a description derived on it here is the `Q-143` defect: it stamps a seq that outranks the
   * publisher's next edit, or never replicates and reports a divergence for ever.
   *
   * `deliveredBy`, not `syncBase`: any peer metadata arrival sets `deliveredBy`, while `syncBase` is set only by the
   * bytes pull, so a row whose metadata arrived and whose bytes never did carries one and not the other. And through
   * `sync/delivered-by.ts`, because `''` is "nobody's delivery" — the back-fill stamps it on every author-less local row
   * — and a hand-written `$exists: false` would decline every one of those.
   */
  const unauthored = { author: { $exists: false } };
  const ours = { $or: [{ 'author.instanceId': self }, { ...unauthored, ...notDeliveredByAPeer(self) }] };

  const writable = asFilter<FileMetaDoc>({ ...thisRow, $and: [noDescription, ours] } as never);

  /*
   * ANSWERED BEFORE A NUMBER IS TAKEN (`withSeqWhen`). Every one of this write's declines is routine — a person's
   * description is there, the row is another instance's, there is no row, the row is flagged — and the allocator moves
   * the counter before the write runs, so each decline used to leave the space counter naming a seq no record holds.
   *
   * The read asks whether a number is worth taking; the WRITE asks the same filter again, which is what decides the
   * race a person's description can win in between.
   */
  const r = await withSeqWhen(
    spaceId,
    async () => {
      const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
      if (await files.findOne(writable, { projection: { _id: 1 } }) !== null) return true;
      /*
       * One decline is SAID, the one the narrowing above introduced: an author-less row a peer delivered. Every other
       * decline existed before and is routine; this one turns an old peer-delivered file into one that stays
       * description-less on this instance with nothing to read, so an operator wondering why needs the line. Asked
       * only on a decline, of the same parts, so it cannot describe a different row from the one the write refused.
       */
      const peerDelivered = asFilter<FileMetaDoc>(
        { ...thisRow, $and: [noDescription, { ...unauthored, ...deliveredByAPeer(self) }] } as never,
      );
      // `deliveredBy` is local-only (`sync/local-only-fields.ts`), so `FileMetaDoc` does not declare it.
      const theirs = await files.findOne(peerDelivered, { projection: { _id: 1, deliveredBy: 1 } }) as { deliveredBy?: unknown } | null;
      if (theirs) {
        saidPeerDelivered(`${spaceId}\u0000${_id}`, () => log.warn(
          `No derived description for ${peerText(spaceId)}/${peerText(filePath)}: it has no author and was delivered by `
          + `peer ${peerText(theirs.deliveredBy)}, so it is the publisher's to describe, not this instance's. The `
          + `publisher's own description arrives by sync; a person can still write one here.`,
        ));
      }
      return false;
    },
    (seq) => col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(writable, asUpdate<FileMetaDoc>({
      // `P-32`: an authored write, so it advances the space counter and pages to a peer.
      $set: { description, updatedAt: new Date().toISOString(), seq, ...(descriptionSource ? { descriptionSource } : {}) },
      ...(descriptionSource ? {} : { $unset: { descriptionSource: '' } }),
    })),
    'file.describe',
  );
  return (r?.modifiedCount ?? 0) > 0;
}

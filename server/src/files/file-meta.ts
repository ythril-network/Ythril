/**
 * File metadata persistence layer.
 *
 * Each space has a `{spaceId}_files` MongoDB collection that records a
 * FileMetaDoc for every file managed by the space file store.  These
 * records are created / updated on every write, removed on deletion, and
 * have their `path` / `_id` updated on move / rename.
 *
 * The collection is intentionally separate from the disk operations in
 * files.ts so that callers (API routes + MCP router) can control exactly
 * when metadata is persisted, consistent with the existing tombstone
 * pattern in api/files.ts.
 */

import { toDocId } from '../util/paths.js';
import { escapeRegex } from '../util/redos.js';
import { authorRef } from '../config/author.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { writeInOneCommands } from '../db/one-command.js';
import { readRowsById } from '../db/read-by-id.js';
import { reconcileLinks, removeLinksFrom, assertDesiredLinks } from '../brain/links.js';
import { linksStartingFrom } from '../brain/link-adjacency.js';
import { withSeq } from '../util/seq.js';
import { expiryForCreate } from '../brain/ttl.js';
import { enqueueEmbedJob, EMBED_PRIORITY } from '../brain/embed-queue.js';
import { embedArrivedFiles } from '../sync/embed-arrived-files.js';
import { mergePropertiesOrKeep } from '../brain/merge-fields.js';
import { rekeyedRow, stampOfArrival } from '../sync/local-only-fields.js';
import { NEVER_RETURNED_PROJECTION } from '../brain/read-projection.js';
import { peerFileKey } from './sandbox.js';
import { getConfig } from '../config/loader.js';

/**
 * The optional fields a `deleteFields` path may clear on a file's metadata record.
 *
 * ## Why the link half is DERIVED and the rest is not
 *
 * A file's link arrays are whatever `LINK_CLASSES` says a file points at — three today (`entityIds`,
 * `memoryIds`, `chronoIds`), and one of them was added after this mechanism shipped. A field that is
 * SETTABLE and missing from this list is accepted at the door and then silently does nothing, which is the
 * exact failure `validateDeleteFields` exists to prevent at the other end. So a seventh link class must not
 * depend on somebody remembering this file.
 *
 * **THE THREE LINK CLASSES ARE NOT HERE, and they used to be — derived from `LINK_CLASSES`.** 5.0 removed
 * the arrays, so a file's links are not fields on it and `deleteFields` has nothing to clear: detaching a
 * class is `linkEntities: []` or one of its two siblings, which says the same thing in the vocabulary that
 * still exists. What is left are this record's own optional fields, which have no list to derive from.
 */
export const DELETABLE_FILE_META_FIELDS: readonly string[] = [
  'description', 'excerpt', 'tags', 'properties',
];
import { applyDeleteFields } from '../brain/delete-fields.js';
import type { FileMetaDoc, AuthorRef } from '../config/types.js';
import type { Filter } from 'mongodb';
import { spaceCollection } from '../db/space-collection.js';
import { isLocalFileField } from './derived-fields.js';
import { LIVE_FILE_ROW, NOT_A_FLAGGED_ROW } from './live-file-row.js';




// `resolveEntityNames` lived here, used only to build embedding text. That job moved to `buildEmbedText`,
// which resolves the names itself from the STORED record — so keeping a second resolver here would be a
// spare copy waiting to be reached for, and the last spare copy in this file is what let its embedding text
// drift from `updateFileMeta`'s.

/**
 * Create or update the metadata record for a file after a write.
 * On first write `createdAt` is set; subsequent writes update `updatedAt` and
 * `sizeBytes`.  `description`, `tags`, and `properties` are only updated when supplied.
 */
export async function upsertFileMeta(
  spaceId: string,
  filePath: string,
  sizeBytes: number,
  opts: { description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; ttlDays?: number | null; sha256?: string } = {},
): Promise<void> {
  const normalised = toDocId(filePath);
  const now = new Date().toISOString();

  const existing = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).findOne(
    asFilter<FileMetaDoc>({ _id: normalised }),
  );

  // The embedding is ENQUEUED after the write, for the same reason as `updateFileMeta` below.
  //
  // This path had a second defect on top of the stale read, and it is the one worth naming: the text it
  // built omitted `excerpt` entirely — a converted document's own opening prose — while `updateFileMeta`
  // included it. So a re-upload silently dropped that prose out of the file's vector, and the only symptom
  // was that a document stopped being findable by its own opening words. Three copies of "what goes into a
  // file's embedding" existed and two of them disagreed; `buildEmbedText` is now the only one.
  if (existing) {
    // `P-32`: an authored write advances the space counter, which is what pages this record to a peer.
    // A re-upload can change the description, the tags and the properties, so it is an authored write.
    const $set: Record<string, unknown> = { updatedAt: now, sizeBytes };
    if (opts.description !== undefined) $set['description'] = opts.description;
    if (opts.tags !== undefined) $set['tags'] = opts.tags;
    if (opts.properties !== undefined) $set['properties'] = opts.properties;
    // Only when stated. A writer that does not compute a hash must not erase the one already there — that would
    // turn "unknown" into a permanent state and the skip below into dead code.
    if (opts.sha256 !== undefined) $set['sha256'] = opts.sha256;
    // A write to a soft-deleted path means the file is live again — clear the flag.
    const $unset: Record<string, unknown> = { deletedAt: '' };
    // Only an EXPLICIT ttlDays on a re-upload touches expiry: >0 (re)stamps, 0/null clears it. A plain
    // overwrite (ttlDays omitted) leaves any existing TTL untouched — it must not silently reset.
    if (opts.ttlDays !== undefined) {
      const expireAt = expiryForCreate(spaceId, opts.ttlDays, { collection: 'file' });
      if (expireAt) $set['_expireAt'] = expireAt; else $unset['_expireAt'] = '';
    }
    await withSeq(spaceId, (seq) => col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
      asFilter<FileMetaDoc>({ _id: normalised }),
      asUpdate<FileMetaDoc>({ $set: { ...$set, seq }, $unset }),
    ), 'file.upsert');
  } else {
    // A per-record ttlDays wins; otherwise the space's `file` retention bucket applies. Files have their OWN
    // bucket rather than sharing one with a knowledge collection: they are the largest and most obviously
    // disposable of the five, and they have no type, so the schema tier cannot reach them.
    const expireAt = expiryForCreate(spaceId, opts.ttlDays, { collection: 'file' });
    await withSeq(spaceId, (seq) => {
      const doc: FileMetaDoc = {
        _id: normalised,
        spaceId,
        path: normalised,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        tags: opts.tags ?? [],
        ...(opts.properties !== undefined ? { properties: opts.properties } : {}),
        createdAt: now,
        updatedAt: now,
        sizeBytes,
        ...(opts.sha256 !== undefined ? { sha256: opts.sha256 } : {}),
        author: authorRef(),
        seq,
        ...(expireAt ? { _expireAt: expireAt } : {}),
      };
      return col<FileMetaDoc>(spaceCollection(spaceId, 'files')).insertOne(asDoc<FileMetaDoc>(doc));
    }, 'file.upsert');
  }

  // Both branches, unconditionally. A create enqueues for the reason every brain create does — the write
  // should not pay the model's latency — and an update for the correctness reason above.
  await enqueueEmbedJob(spaceId, 'file', normalised, { priority: EMBED_PRIORITY.write });
}

/**
 * Record bytes a PEER sent for a file: the local machinery only, never an authored write (`Q-143`).
 *
 * The file-sync pull used `upsertFileMeta`, the upload writer, and so stamped this instance's next `seq` on a file it
 * did not author — after which its copy outranked the publisher's, and the publisher's next description or tag edit
 * was skipped on arrival. An upload is a person changing the content; bytes arriving are not.
 *
 * A known record gets its size and hash. A record the metadata has not reached yet is created at `seq` 0 and
 * authored by the peer, so the first authored metadata to arrive replaces it whatever its `seq`.
 *
 * `filePath` is the PEER's text and is resolved here, by the one resolver (`peerFileKey`, Q-404): the bytes were written at the
 * resolved path, and a row keyed by the spelling (`x/../k.txt`) is one nothing ever reads again. A caller that already holds the
 * key passes it — resolving a key gives the key.
 */
export async function recordArrivedFile(
  spaceId: string,
  filePath: string,
  sizeBytes: number,
  sha256: string,
  from: AuthorRef,
): Promise<void> {
  const { key: normalised } = await peerFileKey(spaceId, filePath);
  const now = new Date().toISOString();
  // A record NEW here takes this instance's file retention window, as an upload does; one already stored keeps its
  // expiry, because arriving bytes are not an authored write and must not re-slide it.
  const expireAt = expiryForCreate(spaceId, undefined, { collection: 'file' });
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
    asFilter<FileMetaDoc>({ _id: normalised }),
    asUpdate<FileMetaDoc>({
      $set: { sizeBytes, sha256 },
      // Bytes on disk mean the file is live: a path soft-deleted here and re-created upstream comes back, as the
      // upload writer has always made it (`Q-239`).
      $unset: { deletedAt: '' },
      $setOnInsert: {
        spaceId, path: normalised, tags: [], author: from, createdAt: now, updatedAt: now, seq: 0,
        // On INSERT only, by whom these bytes arrived (`deliveredBy`, bundle-51): a record new here is delivered by the peer
        // whose bytes created it. A known row keeps its stamp — an upstream pushing bytes to a path this instance wrote, or
        // that another peer delivered, gains nothing over it.
        // Never an absent key (`stampOfArrival`): a row stamped with nothing is a row nobody can say who delivered.
        deliveredBy: stampOfArrival({ restore: false, doc: {}, deliveredBy: from.instanceId }),
        ...(expireAt ? { _expireAt: expireAt } : {}),
      },
    } as never),
    { upsert: true },
  );
  // A peer's bytes, not a local write: queued in the background lane, and by the RECEIVER's rules — the same step
  // every arriving file's metadata takes, so a file this instance suppresses is not queued and holds no vector
  // (bundle-30 I6, D3: this called `enqueueEmbedJob` directly, past the suppression check).
  await embedArrivedFiles(spaceId, [normalised]);
}

/**
 * Is this file row what `recordArrivedFile` makes: a placeholder that arriving bytes created, with nothing authored in it?
 *
 * The shape that function writes is version 0 and an author that is only the deliverer (`author.instanceId` = `deliveredBy`,
 * by lack of anyone else). It is asked HERE, beside the writer, so the rule that recognises the row cannot drift from the code
 * that makes it: the deletion authority reads such a row as authorless (`fileTargetOf`, Q-405), and a second spelling of the
 * shape would stop recognising a placeholder the moment the writer's shape changed, leaving the file's origin unable to delete it.
 * A row anything has authored (metadata at a seq above 0, or at 0 from an author who is not the deliverer) is not one.
 */
export function isArrivedPlaceholder(row: { seq?: number; author?: { instanceId?: string }; deliveredBy?: string }): boolean {
  const author = row.author?.instanceId;
  return row.seq === 0 && author !== undefined && author !== '' && author === row.deliveredBy;
}


/**
 * Read one file-metadata record by path, or null.
 *
 * Exists for the audit before-snapshot: `updateFileMeta` reads the same document internally but returns
 * only the new one, and the audit change list needs the prior state. Kept as a plain getter rather than
 * changing that signature, so nothing else has to care.
 */
export async function getFileMeta(spaceId: string, filePath: string): Promise<FileMetaDoc | null> {
  return await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    // A deleted file's audit record is not a file record: every door that reads one through here — the inspect route,
    // the audit before-snapshot, the extract route's parent — must answer "not found", as it does for a hard delete.
    .findOne(asFilter<FileMetaDoc>({ _id: toDocId(filePath), ...NOT_A_FLAGGED_ROW }), { projection: NEVER_RETURNED_PROJECTION }) as FileMetaDoc | null;
}

/**
 * Partially update the metadata record for a file (tags, description,
 * entity/chrono/fact linkage, properties).  Re-embeds the record on
 * every successful update.  Returns the updated document, or null if the
 * record does not exist.
 */
export async function updateFileMeta(
  spaceId: string,
  filePath: string,
  opts: {
    description?: string;
    tags?: string[];
    /**
     * The entities, chrono entries and facts this file links to — DESIRED LINK SETS, never stored fields.
     *
     * They were `entityIds`, `chronoIds` and `memoryIds`, and they were both: written onto the record AND
     * handed to `reconcileLinks`. 5.0 removes the arrays, so these are the input and the link records are
     * the storage. Each named class is REPLACED wholesale; an omitted one is untouched.
     */
    linkEntities?: string[];
    linkChronos?: string[];
    linkFacts?: string[];
    properties?: Record<string, string | number | boolean>;
  },
  /** Dot-notation paths to remove, applied AFTER the merge — the only way to unset. See the block below. */
  deleteFieldsPaths?: string[],
): Promise<FileMetaDoc | null> {
  /*
   * REFERENCES ARE VALIDATED HERE, so a caller cannot reach the collection around the check.
   *
   * The existence check sat only at the two API doors (`api/brain/file-meta.ts` and `mcp/tools/file.ts`),
   * which meant `strictLinkage`'s promise — that a stored reference resolves — held only for callers who
   * remembered it. `files/media/face-embedder.ts` calls this function directly to attach an auto-labelled
   * face's entity, and was never checked. The id comes from a live match so it resolves in practice, but
   * the guarantee was structural in name only.
   *
   * It is `assertDesiredLinks` now — one assertion for the class AND the existence, shared with every
   * other writer, and made before the record is touched so a refusal cannot leave a half-applied update.
   *
   * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate."* Same shape as the
   * `upsertEdge` fix, one record type over.
   *
   * Existence is gated on `isStrictLinkage` exactly as the doors were, so a space that opted out is
   * unaffected — the setting exists for staged imports where targets are resolved in a later pass, and
   * moving the check must not quietly withdraw that. The CLASS check is not gated: a file cannot link to
   * another file whatever the space says.
   */
  // The one assertion every writer makes before it writes — class and existence, from `links.ts`.
  await assertDesiredLinks(spaceId, 'file', {
    ...(opts.linkEntities !== undefined ? { entity: opts.linkEntities } : {}),
    ...(opts.linkFacts !== undefined ? { fact: opts.linkFacts } : {}),
    ...(opts.linkChronos !== undefined ? { chrono: opts.linkChronos } : {}),
  });

  const normalised = toDocId(filePath);
  // The flag is read HERE, where the edit is decided, so every write below it is governed by one read: a flagged row
  // returns null and the doors answer 404. Editing one would write a description, tags and properties onto an audit
  // record, re-queue the embed job the strip removed, and reconcile links off a file that is gone.
  const existing = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: normalised, ...NOT_A_FLAGGED_ROW })) as FileMetaDoc | null;
  if (!existing) return null;

  const now = new Date().toISOString();

  // The re-embed is ENQUEUED after the write — see `embedStoredRecord`, and the note on
  // `BrainEmbedRecordType` for why `file` is in that union at all.
  //
  // This function used to build the text here, from `existing` plus `opts`, and spread the result into
  // `$set` UNCONDITIONALLY while every content field below is guarded by `opts.X !== undefined`. So two
  // concurrent writes to different fields both landed and lost no field — and each wrote a whole embedding
  // describing only its own view, leaving the stored vector describing a record that existed nowhere. There
  // was nothing to notice it with: a file row's `seq` advances only on an AUTHORED write, so a derived-field
  // write leaves it where it was and no precondition on it could have been violated — unlike the four brain
  // types, whose seq advances on every write and which had the identical defect.
  const $set: Record<string, unknown> = { updatedAt: now };
  if (opts.description !== undefined) $set['description'] = opts.description;
  if (opts.tags !== undefined) $set['tags'] = opts.tags;

  /**
   * `properties` MERGES, as it does on all four brain record types (X-6).
   *
   * It replaced until now, and `brain/fact.ts` records what that costs, because the same defect was found
   * and fixed there first: *"An agent patching one key silently destroyed every other property on the record,
   * with no error anywhere."* The sweep that reached fact, chrono, entity and edge did not reach this file,
   * so five tools that take the same-looking arguments had one that behaved differently.
   *
   * Removing a key is `deleteFields`' job below — an absence never means "delete", here or anywhere else.
   *
   * **Callers who send the whole object are unaffected**, which until now was the only thing that worked.
   */
  const mergedProps = mergePropertiesOrKeep(existing.properties, opts.properties);
  if (opts.properties !== undefined) $set['properties'] = mergedProps;

  // A description written WITHOUT declaring a source is a person's own words — the API and the UI edit
  // it that way — so the old provenance has to go with it. Leaving a stale `generated` behind would have
  // the record claim a model wrote what an operator just typed, which is the one thing this field exists
  // to stop being ambiguous.
  const $unset: Record<string, ''> = {};
  // A description given here is a CALLER's, never a derived one (the derived writer is `setDerivedDescriptionIfUnset`,
  // which sets the marker itself), so the stale provenance always goes with it.
  if (opts.description !== undefined) $unset['descriptionSource'] = '';

  /**
   * `deleteFields`, applied AFTER the merge — the same shape and order as the four brain writers.
   *
   * It arrives WITH the merge above and not after it, because the merge alone would have removed the only
   * way a file property could be cleared. Shipping them apart would have traded one silent data loss for a
   * stale key nobody can delete.
   *
   * Every optional field is in the reflect list. A field accepted at the edge and missing here is accepted
   * and then does nothing, which is the failure `validateDeleteFields` exists to prevent at the other end.
   */
  if (deleteFieldsPaths && deleteFieldsPaths.length > 0) {
    const merged: Record<string, unknown> = {
      description: opts.description !== undefined ? opts.description : existing.description,
      excerpt: existing.excerpt,
      tags: opts.tags ?? existing.tags,
      properties: mergedProps ?? {},
    };
    applyDeleteFields(merged, deleteFieldsPaths);

    for (const field of DELETABLE_FILE_META_FIELDS) {
      if (!(field in merged)) {
        $unset[field] = '';
        delete $set[field];
      } else if (deleteFieldsPaths.some(p => p === field || p.startsWith(field + '.'))) {
        $set[field] = merged[field];
      }
    }
  }

  // `P-32`: the only writer of a file's three link arrays, its tags, its description and its properties —
  // every one of them authored, so a write touching any of them advances the space counter and pages the record to
  // a peer. A write touching only local fields (`isLocalFileField`: what the hash does not see, such as the media
  // worker's excerpt) is not authored and stamps nothing: on a receiver, a stamp made its copy outrank the publisher's
  // next edit (`Q-143`).
  const linksGiven = opts.linkEntities !== undefined || opts.linkFacts !== undefined || opts.linkChronos !== undefined;
  const authored = linksGiven
    || [...Object.keys($set), ...Object.keys($unset)].some(k => k !== 'updatedAt' && !isLocalFileField(k));
  if (!authored) delete $set['updatedAt'];
  const write = (seq?: number) => {
    const set = seq === undefined ? $set : { ...$set, seq };
    const update = {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    };
    return Object.keys(update).length === 0 ? Promise.resolve() : col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
      .updateOne(asFilter<FileMetaDoc>({ _id: normalised }), asUpdate<FileMetaDoc>(update)).then(() => undefined);
  };
  if (authored) await withSeq(spaceId, write, 'file.update');
  else await write();

  // ONE enqueue, unconditionally, after the write. Not gated on which fields moved: any such condition
  // could only be computed from the read above, which is the stale value this change exists to stop using.
  await enqueueEmbedJob(spaceId, 'file', normalised, { priority: EMBED_PRIORITY.write });

  /*
   * A file's THREE classes — the only record kind with all of them, and the only one whose `_id` is a path.
   *
   * Reconciled from the merged values this function computed, and only for the classes the caller named:
   * omitting `chronoIds` on a patch means "leave the chrono links", not "remove them". `updateFileMeta` is
   * also the ONLY writer of these three fields, so this one call covers every door - REST, MCP and the face
   * labeller, which appends through here rather than writing the array itself.
   */
  if (opts.linkEntities !== undefined || opts.linkFacts !== undefined || opts.linkChronos !== undefined) {
    await reconcileLinks(spaceId, normalised, 'file', {
      ...(opts.linkEntities !== undefined ? { entity: opts.linkEntities } : {}),
      ...(opts.linkFacts !== undefined ? { fact: opts.linkFacts } : {}),
      ...(opts.linkChronos !== undefined ? { chrono: opts.linkChronos } : {}),
    }, existing.author ?? authorRef());
  }

  // Face recognition side-effects when entity links change.
  //
  // Two cases:
  //   A) Image not yet processed (no face-chunk records) AND reprocessSyncedImages=true
  //      → enqueue a media job so face embeddings are produced.  Once the job runs, a
  //        subsequent label propagation (case B) may fire automatically via image-embedder.
  //   B) Exactly ONE person-type entity AND exactly ONE face-chunk
  //      → propagate that entity as the face label for the chunk (gallery entry).
  //
  // Non-person entities are invisible to both paths.
  // Examples:
  //   [john(person)]                → case B if 1 face chunk, case A if 0
  //   [john(person), london(loc)]   → london ignored; same as above for john
  //   [john(person), alice(person)] → 2 persons — ambiguous, skip case B; still runs case A
  //   [london(location)]            → 0 persons — skip case B; still runs case A
  if (opts.linkEntities !== undefined && opts.linkEntities.length > 0) {
    try {
      const { getFaceRecognitionConfig } = await import('../config/loader.js');
      const faceCfg = getFaceRecognitionConfig();
      if (faceCfg.enabled) {
        const faceChunkCount = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).countDocuments(
          asFilter<FileMetaDoc>({ parentFileId: normalised, faceEmbedding: { $exists: true } }),
        );

        if (faceChunkCount === 0 && faceCfg.reprocessSyncedImages) {
          // Case A: image not yet processed by face recognizer — enqueue for processing.
          const { resolveInputFormat } = await import('../files/converters/pipeline.js');
          if (resolveInputFormat(normalised) === 'image') {
            const { enqueueMediaJob } = await import('./media/job-queue.js');
            // Shared table. The inline map this replaced defaulted to `image/jpeg`, so any image whose
            // extension it did not list was actively mislabelled rather than merely unknown.
            const { mimeTypeForPath } = await import('./mime.js');
            await enqueueMediaJob(spaceId, normalised, mimeTypeForPath(normalised), 'image');
          }
        } else if (faceChunkCount === 1) {
          // Case B: face chunks exist — propagate label if exactly 1 person entity.
          const entities = await readRowsById<{ _id: string; type: string }>(
            spaceCollection(spaceId, 'entities'), opts.linkEntities, { type: 1 });
          const personEntities = entities.filter(e =>
            faceCfg.personEntityTypes.some(t => t.toLowerCase() === e.type.toLowerCase()),
          );
          if (personEntities.length === 1) {
            const { propagateFaceLabel } = await import('./media/face-embedder.js');
            await propagateFaceLabel(spaceId, normalised, personEntities[0]!._id);
          }
        }
      }
    } catch { /* non-fatal — face side-effects must never block file meta write */ }
  }

  return col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ _id: normalised }), { projection: NEVER_RETURNED_PROJECTION }) as Promise<FileMetaDoc | null>;
}

/** Remove the metadata record when a file is deleted. */
export async function deleteFileMeta(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = toDocId(filePath);
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteOne(
    asFilter<FileMetaDoc>({ _id: normalised }),
  );
}

/**
 * Remove all metadata records whose path starts with `dirPath/`.
 * Used when an entire directory is deleted recursively.
 */
export async function deleteFileMetaByPrefix(
  spaceId: string,
  dirPath: string,
): Promise<void> {
  const norm = toDocId(dirPath).replace(/\/?$/, '');
  if (!norm) return; // guard: empty path would match everything
  const prefix = norm + '/';
  // Escape regex special characters in the prefix so a path like "my.dir/"
  // doesn't accidentally match "myXdir/" etc.
  const escaped = escapeRegex(prefix);
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteMany(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` } }),
  );
}

/**
 * The paths of the live file records at `path` or under `path/` — files only, never their derived records, and never
 * one already soft-deleted. What a delete or move whose bytes have already gone still owes, which is how a retry
 * after a store failure finds the act it has to complete (bundle-30 I14): the record is the marker, and the cascades
 * remove it last.
 */
export async function fileRecordPaths(spaceId: string, path: string): Promise<string[]> {
  const filter = liveFileRecords(path, 'at-or-under');
  if (!filter) return [];
  // `LIVE_FILE_ROW` here as well as in `liveFileRecords`: the predicate belongs to the READ, so a caller handing this
  // function another filter cannot make it answer about a chunk or an audit row.
  const rows = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .find(asFilter<FileMetaDoc>({ ...filter, ...LIVE_FILE_ROW }), { projection: { _id: 1 } }).toArray();
  return rows.map(r => String(r._id));
}

/**
 * Whether any live file record is at `path` or under `path/` — the yes/no form of {@link fileRecordPaths}, read as one
 * record (bundle-30 I15, preship-3 P3-7). A retried move asks it of its source; the list it used to load held every
 * record id under a folder to answer one bit.
 */
export async function hasLiveFileRecordAt(spaceId: string, path: string): Promise<boolean> {
  return anyLiveFileRecord(spaceId, liveFileRecords(path, 'at-or-under'));
}

/**
 * Whether the live file record AT `path` itself exists — not one under it. What a delete of ONE file asks of a path
 * whose bytes are gone: a record the delete is still owed (the bytes went, a store failure stopped the rest) answers
 * yes; a record a soft delete flagged, a derived chunk or face record, and a folder that only has files under it
 * answer no, so a retried delete of a file that is already gone is not found rather than done a second time (Q-343).
 * {@link hasLiveFileRecordAt} is at-or-under and answers a move's question, not this one.
 */
export async function hasLiveFileRecordExactlyAt(spaceId: string, path: string): Promise<boolean> {
  return anyLiveFileRecord(spaceId, liveFileRecords(path, 'exactly-at'));
}

/** Whether any live file record is strictly under `dir/` — what a directory delete a store failure stopped still owes. */
export async function hasLiveFileRecordUnder(spaceId: string, dir: string): Promise<boolean> {
  return anyLiveFileRecord(spaceId, liveFileRecords(dir, 'under'));
}

async function anyLiveFileRecord(spaceId: string, filter: Filter<FileMetaDoc> | null): Promise<boolean> {
  if (!filter) return false;
  // The function is named for LIVE file records, so the predicate is inside it rather than in each caller's filter:
  // every caller passes `liveFileRecords(...)`, and the one that forgets must not get a different answer.
  return (await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    .findOne(asFilter<FileMetaDoc>({ ...filter, ...LIVE_FILE_ROW }), { projection: { _id: 1 } })) !== null;
}

/**
 * The live FILE records of a scope around `path`: `'under'` is under `path/`, `'exactly-at'` is `path` alone and
 * `'at-or-under'` is both. Never a derived record, never a soft-deleted one. `null` for an empty path, which would
 * match everything.
 */
function liveFileRecords(path: string, scope: 'under' | 'exactly-at' | 'at-or-under'): Filter<FileMetaDoc> | null {
  const norm = toDocId(path).replace(/\/?$/, '');
  if (!norm) return null;
  const under = { _id: { $regex: '^' + escapeRegex(norm + '/') } };
  const reach = scope === 'under' ? under : scope === 'exactly-at' ? { _id: norm } : { $or: [{ _id: norm }, under] };
  return asFilter<FileMetaDoc>({ ...reach, ...LIVE_FILE_ROW });
}

/**
 * Soft-delete: flag a single file's metadata record as deleted (`deletedAt = now`)
 * instead of removing it. No-op if the record does not exist, **and for one already flagged**: a deletion that is
 * already recorded is not stamped again, so a second tombstone for the same path — a peer's relayed one beside ours —
 * cannot re-flag the row. Used when `softDeleteFileMeta` is enabled so a deleted file leaves an auditable record.
 *
 * **The flag is LOCAL state, and it stamps no `seq` and no `updatedAt`** (`Q-257`). It used to take a seq "so a peer sees
 * the flag", and a peer never saw one: `deletedAt` is not a wire key, so the row went out stripped of it and landed LIVE,
 * removing the tombstone the peer held for the file — and its seq outranked the tombstone's `rowSeq`, so the file came back
 * on a third peer. The deletion reaches peers as the file TOMBSTONE the delete writes, which each applies by its own
 * setting; the flagged row is this instance's audit record, offered to nobody and hashed by nothing (`LIVE_FILE_ROW`).
 * On a receiver whose bytes later revive the path, a seq of the flag's own would also outrank the publisher's next edit.
 */
export async function markFileMetaDeleted(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = toDocId(filePath);
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).updateOne(
    asFilter<FileMetaDoc>({ _id: normalised, ...LIVE_FILE_ROW }),
    flagAndStrip() as never,
  );
}

/**
 * The ONE write that flags a row and removes everything its bytes made — `Q-418`.
 *
 * ## Why it is one write and not two
 *
 * The flag and the strip have to land together or not at all. As two statements, a crash between them leaves a
 * flagged row still holding its vector and its text, and nothing ever re-runs the strip: the second attempt sees a
 * row that is already flagged and does nothing. So the window is not small, it is permanent.
 *
 * ## Why it is a pipeline
 *
 * Because one of the removals is conditional and a plain `$unset` cannot ask a question. A `description` is the
 * person's when they wrote it and the file's own prose when a conversion produced it, and only the second is made
 * from bytes the space no longer has. `descriptionSource` is what tells them apart, so the description goes exactly
 * when that marker says `generated` or `extracted`, and the marker goes with it — it exists only in that case.
 *
 * ## What goes, and why each
 *
 * The vector and its model, and `matchedText`: the row must not be rankable or findable by text. `excerpt`: a
 * verbatim passage of a document whose bytes are deleted. `sha256`: a fingerprint of those same bytes.
 * `embeddingStatus`: left at `complete` it makes a re-upload of identical bytes skip reprocessing, so a revived path
 * would never be read again.
 *
 * ## What stays, deliberately
 *
 * The audit record: `path`, `author`, `createdAt`, `deletedAt`, the retention stamp, `tags`, `properties`, and a
 * description a person wrote. Those are what somebody deleted, not what the bytes produced.
 */
function flagAndStrip(): object[] {
  const MACHINE_MADE = ['generated', 'extracted'];
  return [
    { $set: { deletedAt: new Date().toISOString() } },
    { $unset: ['embedding', 'embeddingModel', 'matchedText', 'excerpt', 'sha256', 'embeddingStatus'] },
    {
      $set: {
        description: {
          $cond: [{ $in: ['$descriptionSource', MACHINE_MADE] }, '$$REMOVE', '$description'],
        },
      },
    },
    { $unset: ['descriptionSource'] },
  ];
}

/**
 * Take a file's metadata row out of view as this instance is configured to: flag it (`softDeleteFileMeta`, retained for audit)
 * or remove it. The one answer for every row a delete retires — the file's own, and each sidecar row a peer's bytes made at a
 * path under it (`deleteConversionArtifacts`) — so a soft delete cannot flag the first and hard-delete the second.
 */
export async function retireFileMeta(spaceId: string, filePath: string): Promise<void> {
  if (getConfig().softDeleteFileMeta === true) await markFileMetaDeleted(spaceId, filePath);
  else await deleteFileMeta(spaceId, filePath);
}

/**
 * {@link retireFileMeta} for every row under a directory: flag the file rows and remove their derived rows (`softDeleteFileMeta`),
 * or remove them all. The same configured answer as for one row, asked once for the whole subtree, so a directory's delete cannot
 * spell the soft-or-hard choice a second way from a file's.
 */
export async function retireFileMetaUnder(spaceId: string, dirPath: string): Promise<void> {
  if (getConfig().softDeleteFileMeta === true) await markFileMetaDeletedByPrefix(spaceId, dirPath);
  else await deleteFileMetaByPrefix(spaceId, dirPath);
}

/**
 * Soft-delete a whole directory subtree: flag every live top-level file record under
 * `dirPath/` as deleted, and hard-remove the derived chunk records (which carry no
 * independent audit value). The `_converted`/`_extracted` sidecars are cleaned
 * separately by deleteConversionArtifactsByPrefix. As for one file ({@link markFileMetaDeleted}): a row already
 * flagged keeps its first flag, and the flag stamps no `seq` and no `updatedAt` — it is local state.
 */
export async function markFileMetaDeletedByPrefix(
  spaceId: string,
  dirPath: string,
): Promise<void> {
  const norm = toDocId(dirPath).replace(/\/?$/, '');
  if (!norm) return; // guard: empty path would match everything
  const escaped = escapeRegex(norm + '/');
  const coll = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  // Flag the user-visible file records, and strip what their bytes made, in the SAME write — the identical rule as
  // for one file, from the one place that states it. A directory delete reaches here and never through
  // `markFileMetaDeleted`, so a guard written there alone would simply not apply to a folder (`Q-418`).
  await coll.updateMany(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` }, ...LIVE_FILE_ROW }),
    flagAndStrip() as never,
  );
  // Remove derived chunk records outright.
  await coll.deleteMany(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` }, parentFileId: { $exists: true } }),
  );
}

/**
 * Move/rename the metadata record to a new path.
 * If no record exists for `srcPath` the call is a no-op (e.g. plain
 * directory moves where individual file records don't need renaming).
 */
export async function renameFileMeta(
  spaceId: string,
  srcPath: string,
  dstPath: string,
): Promise<void> {
  const normSrc = toDocId(srcPath);
  const normDst = toDocId(dstPath);
  if (normSrc === normDst) return;

  // A flagged source is not moved: the audit record of a deleted file belongs to the path it was deleted at, and
  // re-keying it onto the destination would make it claim a path that now holds another file's bytes.
  const existing = await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).findOne(
    asFilter<FileMetaDoc>({ _id: normSrc, ...NOT_A_FLAGGED_ROW }),
  );
  if (!existing) return;

  // MongoDB does not allow updating _id; delete + re-insert with new path.
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteOne(asFilter<FileMetaDoc>({ _id: normSrc }));
  // `rekeyedRow`: a row under a NEW id is written here, so it is stamped as nobody's delivery and carries none of what this
  // instance agreed with its peers about the OLD path (`syncBase`) — a peer that delivered the old path cannot retire the new one.
  //
  // **It keeps the stored `updatedAt`** (`Q-419`). This insert stamps no `seq`: the row arrives under a new id with the
  // seq it already had. Writing a fresh `updatedAt` beside an unchanged seq is precisely the drift this bundle exists to
  // remove — and it is worse on a PEER-authored row, where it leaves another instance's seq and author next to this
  // instance's clock, which no peer can order and a merkle check reports every cycle for a space where nothing is wrong.
  // Measured before the fix: a move of a peer-authored row moved `updatedAt` by five weeks while its seq stood still.
  // One rule for every row rather than a branch on who authored it, because the argument does not depend on the author:
  // a write that does not stamp a version must not move the timestamp that version is read beside.
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).insertOne(asDoc<FileMetaDoc>(rekeyedRow(existing, {
    _id: normDst,
    path: normDst,
  })));

  await carryFileLinks(spaceId, normSrc, normDst, existing.author ?? authorRef());
}

/**
 * Move every link a file holds from its old path to its new one — for a single rename and for each file of a
 * directory move alike (`Q-164`).
 *
 * A file's `_id` IS its path, so a move changes the identity every `file.*` link hangs off, and without this the
 * links would still name the OLD path: a `from` pointing at a record that no longer exists. The single-file rename
 * carried them inline; the directory move re-rooted the records and did not, so every file in a moved directory
 * lost its links in silence. One function now, so the next move path cannot forget the step.
 *
 * READ THE LINK ROWS FIRST: since 5.0 they are the only record of what the file linked to. Removed from the old id
 * and created under the new one, because a link's id is derived from its `from` — there is no rename of a link,
 * only a delete and a create — and the tombstone the removal writes is what stops a peer restoring the links under
 * the old path on the next pull.
 */
async function carryFileLinks(spaceId: string, fromId: string, toId: string, author: AuthorRef): Promise<void> {
  const carried = await linksStartingFrom(spaceId, [fromId]);
  if (carried.length === 0) return;
  const byKind = { entity: [] as string[], fact: [] as string[], chrono: [] as string[] };
  for (const row of carried) {
    const bucket = byKind[row.toKind as keyof typeof byKind];
    if (bucket) bucket.push(row.to);
  }
  await removeLinksFrom(spaceId, fromId, 'file');
  await reconcileLinks(spaceId, toId, 'file', byKind, author);
}

/**
 * Bulk-rename all metadata records whose path starts with `srcDir/`.
 * Used when an entire directory is moved/renamed so that all child records
 * are re-rooted under the new path.
 *
 * Note: MongoDB does not support updating `_id` in-place, so this uses a
 * delete-then-insert pattern per document.  A concurrent read between the
 * two steps will see missing metadata — acceptable given this is a
 * best-effort metadata store (disk is the source of truth).
 */
export async function renameFileMetaByPrefix(
  spaceId: string,
  srcDir: string,
  dstDir: string,
): Promise<void> {
  const normSrc = toDocId(srcDir).replace(/\/?$/, '');
  const normDst = toDocId(dstDir).replace(/\/?$/, '');
  if (!normSrc || !normDst) return; // guard: empty path would match everything
  const srcPrefix = normSrc + '/';
  const dstPrefix = normDst + '/';
  if (srcPrefix === dstPrefix) return;

  const escaped = escapeRegex(srcPrefix);
  // The files themselves only. Their derived records (chunks, sidecars) are re-rooted by `parentFileId` in
  // `move-cascade.ts`: renamed here by id, a chunk kept the `parentFileId` of a path that no longer existed.
  const docs = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
    // `LIVE_FILE_ROW` rather than the `parentFileId` half spelled out: the flagged audit rows under the old directory
    // stay where they were recorded, and the half-spelling `live-file-row.ts` warns about is gone from here.
    .find(asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` }, ...LIVE_FILE_ROW }))
    .toArray() as FileMetaDoc[];

  if (docs.length === 0) return;

  // Delete existing records and re-insert with updated paths.
  const oldIds = docs.map(d => d._id);
  await col<FileMetaDoc>(spaceCollection(spaceId, 'files')).deleteMany(
    asFilter<FileMetaDoc>({ _id: { $in: oldIds } }),
  );
  // `rekeyedRow` for each, as a single rename does: written here under a new id, stamped as nobody's delivery, and
  // keeping its stored `updatedAt` for the reason given at the single-file rename — this insert stamps no seq.
  const updated = docs.map(d => rekeyedRow(d, {
    _id: dstPrefix + d._id.slice(srcPrefix.length),
    path: dstPrefix + d.path.slice(srcPrefix.length),
  }));
  const filesColl = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  // ONE insert command for anything within the driver's one-command limits, 99 999 rows and 16 MiB (`db/one-command.ts`), as the driver sent it
  // before the write was sliced. The moved directory's metadata is deleted BEFORE this insert, so a set larger than that — several commands — can
  // fail between two of them and leave the later rows deleted and not re-inserted: the limit of delete-then-insert, stated
  // here rather than hidden. Making it insert-first changes what the move does with a destination that is taken, and is owed
  // its own tests against the store.
  await writeInOneCommands(updated.map(d => asDoc<FileMetaDoc>(d)), (slice, { ordered }) => filesColl.insertMany(slice, { ordered }), { ordered: true });
  // Each file's links follow it, exactly as a single rename carries them (Q-164).
  for (let i = 0; i < docs.length; i++) {
    await carryFileLinks(spaceId, docs[i]!._id, updated[i]!._id, docs[i]!.author ?? authorRef());
  }
}

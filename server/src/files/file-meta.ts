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

import path from 'node:path';
import { toDocId } from '../util/paths.js';
import { escapeRegex } from '../util/redos.js';
import { authorRef } from '../config/author.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { assertRefsResolve } from '../brain/entity-refs.js';
import { reconcileLinks, removeLinksFrom } from '../brain/links.js';
import { nextSeq } from '../util/seq.js';
import { isStrictLinkage } from '../spaces/proxy.js';
import { expiryForCreate } from '../brain/ttl.js';
import { enqueueEmbedJob } from '../brain/embed-queue.js';
import { mergePropertiesOrKeep } from '../brain/merge-fields.js';
import { LINK_CLASSES } from '../brain/link-adjacency.js';

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
 * The other four are this record's own optional fields and have no list to derive from — they are named,
 * and `file-meta-merges-like-the-brain-tools.test.js` checks the derived half against `LINK_CLASSES`.
 */
export const DELETABLE_FILE_META_FIELDS: readonly string[] = [
  'description', 'excerpt', 'tags', 'properties',
  ...LINK_CLASSES.filter(c => c.kind === 'file').map(c => c.field),
];
import { applyDeleteFields } from '../brain/delete-fields.js';
import { getConfig } from '../config/loader.js';
import type { FileMetaDoc, AuthorRef, EntityDoc } from '../config/types.js';




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

  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
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
    const $set: Record<string, unknown> = { updatedAt: now, sizeBytes, seq: await nextSeq(spaceId) };
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
    await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
      asFilter<FileMetaDoc>({ _id: normalised }),
      asUpdate<FileMetaDoc>({ $set, $unset }),
    );
  } else {
    // A per-record ttlDays wins; otherwise the space's `file` retention bucket applies. Files have their OWN
    // bucket rather than sharing one with a knowledge collection: they are the largest and most obviously
    // disposable of the five, and they have no type, so the schema tier cannot reach them.
    const expireAt = expiryForCreate(spaceId, opts.ttlDays, { collection: 'file' });
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
      seq: await nextSeq(spaceId),
      ...(expireAt ? { _expireAt: expireAt } : {}),
    };
    await col<FileMetaDoc>(`${spaceId}_files`).insertOne(asDoc<FileMetaDoc>(doc));
  }

  // Both branches, unconditionally. A create enqueues for the reason every brain create does — the write
  // should not pay the model's latency — and an update for the correctness reason above.
  await enqueueEmbedJob(spaceId, 'file', normalised);
}

/**
 * Partially update the metadata record for a file (tags, description,
 * entity/chrono/fact linkage, properties).  Re-embeds the record on
 * every successful update.  Returns the updated document, or null if the
 * record does not exist.
 */
/**
 * Write a DERIVED description only if the operator has not written one — decided by the DATABASE, in one operation.
 *
 * ## Why this is not `updateFileMeta` with a read in front of it
 *
 * The media worker used to do exactly that: `findOne`, compute `operatorWrote` from the result, then write on that
 * decision. The intent was right and documented — *"Only the description itself is theirs to keep"* — but a read-modify-write
 * cannot win the race it exists to win. An operator PATCH landing between the read and the write was silently overwritten
 * by the derived text, and nothing reported it: no field is missing, no status is wrong, the description is simply somebody
 * else's.
 *
 * Same shape as the 2.5.1 embedding defect, which computed a vector from the record *as the write had read it*.
 *
 * The filter carries the condition, so MongoDB arbitrates: if the stored description became non-empty in the meantime, the
 * update matches nothing and the operator's text stands. `^\s*$` rather than `''` because the guard it replaces used
 * `.trim()`, and a whitespace-only description was treated as absent.
 *
 * Returns whether it wrote, so a caller can log the difference rather than infer it.
 */
export async function setDerivedDescriptionIfUnset(
  spaceId: string,
  filePath: string,
  description: string,
  /**
   * Optional, and its ABSENCE is meaningful: `updateFileMeta` unsets `descriptionSource` when a description arrives
   * without one, so a derived description with no known provenance must not inherit the previous one's. Ported
   * faithfully rather than defaulted — mislabelling where a description came from is a worse bug than the race being
   * fixed here.
   */
  descriptionSource?: 'generated' | 'extracted',
): Promise<boolean> {
  const _id = toDocId(filePath);
  const r = await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
    asFilter<FileMetaDoc>({
      _id,
      $or: [
        { description: { $exists: false } },
        { description: null },
        // Built from a RegExp rather than a string literal, because `'^\s*$'` in a JS string is `^s*$` — the backslash
        // is dropped and the pattern matches "sss" instead of whitespace. It did exactly that here, and the
        // whitespace-only assertion is what caught it. A RegExp literal cannot lose the escape.
        { description: { $regex: /^\s*$/ } },
      ],
    } as never),
    asUpdate<FileMetaDoc>({
      // `P-32`: an authored write, so it advances the space counter and pages to a peer.
      $set: { description, updatedAt: new Date().toISOString(), seq: await nextSeq(spaceId), ...(descriptionSource ? { descriptionSource } : {}) },
      ...(descriptionSource ? {} : { $unset: { descriptionSource: '' } }),
    }),
  );
  return r.modifiedCount > 0;
}

/**
 * Read one file-metadata record by path, or null.
 *
 * Exists for the audit before-snapshot: `updateFileMeta` reads the same document internally but returns
 * only the new one, and the audit change list needs the prior state. Kept as a plain getter rather than
 * changing that signature, so nothing else has to care.
 */
export async function getFileMeta(spaceId: string, filePath: string): Promise<FileMetaDoc | null> {
  return await col<FileMetaDoc>(`${spaceId}_files`)
    .findOne(asFilter<FileMetaDoc>({ _id: toDocId(filePath) })) as FileMetaDoc | null;
}

export async function updateFileMeta(
  spaceId: string,
  filePath: string,
  opts: {
    description?: string;
    tags?: string[];
    entityIds?: string[];
    chronoIds?: string[];
    memoryIds?: string[];
    properties?: Record<string, string | number | boolean>;
    /** Provenance of an instance-written description. Omit when a human wrote it — see `FileMetaDoc`. */
    descriptionSource?: 'generated' | 'extracted';
    /** A converted document's own opening prose. Kept whatever the description says, and embedded. */
    excerpt?: string;
  },
  /** Dot-notation paths to remove, applied AFTER the merge — the only way to unset. See the block below. */
  deleteFieldsPaths?: string[],
): Promise<FileMetaDoc | null> {
  /*
   * REFERENCES ARE VALIDATED HERE, so a caller cannot reach the collection around the check.
   *
   * `assertRefsResolve` sat only at the two API doors (`api/brain/file-meta.ts:444-446` and
   * `mcp/tools/file.ts`), which meant `strictLinkage`'s promise — that a stored reference resolves — held only
   * for callers who remembered it. `files/media/face-embedder.ts` calls this function directly to write the
   * `entityIds` of an auto-labelled face, and was never checked. The id comes from a live match so it resolves
   * in practice, but the guarantee was structural in name only.
   *
   * Owner's ruling, 2026-08-29: *"all upsert/update/insert things must validate."* Same shape as the
   * `upsertEdge` fix, one record type over.
   *
   * Gated on `isStrictLinkage` exactly as the doors were, so a space that opted out is unaffected — the setting
   * exists for staged imports where targets are resolved in a later pass, and moving the check must not
   * quietly withdraw that.
   */
  if (isStrictLinkage(spaceId)) {
    await assertRefsResolve(spaceId, 'entityIds', 'entity', opts.entityIds);
    await assertRefsResolve(spaceId, 'memoryIds', 'fact', opts.memoryIds);
    await assertRefsResolve(spaceId, 'chronoIds', 'chrono', opts.chronoIds);
  }

  const normalised = toDocId(filePath);
  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(asFilter<FileMetaDoc>({ _id: normalised })) as FileMetaDoc | null;
  if (!existing) return null;

  const now = new Date().toISOString();

  // The re-embed is ENQUEUED after the write — see `embedStoredRecord`, and the note on
  // `BrainEmbedRecordType` for why `file` is in that union at all.
  //
  // This function used to build the text here, from `existing` plus `opts`, and spread the result into
  // `$set` UNCONDITIONALLY while every content field below is guarded by `opts.X !== undefined`. So two
  // concurrent writes to different fields both landed and lost no field — and each wrote a whole embedding
  // describing only its own view, leaving the stored vector describing a record that existed nowhere. There
  // was nothing to notice it with: file-meta records carry no `seq`, so there is no precondition to violate
  // and no lost-update counter, unlike the four brain types that had the identical defect.
  const $set: Record<string, unknown> = { updatedAt: now };
  if (opts.description !== undefined) $set['description'] = opts.description;
  if (opts.descriptionSource !== undefined) $set['descriptionSource'] = opts.descriptionSource;
  if (opts.excerpt !== undefined) $set['excerpt'] = opts.excerpt;
  if (opts.tags !== undefined) $set['tags'] = opts.tags;
  if (opts.entityIds !== undefined) $set['entityIds'] = opts.entityIds;
  if (opts.chronoIds !== undefined) $set['chronoIds'] = opts.chronoIds;
  if (opts.memoryIds !== undefined) $set['memoryIds'] = opts.memoryIds;

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
  if (opts.description !== undefined && opts.descriptionSource === undefined) $unset['descriptionSource'] = '';

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
      excerpt: opts.excerpt !== undefined ? opts.excerpt : existing.excerpt,
      tags: opts.tags ?? existing.tags,
      entityIds: opts.entityIds ?? existing.entityIds,
      chronoIds: opts.chronoIds ?? existing.chronoIds,
      memoryIds: opts.memoryIds ?? existing.memoryIds,
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
  // every one of them authored, so this advances the space counter and pages the record to a peer.
  $set['seq'] = await nextSeq(spaceId);
  await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
    asFilter<FileMetaDoc>({ _id: normalised }),
    asUpdate<FileMetaDoc>(Object.keys($unset).length > 0 ? { $set, $unset } : { $set }),
  );

  // ONE enqueue, unconditionally, after the write. Not gated on which fields moved: any such condition
  // could only be computed from the read above, which is the stale value this change exists to stop using.
  await enqueueEmbedJob(spaceId, 'file', normalised);

  /*
   * A file's THREE classes — the only record kind with all of them, and the only one whose `_id` is a path.
   *
   * Reconciled from the merged values this function computed, and only for the classes the caller named:
   * omitting `chronoIds` on a patch means "leave the chrono links", not "remove them". `updateFileMeta` is
   * also the ONLY writer of these three fields, so this one call covers every door - REST, MCP and the face
   * labeller, which appends through here rather than writing the array itself.
   */
  if (opts.entityIds !== undefined || opts.memoryIds !== undefined || opts.chronoIds !== undefined
      || deleteFieldsPaths?.some(p => p.startsWith('entityIds') || p.startsWith('memoryIds') || p.startsWith('chronoIds'))) {
    await reconcileLinks(spaceId, normalised, 'file', {
      ...(opts.entityIds !== undefined ? { entity: ($set['entityIds'] as string[] | undefined) ?? [] } : {}),
      ...(opts.memoryIds !== undefined ? { fact: ($set['memoryIds'] as string[] | undefined) ?? [] } : {}),
      ...(opts.chronoIds !== undefined ? { chrono: ($set['chronoIds'] as string[] | undefined) ?? [] } : {}),
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
  if (opts.entityIds !== undefined && opts.entityIds.length > 0) {
    try {
      const { getFaceRecognitionConfig } = await import('../config/loader.js');
      const faceCfg = getFaceRecognitionConfig();
      if (faceCfg.enabled) {
        const faceChunkCount = await col<FileMetaDoc>(`${spaceId}_files`).countDocuments(
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
          const entities = await col<EntityDoc>(`${spaceId}_entities`)
            .find(asFilter<EntityDoc>({ _id: { $in: opts.entityIds } }), { projection: { _id: 1, type: 1 } })
            .toArray() as Array<{ _id: string; type: string }>;
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

  return col<FileMetaDoc>(`${spaceId}_files`).findOne(asFilter<FileMetaDoc>({ _id: normalised })) as Promise<FileMetaDoc | null>;
}

/** Remove the metadata record when a file is deleted. */
export async function deleteFileMeta(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = toDocId(filePath);
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne(
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
  await col<FileMetaDoc>(`${spaceId}_files`).deleteMany(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` } }),
  );
}

/**
 * Soft-delete: flag a single file's metadata record as deleted (`deletedAt = now`)
 * instead of removing it. No-op if the record does not exist. Used when
 * `softDeleteFileMeta` is enabled so a deleted file leaves an auditable record.
 */
export async function markFileMetaDeleted(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = toDocId(filePath);
  await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
    asFilter<FileMetaDoc>({ _id: normalised }),
    // `P-32`: a deletion is an authored change. The file TOMBSTONE carries the removal to a peer; this
    // seq is what pages the soft-deleted record itself, so a peer sees the flag rather than a record
    // that simply stopped changing.
    asUpdate<FileMetaDoc>({ $set: { deletedAt: new Date().toISOString(), seq: await nextSeq(spaceId) } }),
  );
}

/**
 * Soft-delete a whole directory subtree: flag every top-level file record under
 * `dirPath/` as deleted, and hard-remove the derived chunk records (which carry no
 * independent audit value). The `_converted`/`_extracted` sidecars are cleaned
 * separately by deleteConversionArtifactsByPrefix.
 */
export async function markFileMetaDeletedByPrefix(
  spaceId: string,
  dirPath: string,
): Promise<void> {
  const norm = toDocId(dirPath).replace(/\/?$/, '');
  if (!norm) return; // guard: empty path would match everything
  const escaped = escapeRegex(norm + '/');
  const coll = col<FileMetaDoc>(`${spaceId}_files`);
  // Flag the user-visible file records.
  await coll.updateMany(
    asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` }, parentFileId: { $exists: false } }),
    asUpdate<FileMetaDoc>({ $set: { deletedAt: new Date().toISOString() } }),
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

  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
    asFilter<FileMetaDoc>({ _id: normSrc }),
  );
  if (!existing) return;

  const now = new Date().toISOString();
  // MongoDB does not allow updating _id; delete + re-insert with new path.
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne(asFilter<FileMetaDoc>({ _id: normSrc }));
  await col<FileMetaDoc>(`${spaceId}_files`).insertOne(asDoc<FileMetaDoc>({
    ...existing,
    _id: normDst,
    path: normDst,
    updatedAt: now,
  }));

  /*
   * The link records move with it, and this is the path that hides them.
   *
   * A file's `_id` IS its path, so a rename changes the identity every `file.*` link hangs off. The three
   * arrays ride across by object spread, so their field names never appear here — a grep for `entityIds`
   * finds nothing in this function, in either spelling. Without this the links would still name the OLD
   * path: a `from` pointing at a record that no longer exists.
   *
   * Removed from the old id first and created under the new one, because the id is derived from the `from`
   * — so there is no rename of a link record either, only a delete and a create. The tombstone that the
   * removal writes is what stops a peer restoring the links under the old path on the next pull.
   */
  await removeLinksFrom(spaceId, normSrc, 'file');
  await reconcileLinks(spaceId, normDst, 'file', {
    entity: existing.entityIds ?? [],
    fact: existing.memoryIds ?? [],
    chrono: existing.chronoIds ?? [],
  }, existing.author ?? authorRef());
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
  const docs = await col<FileMetaDoc>(`${spaceId}_files`)
    .find(asFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` } }))
    .toArray() as FileMetaDoc[];

  if (docs.length === 0) return;

  const now = new Date().toISOString();
  // Delete existing records and re-insert with updated paths.
  const oldIds = docs.map(d => d._id);
  await col<FileMetaDoc>(`${spaceId}_files`).deleteMany(
    asFilter<FileMetaDoc>({ _id: { $in: oldIds } }),
  );
  const updated = docs.map(d => ({
    ...d,
    _id: dstPrefix + d._id.slice(srcPrefix.length),
    path: dstPrefix + d.path.slice(srcPrefix.length),
    updatedAt: now,
  }));
  await col<FileMetaDoc>(`${spaceId}_files`).insertMany(updated.map(d => asDoc<FileMetaDoc>(d)));
}

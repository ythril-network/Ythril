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
import { col, mFilter, mDoc, mUpdate } from '../db/mongo.js';
import { embed } from '../brain/embedding.js';
import { getConfig } from '../config/loader.js';
import type { FileMetaDoc, AuthorRef, EntityDoc } from '../config/types.js';

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Normalise a path to forward-slash convention and strip leading slashes (used as _id). */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Derive the text to embed for a file (path + entity names + tags + description + property values). */
function fileEmbedText(
  filePath: string,
  tags: string[] = [],
  description?: string,
  properties?: Record<string, string | number | boolean>,
  entityNames: string[] = [],
): string {
  const parts: string[] = [filePath];
  if (entityNames.length > 0) parts.push(entityNames.join(' '));
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  if (properties) {
    const vals = Object.values(properties).map(v => String(v)).filter(v => v.trim());
    if (vals.length > 0) parts.push(vals.join(' '));
  }
  return parts.join(' ');
}

/** Resolve entity names from a list of entity IDs in this space. Best-effort — returns [] on error. */
async function resolveEntityNames(spaceId: string, entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) return [];
  try {
    const docs = await col<EntityDoc>(`${spaceId}_entities`)
      .find(mFilter<EntityDoc>({ _id: { $in: entityIds } }), { projection: { name: 1 } })
      .toArray() as Array<{ name: string }>;
    return docs.map(d => d.name);
  } catch { return []; }
}

/**
 * Create or update the metadata record for a file after a write.
 * On first write `createdAt` is set; subsequent writes update `updatedAt` and
 * `sizeBytes`.  `description`, `tags`, and `properties` are only updated when supplied.
 */
export async function upsertFileMeta(
  spaceId: string,
  filePath: string,
  sizeBytes: number,
  opts: { description?: string; tags?: string[]; properties?: Record<string, string | number | boolean> } = {},
): Promise<void> {
  const normalised = normPath(filePath);
  const now = new Date().toISOString();

  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
    mFilter<FileMetaDoc>({ _id: normalised }),
  );

  // Embed path + entity names + tags + description + property values — best-effort, never blocks write
  const descForEmbed = opts.description !== undefined ? opts.description : (existing as FileMetaDoc | null)?.description;
  const tagsForEmbed = opts.tags !== undefined ? opts.tags : ((existing as FileMetaDoc | null)?.tags ?? []);
  const propsForEmbed = opts.properties !== undefined ? opts.properties : (existing as FileMetaDoc | null)?.properties;
  const existingEntityIds: string[] = (existing as FileMetaDoc | null)?.entityIds ?? [];
  const entityNames = await resolveEntityNames(spaceId, existingEntityIds);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = {};
  try {
    const embedText = fileEmbedText(normalised, tagsForEmbed, descForEmbed, propsForEmbed, entityNames);
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  } catch { /* embedding unavailable — file stored without vector */ }

  if (existing) {
    const $set: Record<string, unknown> = { updatedAt: now, sizeBytes, ...embeddingFields };
    if (opts.description !== undefined) $set['description'] = opts.description;
    if (opts.tags !== undefined) $set['tags'] = opts.tags;
    if (opts.properties !== undefined) $set['properties'] = opts.properties;
    await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
      mFilter<FileMetaDoc>({ _id: normalised }),
      mUpdate<FileMetaDoc>({ $set }),
    );
  } else {
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
      author: authorRef(),
      ...embeddingFields,
    };
    await col<FileMetaDoc>(`${spaceId}_files`).insertOne(mDoc<FileMetaDoc>(doc));
  }
}

/**
 * Partially update the metadata record for a file (tags, description,
 * entity/chrono/memory linkage, properties).  Re-embeds the record on
 * every successful update.  Returns the updated document, or null if the
 * record does not exist.
 */
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
  },
): Promise<FileMetaDoc | null> {
  const normalised = normPath(filePath);
  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(mFilter<FileMetaDoc>({ _id: normalised })) as FileMetaDoc | null;
  if (!existing) return null;

  const now = new Date().toISOString();
  const descForEmbed = opts.description !== undefined ? opts.description : existing.description;
  const tagsForEmbed = opts.tags !== undefined ? opts.tags : existing.tags;
  const propsForEmbed = opts.properties !== undefined ? opts.properties : existing.properties;
  // Use the incoming entityIds if being updated, otherwise fall back to existing
  const entityIdsForEmbed: string[] = opts.entityIds !== undefined ? opts.entityIds : (existing.entityIds ?? []);
  const entityNames = await resolveEntityNames(spaceId, entityIdsForEmbed);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string; matchedText?: string } = {};
  try {
    const embedText = fileEmbedText(normalised, tagsForEmbed, descForEmbed, propsForEmbed, entityNames);
    const embResult = await embed(embedText);
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model, matchedText: embedText };
  } catch { /* best-effort */ }

  const $set: Record<string, unknown> = { updatedAt: now, ...embeddingFields };
  if (opts.description !== undefined) $set['description'] = opts.description;
  if (opts.tags !== undefined) $set['tags'] = opts.tags;
  if (opts.entityIds !== undefined) $set['entityIds'] = opts.entityIds;
  if (opts.chronoIds !== undefined) $set['chronoIds'] = opts.chronoIds;
  if (opts.memoryIds !== undefined) $set['memoryIds'] = opts.memoryIds;
  if (opts.properties !== undefined) $set['properties'] = opts.properties;

  await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
    mFilter<FileMetaDoc>({ _id: normalised }),
    mUpdate<FileMetaDoc>({ $set }),
  );

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
          mFilter<FileMetaDoc>({ parentFileId: normalised, faceEmbedding: { $exists: true } }),
        );

        if (faceChunkCount === 0 && faceCfg.reprocessSyncedImages) {
          // Case A: image not yet processed by face recognizer — enqueue for processing.
          const { resolveInputFormat } = await import('../files/converters/pipeline.js');
          if (resolveInputFormat(normalised) === 'image') {
            const { enqueueMediaJob } = await import('./media/job-queue.js');
            const ext = path.extname(normalised).toLowerCase();
            const mimeType = (({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
              '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
              '.tiff': 'image/tiff', '.tif': 'image/tiff' }) as Record<string, string>)[ext] ?? 'image/jpeg';
            await enqueueMediaJob(spaceId, normalised, mimeType, 'image');
          }
        } else if (faceChunkCount === 1) {
          // Case B: face chunks exist — propagate label if exactly 1 person entity.
          const entities = await col<EntityDoc>(`${spaceId}_entities`)
            .find(mFilter<EntityDoc>({ _id: { $in: opts.entityIds } }), { projection: { _id: 1, type: 1 } })
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

  return col<FileMetaDoc>(`${spaceId}_files`).findOne(mFilter<FileMetaDoc>({ _id: normalised })) as Promise<FileMetaDoc | null>;
}

/** Remove the metadata record when a file is deleted. */
export async function deleteFileMeta(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = normPath(filePath);
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne(
    mFilter<FileMetaDoc>({ _id: normalised }),
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
  const norm = normPath(dirPath).replace(/\/?$/, '');
  if (!norm) return; // guard: empty path would match everything
  const prefix = norm + '/';
  // Escape regex special characters in the prefix so a path like "my.dir/"
  // doesn't accidentally match "myXdir/" etc.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await col<FileMetaDoc>(`${spaceId}_files`).deleteMany(
    mFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` } }),
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
  const normSrc = normPath(srcPath);
  const normDst = normPath(dstPath);
  if (normSrc === normDst) return;

  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
    mFilter<FileMetaDoc>({ _id: normSrc }),
  );
  if (!existing) return;

  const now = new Date().toISOString();
  // MongoDB does not allow updating _id; delete + re-insert with new path.
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne(mFilter<FileMetaDoc>({ _id: normSrc }));
  await col<FileMetaDoc>(`${spaceId}_files`).insertOne(mDoc<FileMetaDoc>({
    ...existing,
    _id: normDst,
    path: normDst,
    updatedAt: now,
  }));
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
  const normSrc = normPath(srcDir).replace(/\/?$/, '');
  const normDst = normPath(dstDir).replace(/\/?$/, '');
  if (!normSrc || !normDst) return; // guard: empty path would match everything
  const srcPrefix = normSrc + '/';
  const dstPrefix = normDst + '/';
  if (srcPrefix === dstPrefix) return;

  const escaped = srcPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const docs = await col<FileMetaDoc>(`${spaceId}_files`)
    .find(mFilter<FileMetaDoc>({ _id: { $regex: `^${escaped}` } }))
    .toArray() as FileMetaDoc[];

  if (docs.length === 0) return;

  const now = new Date().toISOString();
  // Delete existing records and re-insert with updated paths.
  const oldIds = docs.map(d => d._id);
  await col<FileMetaDoc>(`${spaceId}_files`).deleteMany(
    mFilter<FileMetaDoc>({ _id: { $in: oldIds } }),
  );
  const updated = docs.map(d => ({
    ...d,
    _id: dstPrefix + d._id.slice(srcPrefix.length),
    path: dstPrefix + d.path.slice(srcPrefix.length),
    updatedAt: now,
  }));
  await col<FileMetaDoc>(`${spaceId}_files`).insertMany(updated.map(d => mDoc<FileMetaDoc>(d)));
}

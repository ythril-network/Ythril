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

import { col, mFilter, mDoc, mUpdate } from '../db/mongo.js';
import { embed } from '../brain/embedding.js';
import { getConfig } from '../config/loader.js';
import type { FileMetaDoc, AuthorRef } from '../config/types.js';

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Normalise a path to forward-slash convention and strip leading slashes (used as _id). */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Derive the text to embed for a file (path + tags + description). */
function fileEmbedText(filePath: string, tags: string[] = [], description?: string): string {
  const parts: string[] = [filePath];
  if (tags.length > 0) parts.push(tags.join(' '));
  if (description?.trim()) parts.push(description.trim());
  return parts.join(' ');
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

  // Embed path + tags + description — best-effort, never blocks write
  const descForEmbed = opts.description !== undefined ? opts.description : (existing as FileMetaDoc | null)?.description;
  const tagsForEmbed = opts.tags !== undefined ? opts.tags : ((existing as FileMetaDoc | null)?.tags ?? []);
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(fileEmbedText(normalised, tagsForEmbed, descForEmbed));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
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
  let embeddingFields: { embedding?: number[]; embeddingModel?: string } = {};
  try {
    const embResult = await embed(fileEmbedText(normalised, tagsForEmbed, descForEmbed));
    embeddingFields = { embedding: embResult.vector, embeddingModel: embResult.model };
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

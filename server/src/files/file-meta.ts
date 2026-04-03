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

import { col } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { FileMetaDoc, AuthorRef } from '../config/types.js';

function authorRef(): AuthorRef {
  const cfg = getConfig();
  return { instanceId: cfg.instanceId, instanceLabel: cfg.instanceLabel };
}

/** Normalise a path to forward-slash convention (used as _id). */
function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Create or update the metadata record for a file after a write.
 * On first write `createdAt` is set; subsequent writes update `updatedAt` and
 * `sizeBytes`.  `description` and `tags` are only updated when supplied.
 */
export async function upsertFileMeta(
  spaceId: string,
  filePath: string,
  sizeBytes: number,
  opts: { description?: string; tags?: string[] } = {},
): Promise<void> {
  const normalised = normPath(filePath);
  const now = new Date().toISOString();

  const existing = await col<FileMetaDoc>(`${spaceId}_files`).findOne(
    { _id: normalised } as never,
  );

  if (existing) {
    const $set: Record<string, unknown> = { updatedAt: now, sizeBytes };
    if (opts.description !== undefined) $set['description'] = opts.description;
    if (opts.tags !== undefined) $set['tags'] = opts.tags;
    await col<FileMetaDoc>(`${spaceId}_files`).updateOne(
      { _id: normalised } as never,
      { $set } as never,
    );
  } else {
    const doc: FileMetaDoc = {
      _id: normalised,
      spaceId,
      path: normalised,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      tags: opts.tags ?? [],
      createdAt: now,
      updatedAt: now,
      sizeBytes,
      author: authorRef(),
    };
    await col<FileMetaDoc>(`${spaceId}_files`).insertOne(doc as never);
  }
}

/** Remove the metadata record when a file is deleted. */
export async function deleteFileMeta(
  spaceId: string,
  filePath: string,
): Promise<void> {
  const normalised = normPath(filePath);
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne(
    { _id: normalised } as never,
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
    { _id: normSrc } as never,
  );
  if (!existing) return;

  const now = new Date().toISOString();
  // MongoDB does not allow updating _id; delete + re-insert with new path.
  await col<FileMetaDoc>(`${spaceId}_files`).deleteOne({ _id: normSrc } as never);
  await col<FileMetaDoc>(`${spaceId}_files`).insertOne({
    ...existing,
    _id: normDst,
    path: normDst,
    updatedAt: now,
  } as never);
}

/**
 * Moving a file or directory — one cascade, shared by the REST `PATCH` and the MCP `move_file` tool.
 *
 * A move is not a rename of the bytes. What belongs to the path has to follow it: the metadata record, the derived
 * records a conversion wrote (chunks, the converted Markdown, extracted images), the sidecar files on disk, the job
 * queue, and a sync tombstone for every path left behind. Both doors wrote this sequence out, both did the same part of
 * it, and neither did the rest.
 *
 * ## The race this order exists for
 *
 * A conversion started by the upload can still be running when the move arrives. It used to finish afterwards and
 * insert its chunk records under the OLD path — a directory that no longer existed, with nothing that would ever delete
 * them. `files.test.js` "Moving a directory updates metadata paths for all files inside it" caught it on CI with two
 * records left under the source directory.
 *
 * So the jobs are held FIRST, before a byte moves (`holdJobsForMove`). A run that has not yet committed then finds its
 * claim gone and writes nothing (`writeUnderClaim`); a run that already committed left its records where the
 * relocation below finds them. A run that finds the file missing asks whether it still holds its claim before
 * cleaning up after "a deleted source" — which, mid-move, would delete what the move is carrying. Then the held jobs
 * are re-keyed to the new path and released, so the moved file is processed where it now is.
 *
 * The tombstones for every path left behind are written FIRST, before a byte moves (bundle-30 I13, see
 * `files/tombstones.ts`), and withdrawn if the move then fails. The bytes move or the call throws; everything after is
 * best-effort and logged, because the file has already moved and a failed secondary step must not report the move
 * itself as failed. A source that is not there is a `NotFoundError` (404 on both doors), checked before anything is
 * written.
 */
import fs from 'fs/promises';
import { moveFile, listFilesRecursive } from './files.js';
import { renameFileMeta, renameFileMetaByPrefix } from './file-meta.js';
import { holdJobsForMove, releaseMoveHold, rekeyJobsForMove } from './media/job-queue.js';
import { movedId, movedSidecars, parentIdsUnder } from './moved-paths.js';
import { resolveSafePathChecked } from './sandbox.js';
import { writeFileTombstones, withdrawFileTombstones } from './tombstones.js';
import { NotFoundError } from '../util/errors.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import type { FileMetaDoc } from '../config/types.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { log, peerText } from '../util/log.js';

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether a space-relative path exists on disk. A path outside the sandbox does not, for this purpose. */
async function exists(spaceId: string, relPath: string): Promise<boolean> {
  try {
    await fs.stat(await resolveSafePathChecked(spaceId, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every file path the move takes away, for the tombstones: the files themselves and their sidecars. Sync has no rename
 * detection, so a path without a tombstone is still advertised by a peer's manifest and comes back on the next pull.
 */
async function pathsLeaving(spaceId: string, src: string, dst: string): Promise<string[]> {
  const children = await listFilesRecursive(spaceId, src);
  const out = children.length > 0 ? children : [src];
  for (const { from } of movedSidecars(src, dst)) {
    const under = await listFilesRecursive(spaceId, from);
    if (under.length > 0) out.push(...under);
    else if (await exists(spaceId, from)) out.push(from);
  }
  return out;
}

/**
 * Re-root every DERIVED record of a file at or under `src`: its id, its path, and the `parentFileId` that ties it to
 * the file — plus the parent's `convertedFileId`, which names one of them.
 *
 * Selected by `parentFileId`, not by id, because the ids do not share the file's prefix: a chunk is `<path>#chunk<n>`
 * and the sidecars live under `_converted/` and `_extracted/`. An id-prefix rename therefore left a renamed file's
 * chunks at the old path, and a moved directory's chunks pointing at parents that no longer existed — so deleting the
 * moved file later removed none of them, since that delete looks them up by `parentFileId`.
 */
async function relocateDerivedFileMeta(spaceId: string, src: string, dst: string): Promise<void> {
  const parents = parentIdsUnder(src);
  if (!parents) return;
  const files = col<FileMetaDoc>(spaceCollection(spaceId, 'files'));
  const derived = await files.find(asFilter<FileMetaDoc>({ parentFileId: { $regex: parents } })).toArray() as FileMetaDoc[];
  if (derived.length === 0) return;
  const now = new Date().toISOString();
  const moved = derived.map(d => {
    const id = movedId(d._id, src, dst) ?? d._id;
    return { ...d, _id: id, path: id, parentFileId: movedId(d.parentFileId!, src, dst) ?? d.parentFileId, updatedAt: now };
  });
  await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: [...derived.map(d => d._id), ...moved.map(d => d._id)] } }));
  await files.insertMany(moved.map(d => asDoc<FileMetaDoc>(d)));
  for (let i = 0; i < derived.length; i++) {
    if (derived[i]!._id === moved[i]!._id) continue;
    await files.updateMany(
      asFilter<FileMetaDoc>({ convertedFileId: derived[i]!._id }), { $set: { convertedFileId: moved[i]!._id } },
    );
  }
}

/** Move `src` to `dst` in `spaceId`, and everything that belongs to it with it. See the module docblock for the order. */
export async function moveFileCascade(spaceId: string, src: string, dst: string, actor?: WebhookActor): Promise<void> {
  // Both paths resolved and the source found BEFORE anything is written: a refusal of either is the caller's, and
  // must not leave a tombstone behind it.
  await resolveSafePathChecked(spaceId, src);
  await resolveSafePathChecked(spaceId, dst);
  if (!(await exists(spaceId, src))) throw new NotFoundError(`Path '${src}' not found in space '${spaceId}'`);
  const leaving = await pathsLeaving(spaceId, src, dst);

  // The tombstones BEFORE the bytes move (bundle-30 I13, `files/tombstones.ts`): a store failure here leaves the
  // source where it was, so the retry repeats the move — written after, the retry found no source and the paths left
  // behind were never tombstoned. A move that then fails withdraws them: nobody asked for those paths to go.
  const tombstones = await writeFileTombstones(spaceId, leaving);
  const held = await holdJobsForMove(spaceId, src).catch(async (err) => {
    await withdrawFileTombstones(spaceId, tombstones);
    throw err;
  });
  try {
    await moveFile(spaceId, src, dst);
  } catch (err) {
    await withdrawFileTombstones(spaceId, tombstones);
    await releaseMoveHold(spaceId, held).catch(e => log.warn(`releaseMoveHold error for ${peerText(spaceId)}/${peerText(src)}: ${peerText(why(e))}`));
    throw err;
  }

  for (const sidecar of movedSidecars(src, dst)) {
    if (!(await exists(spaceId, sidecar.from))) continue;
    await moveFile(spaceId, sidecar.from, sidecar.to).catch(err =>
      log.warn(`move sidecar error for ${peerText(spaceId)}, ${peerText(sidecar.from)} → ${peerText(sidecar.to)}: ${peerText(why(err))}`));
  }
  await rekeyJobsForMove(spaceId, src, dst, held).catch(err =>
    log.warn(`rekeyJobsForMove error for ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)}: ${peerText(why(err))}`));
  await Promise.all([
    renameFileMeta(spaceId, src, dst),
    renameFileMetaByPrefix(spaceId, src, dst),
  ]).catch(err => log.warn(`renameFileMeta error for ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)}: ${peerText(why(err))}`));
  await relocateDerivedFileMeta(spaceId, src, dst).catch(err =>
    log.warn(`relocateDerivedFileMeta error for ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)}: ${peerText(why(err))}`));

  emitWebhookEvent({ event: 'file.updated', spaceId, entry: { path: dst, previousPath: src }, ...(actor ?? {}) });
}

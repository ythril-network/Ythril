/**
 * Full file deletion — one cascade, shared by every delete path.
 *
 * Deleting a file is not just unlinking the blob: it must also propagate a sync tombstone (or a peer's
 * manifest re-pushes the file), remove or soft-flag the metadata record, cancel any queued media/text job
 * (a stale job retries forever against the missing path), and delete conversion artifacts. This exact
 * sequence was duplicated in the REST `DELETE /api/files/:spaceId` handler and the MCP `delete_file` tool;
 * it lives here so both — and the TTL sweep (F12) — clean up identically and no path orphans bytes, jobs
 * or artifacts. A directory's delete is the same cascade over a tree (`deleteDirectoryCascade`), REST only.
 *
 * ## The order, and what each failure leaves (bundle-30 I13, I14, I15)
 *
 * The path is resolved first (a path outside the space is the caller's `RangeError`, before anything is written),
 * then the tombstone is written PENDING, then the bytes go, then the tombstone is CONFIRMED — see
 * `files/tombstones.ts` for why it is written before and published only after. A store failure on the write throws
 * with the file untouched, so the retry repeats the whole cascade. **An unlink that fails for any other reason** (a
 * directory, a permission) settles the pending tombstone from the disk and throws: the file is still here, so it is
 * dropped and no peer is told otherwise — it used to keep the tombstone, and the TTL sweep wrote another every cycle
 * (preship-3 P3-3). A directory's tree removal that stops part way publishes the files it did remove (preship-4 P4-2),
 * and its sidecars' tombstones wait for their own removal (P4-3).
 *
 * **After the bytes, a store failure still fails the delete** (bundle-30 I14, verify-drive-4 D1). The job, the
 * artifacts and the metadata each used to be `.catch(log.warn)`: with the store paused, a delete unlinked the bytes,
 * failed all three and answered `204`. Now each step's own failure is still logged and survived, but the STORE's is
 * thrown (`unlessTheStoreFailed`), so the door answers `503` — and the metadata record goes LAST, because it is what
 * tells the retry, and the TTL sweep, that this delete is still owed.
 *
 * **A file whose bytes are already gone and whose metadata remains** (removed out of band, or by a cascade a store
 * failure stopped) is COMPLETED here: tombstone, jobs, artifacts, metadata, webhook — rather than left for each door
 * to special-case. The REST door answered that case itself and wrote no tombstone, and the TTL sweep failed on it for
 * ever. **A path with neither bytes nor a LIVE file record** is a `NotFoundError`: `404` on REST, on `/api/delete_file`
 * and in MCP's error result — it used to reach MCP as the filesystem's `ENOENT`, carrying the absolute data path.
 * "Live" is `hasLiveFileRecordExactlyAt` (Q-343): a record a soft delete flagged (`deletedAt`) or a derived one
 * (`parentFileId`) is not a delete still owed, so a retry of a delete that completed is not found — it used to
 * answer `204`, write a second tombstone, move the record's seq and fire a second `file.deleted`.
 */
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { NotFoundError } from '../util/errors.js';
import { toDocId } from '../util/paths.js';
import { resolveSafePathChecked } from './sandbox.js';
import { bytesPresent, deleteStored, isMissingPath } from './stored-bytes.js';
import { deleteFileMeta, deleteFileMetaByPrefix, fileRecordPaths, hasLiveFileRecordExactlyAt, hasLiveFileRecordUnder, markFileMetaDeleted, markFileMetaDeletedByPrefix } from './file-meta.js';
import { cancelMediaJob, cancelMediaJobsByPrefix } from './media/job-queue.js';
import { deleteConversionArtifacts, deleteConversionArtifactsByPrefix } from './converters/pipeline.js';
import { listFilesRecursive } from './files.js';
import { removeTree } from './remove-tree.js';
import { actUnderPendingTombstones, pendingAmong, settlePendingFileTombstones, writePendingFileTombstones } from './tombstones.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { unlessTheStoreFailed } from '../brain/store-failure.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';

export async function deleteFileCascade(spaceId: string, filePath: string, actor?: WebhookActor): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  const present = await bytesPresent(abs);
  // No bytes: a LIVE file record at the path is a delete a failure stopped, owed to completion. A flagged one (a soft
  // delete that finished) and a derived one (chunk, face) are not — the file is already gone, so the answer is not found.
  if (!present && !(await hasLiveFileRecordExactlyAt(spaceId, filePath))) {
    throw new NotFoundError(`File '${filePath}' not found in space '${spaceId}'`);
  }
  // BEFORE the bytes go, pending; published once they have: a peer's manifest re-pushes a file it has no tombstone
  // for, and a peer told of a file still here deletes it and tells us back.
  const pending = await writePendingFileTombstones(spaceId, [filePath]);
  // A concurrent delete that got there first has done this half; anything else is the caller's failure.
  await actUnderPendingTombstones(pending, async () => {
    if (present) await deleteStored(abs).catch(err => { if (!isMissingPath(err)) throw err; });
  });
  invalidateUsageCache(); // freed disk — reflect it in the next quota check
  const at = `for ${peerText(spaceId)}/${peerText(filePath)}`;
  // Cancel any queued media/text job so it cannot outlive the file and retry forever.
  await unlessTheStoreFailed(`cancelMediaJob error ${at}`, () => cancelMediaJob(spaceId, filePath));
  await unlessTheStoreFailed(`deleteConversionArtifacts error ${at}`, () => deleteConversionArtifacts(spaceId, filePath));
  // LAST: while the record remains, a retry (or the TTL sweep) completes this delete as an orphan.
  // Soft-flag it (retained for audit) or hard-delete it, per softDeleteFileMeta.
  if (getConfig().softDeleteFileMeta === true) {
    await unlessTheStoreFailed(`markFileMetaDeleted error ${at}`, () => markFileMetaDeleted(spaceId, filePath));
  } else {
    await unlessTheStoreFailed(`deleteFileMeta error ${at}`, () => deleteFileMeta(spaceId, filePath));
  }
  emitWebhookEvent({ event: 'file.deleted', spaceId, entry: { path: filePath }, ...(actor ?? {}) });
}

/**
 * Whether `dirPath` names a directory delete a store failure stopped after its tree went: no tree on disk, and live
 * file records under it. The REST door asks this before treating a missing path as one file, and only for a delete
 * the caller confirmed as a directory's.
 */
export async function isUnfinishedDirectoryDelete(spaceId: string, dirPath: string): Promise<boolean> {
  return hasLiveFileRecordUnder(spaceId, dirPath);
}

/**
 * Delete a directory: every file under it, their conversion sidecars, their jobs and their metadata — the same order
 * and the same failures as `deleteFileCascade`, over a tree. A tree already gone whose records remain (a delete a
 * store failure stopped after the tree went) is completed: its records' paths are tombstoned and the rest removed.
 * The caller has checked the path is a directory (or was one: `isUnfinishedDirectoryDelete`) and is not the root.
 */
export async function deleteDirectoryCascade(spaceId: string, dirPath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  const present = await bytesPresent(abs);
  // Every file about to go — the folder tree (or, with the tree gone, every record under it) AND its conversion
  // sidecars — so each gets its tombstone. Without them a peer re-pushes the files on the next sync (resurrection).
  const tree = present
    ? await listFilesRecursive(spaceId, dirPath)
    : (await fileRecordPaths(spaceId, dirPath)).filter(p => p !== toDocId(dirPath));
  const sidecars = (await Promise.all([
    listFilesRecursive(spaceId, `_converted/${dirPath}`),
    listFilesRecursive(spaceId, `_extracted/${dirPath}`),
  ])).flat();
  // BEFORE the tree goes, pending (bundle-30 I13, I15, `files/tombstones.ts`): a store failure here leaves the tree in
  // place and the retry repeats the delete; written after, the retry answered 404 and no tombstone was ever written.
  // The tree's are published once the tree has gone, the sidecars' once THEY have — a later step, below (I16, P4-3) —
  // and a removal that stops part way publishes the files it did remove (P4-2): see `actUnderPendingTombstones`.
  const pending = await writePendingFileTombstones(spaceId, [...tree, ...sidecars]);
  await actUnderPendingTombstones(pending, async () => {
    if (!present) return;
    await removeTree(abs, { mustExist: true });   // a converter may still be writing under it
    log.info(`Deleted directory ${peerText(dirPath)} (space: ${peerText(spaceId)})`);
  }, pendingAmong(pending, tree));
  invalidateUsageCache(); // freed disk — reflect it in the next quota check
  const at = `for space ${peerText(spaceId)}, path ${peerText(dirPath)}`;
  // Queued jobs under the folder would outlive their sources and retry forever against paths that no longer exist.
  await unlessTheStoreFailed(`cancelMediaJobsByPrefix error ${at}`, () => cancelMediaJobsByPrefix(spaceId, dirPath));
  // Sidecar records and files (`_converted/<path>`, `_extracted/<path>`) live outside the folder prefix.
  await unlessTheStoreFailed(`deleteConversionArtifactsByPrefix error ${at}`, () => deleteConversionArtifactsByPrefix(spaceId, dirPath));
  // That removal survives its own failure, so the sidecars' tombstones are settled from the disk: published where the
  // bytes went, dropped where they are still here.
  await settlePendingFileTombstones(pendingAmong(pending, sidecars));
  // LAST, as for one file: the records under the folder are what tell a retry this delete is still owed. Soft-flag
  // the user-visible file records (retain for audit) or hard-delete them; derived chunk records are always removed.
  if (getConfig().softDeleteFileMeta === true) {
    await unlessTheStoreFailed(`markFileMetaDeletedByPrefix error ${at}`, () => markFileMetaDeletedByPrefix(spaceId, dirPath));
  } else {
    await unlessTheStoreFailed(`deleteFileMetaByPrefix error ${at}`, () => deleteFileMetaByPrefix(spaceId, dirPath));
  }
}

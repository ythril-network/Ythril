/**
 * Full file deletion — one cascade, shared by every delete path.
 *
 * Deleting a file is not just unlinking the blob: it must also propagate a sync tombstone (or a peer's
 * manifest re-pushes the file), remove or soft-flag the metadata record, cancel any queued media/text job
 * (a stale job retries forever against the missing path), and delete conversion artifacts. This exact
 * sequence was duplicated in the REST `DELETE /api/files/:spaceId` handler and the MCP `delete_file` tool;
 * it lives here so both — and the TTL sweep (F12) — clean up identically and no path orphans bytes, jobs
 * or artifacts. A directory's delete is the same cascade over a tree (`deleteDirectoryCascade`), and which of the two
 * a path gets — or a refusal — is decided in one place, {@link deletePath}, for every door that takes a caller's path:
 * `DELETE /api/files/:spaceId`, `POST /api/delete_file` and MCP `delete_file`.
 *
 * ## The order, and what each failure leaves (bundle-30 I13, I14, I15)
 *
 * The path is resolved first (a path outside the space is the caller's `RangeError`, before anything is written),
 * then the tombstone is written PENDING, then the bytes go, then the tombstone is CONFIRMED — see
 * `files/tombstones.ts` for why it is written before and published only after. A failure of the write throws with the
 * file untouched, so the retry repeats the whole cascade: the store's as it is (`503`), any other as `ActNotRecorded` (`500`) —
 * a delete that cannot be recorded does not happen, since the bytes gone with no tombstone are brought back by a peer's
 * manifest. The TTL sweep deletes through this cascade, so it refuses alike. **An unlink that fails for any other reason** (a
 * directory, a permission) settles the pending tombstone from the disk and throws: the file is still here, so it is
 * dropped and no peer is told otherwise — it used to keep the tombstone, and the TTL sweep wrote another every cycle
 * (preship-3 P3-3). A directory's tree removal that stops part way publishes the files it did remove (preship-4 P4-2),
 * and its sidecars' tombstones wait for their own removal (P4-3).
 *
 * **The links go after the bytes and before the row** (Q-464): the links THIS instance wrote from the file and from its derived ids
 * (`removeLinksOfDeletedFiles`, `files/remove-file-here.ts`), each with a link tombstone, so nothing a later upload at the path inherits and
 * nothing a peer restores. Links another instance wrote stay with it (ADR 05, owner decision D-31). The step is called directly and its
 * failure fails the delete, the row still there to find it owed on every door (REST, `POST /api/delete_file`, MCP, the TTL sweep); a second
 * pass after the row removes a link written while the row was still live, bounded to links written by the instant the row went. A file's
 * own tombstone is published after its links are gone, so a delete whose link step failed has told no peer yet and its retry tells them once.
 * A directory runs the same steps over its tree: its links are those of the files gone from disk (never of one a failure left standing).
 *
 * **After the bytes, a store failure still fails the delete** (bundle-30 I14, verify-drive-4 D1). The job, the
 * artifacts and the metadata each used to be `.catch(log.warn)`: with the store paused, a delete unlinked the bytes,
 * failed all three and answered `204`. Now each step's own failure is still logged and survived, but the STORE's is
 * thrown (`unlessTheStoreFailed`), so the door answers `503` — and the metadata record goes LAST, because it is what
 * tells the retry, and the TTL sweep, that this delete is still owed.
 *
 * **A file whose bytes are already gone and whose metadata remains** (removed out of band, or by a cascade a store
 * failure stopped) is COMPLETED here: tombstone, jobs, artifacts, metadata, the event (for a caller that has an actor) — rather than left for each door
 * to special-case. The REST door answered that case itself and wrote no tombstone, and the TTL sweep failed on it for
 * ever. **A path with neither bytes nor a LIVE file record** is a `NotFoundError`: `404` on REST, on `/api/delete_file`
 * and in MCP's error result — it used to reach MCP as the filesystem's `ENOENT`, carrying the absolute data path.
 * "Live" is `hasLiveFileRecordExactlyAt` (Q-343): a record a soft delete flagged (`deletedAt`) or a derived one
 * (`parentFileId`) is not a delete still owed, so a retry of a delete that completed is not found — it used to
 * answer `204`, write a second tombstone, move the record's seq and fire a second `file.deleted`.
 */
import { log, peerText } from '../util/log.js';
import { NotFoundError } from '../util/errors.js';
import { toDocId } from '../util/paths.js';
import fs from 'fs/promises';
import { resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { bytesPresent, deleteStoredIfPresent, isMissingPath } from './stored-bytes.js';
import { ConfirmRequired, FileSystemFault, SpaceRootRefused } from './act-answers.js';
import { fileRecordPaths, hasLiveFileRecordExactlyAt, hasLiveFileRecordUnder, retireFileMetaUnder } from './file-meta.js';
import { forgetFileHashesByPrefix } from './manifest.js';
import { cancelJobsOwnedBy } from './media/job-queue.js';
import { deleteConversionArtifactsByPrefix } from './converters/pipeline.js';
import { removeFileHere, removeLinksOfDeletedFiles } from './remove-file-here.js';
import { sidecarsOf, type PathKind } from './moved-paths.js';
import { listFilesRecursive } from './files.js';
import { removeTree } from './remove-tree.js';
import { actUnderPendingTombstones, confirmFileTombstones, pendingAmong, settlePendingFileTombstones, writePendingFileTombstones } from './tombstones.js';
import { forgetFinishedMove, moveIsOwed, movesBegunInto, type MoveMarker } from './move-markers.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { unlessTheStoreFailed } from '../brain/store-failure.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';

/** The refusal of a path with nothing to delete, in one sentence for every way a delete reaches it (`404` on REST, an error result in MCP). */
const fileNotFound = (spaceId: string, filePath: string): NotFoundError => new NotFoundError(`File '${filePath}' not found in space '${spaceId}'`);

export async function deleteFileCascade(spaceId: string, filePath: string, actor?: WebhookActor): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  const present = await bytesPresent(abs);
  // No bytes: a LIVE file record at the path is a delete a failure stopped, owed to completion. A flagged one (a soft
  // delete that finished) and a derived one (chunk, face) are not — the file is already gone, so the answer is not found.
  if (!present && !(await hasLiveFileRecordExactlyAt(spaceId, filePath))) throw fileNotFound(spaceId, filePath);
  // BEFORE the bytes go, pending; published once they have: a peer's manifest re-pushes a file it has no tombstone
  // for, and a peer told of a file still here deletes it and tells us back. REQUIRED: a tombstone that cannot be written
  // refuses the delete (`ActNotRecorded`) before a byte goes.
  const pending = await writePendingFileTombstones(spaceId, [filePath]);
  let movedHere: MoveMarker[] = [];
  // A concurrent delete that got there first has done this half; anything else is the caller's failure.
  await actUnderPendingTombstones(pending, async () => {
    if (!present) return;
    movedHere = await removeWhatAMovedFileLeftAtItsSource(spaceId, filePath, 'file');
    await deleteStoredIfPresent(abs);
  }, pendingAmong(pending, []));   // published below, once the links are gone: a failure of that step leaves the tombstone pending and the retry's its replacement, so peers are told once
  // The links this instance wrote from the file and from its derived ids, with the tombstones that tell peers: after the bytes and
  // before the row, so a failure leaves the delete owed (the row finds it), called directly so it IS thrown (`removeLinksOfDeletedFiles`).
  await removeLinksOfDeletedFiles(spaceId, filePath, 'file');
  await confirmFileTombstones(pending);
  // The job, the artefacts, the cached hash and — last, so a retry finds the delete still owed — the row: the one list of
  // what a file leaves, shared with the media worker's reconcile and a peer's file tombstone (`remove-file-here.ts`).
  await removeFileHere(spaceId, filePath, { failure: 'throw' });
  // A link written while the row was still live (a `save_link` between the pass above and the row's removal): the same removal, bounded to
  // links written by the instant the row went, so a file uploaded at this path since keeps the links it is given.
  await removeLinksOfDeletedFiles(spaceId, filePath, 'file', { createdUntil: new Date().toISOString() });
  for (const m of movedHere) await forgetFinishedMove(spaceId, m.from, m.to);
  // The brain family's one rule (`if (actor) emitWebhookEvent`): a delete no user made — the TTL sweep passes its own
  // actor, so it still reports; a caller with none is silent on the webhook AND the live view (bundle-48, Q-259).
  if (actor) emitWebhookEvent({ event: 'file.deleted', spaceId, entry: { path: filePath }, ...actor });
}

/**
 * Whether `dirPath` names a directory delete a store failure stopped after its tree went: no tree on disk, and live
 * file records under it. The REST door asks this before treating a missing path as one file, and only for a delete
 * the caller confirmed as a directory's.
 */
export async function isUnfinishedDirectoryDelete(spaceId: string, dirPath: string): Promise<boolean> {
  return hasLiveFileRecordUnder(spaceId, dirPath);
}

/** What a delete at a path did: removed one file, or removed a directory tree. */
export type PathDeleted = 'file' | 'directory';

/** `confirm` as a delete's caller gave it: absent, or a boolean — anything else is the caller's malformed request (`400`). */
function confirmOf(confirm: unknown): boolean | undefined {
  if (confirm === undefined || typeof confirm === 'boolean') return confirm;
  throw new RangeError("'confirm' must be a boolean");
}

/**
 * The filesystem's answers to "what is at this path" that mean nothing can be there: a name too long to exist, a loop of symbolic
 * links. For a delete these are "not found", like a missing path; the move's destination check reads the same two as refusals about
 * CREATING the name (`destination.ts`), which is the wrong sentence for a path being removed.
 */
const CANNOT_EXIST = new Set(['ENAMETOOLONG', 'ELOOP']);

/**
 * Delete what a caller's path names: one file, or — with `confirm: true` — a whole directory tree. The one decision, for
 * `DELETE /api/files/:spaceId`, `POST /api/delete_file` and MCP `delete_file` alike.
 *
 * ## The question it answers
 *
 * "What stands at this path, and which delete does the caller's `confirm` allow?" Asked by every door, so a door cannot differ
 * from another in what a path is. It used to be the REST route's own code (it stat'ed, found a directory, asked for `confirm`,
 * refused the root) while the MCP tool deleted files only and told its caller a directory was another tool's job: one capability, a
 * different act per client (Q-438).
 *
 * ## What it decides, in this order
 *
 * - `confirm` is absent or a boolean; anything else is a `RangeError` (`400`), whatever the door's own argument validation said.
 * - A path outside the space is a `RangeError` (`400`); one that cannot exist (a name too long, a loop of links) is not found.
 * - A path whose stat fails for any other reason is a `FileSystemFault`: `500` in words that name no path. It is never "not found",
 *   which would tell a caller to stop looking at something that is there.
 * - No bytes: a delete a store failure stopped after the tree went is completed — but only by a caller who said `confirm: true`, the
 *   one who meant a directory; without it the path is a file's, and a file with neither bytes nor a live record is not found.
 * - A directory without `confirm` is {@link ConfirmRequired} (`422`); the space root, with it, is {@link SpaceRootRefused} (`400`),
 *   and is never deleted.
 * - Everything else is {@link deleteFileCascade} or {@link deleteDirectoryCascade}.
 *
 * A directory delete is handed the actor like a file's, and announces what it removed (`file.deleted`, once per live file; Q-469). Returns
 * what was deleted, for the door that audits the act.
 */
export async function deletePath(spaceId: string, filePath: string, { confirm, actor }: { confirm?: unknown; actor?: WebhookActor } = {}): Promise<PathDeleted> {
  const confirmed = confirmOf(confirm);
  // Symlink-aware before a recursive delete: the lexical path may stay under the root while a link on the way points outside it.
  const abs = await resolveSafePathChecked(spaceId, filePath);
  let isDirectory = false;
  let there = true;
  try {
    isDirectory = (await fs.stat(abs)).isDirectory();
  } catch (err: unknown) {
    if (isMissingPath(err)) there = false;
    else if (CANNOT_EXIST.has((err as NodeJS.ErrnoException | null)?.code ?? '')) throw fileNotFound(spaceId, filePath);
    else throw new FileSystemFault(err);
  }
  // No bytes: the tree of a directory delete a store failure stopped, whose records remain — completed only by the caller who confirmed
  // a directory (bundle-30 I14). Anything else with no bytes is a file's, for `deleteFileCascade` to complete or to refuse as not found.
  if (!there && confirmed === true) isDirectory = await isUnfinishedDirectoryDelete(spaceId, filePath);
  if (!isDirectory) {
    await deleteFileCascade(spaceId, filePath, actor);
    return 'file';
  }
  if (confirmed !== true) throw new ConfirmRequired(filePath);
  if (abs === spaceRoot(spaceId)) throw new SpaceRootRefused(filePath);
  // Tombstones, tree, jobs, sidecars, links, metadata — in the order this module's header explains.
  await deleteDirectoryCascade(spaceId, filePath, actor);
  return 'directory';
}

/**
 * Delete a directory: every file under it, their conversion sidecars, their jobs and their metadata — the same order
 * and the same failures as `deleteFileCascade`, over a tree. A tree already gone whose records remain (a delete a
 * store failure stopped after the tree went) is completed: its records' paths are tombstoned and the rest removed.
 * The caller has checked the path is a directory (or was one: `isUnfinishedDirectoryDelete`) and is not the root.
 *
 * The links this instance wrote from the files that are gone go between the tree and the rows (`removeLinksOfDeletedFiles`; Q-464),
 * and a caller with an `actor` is told of every live file the rows retire, once each, as `file.deleted` (Q-469): read page by page
 * BEFORE a page is retired and announced once it has been, so a retry never announces a file twice, and none for a sidecar, a derived
 * row or one an earlier delete had flagged. With no actor (the shape every internal caller has) nothing is announced, on the webhook
 * and on the live view alike.
 */
export async function deleteDirectoryCascade(spaceId: string, dirPath: string, actor?: WebhookActor): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, dirPath);
  const present = await bytesPresent(abs);
  // Every file about to go — the folder tree (or, with the tree gone, every record under it) AND its conversion
  // sidecars — so each gets its tombstone. Without them a peer re-pushes the files on the next sync (resurrection).
  const tree = present
    ? await listFilesRecursive(spaceId, dirPath)
    : (await fileRecordPaths(spaceId, dirPath)).filter(p => p !== toDocId(dirPath));
  const sidecars = (await Promise.all(sidecarsOf(dirPath, 'directory').map(s => listFilesRecursive(spaceId, s.path)))).flat();
  // BEFORE the tree goes, pending (bundle-30 I13, I15, `files/tombstones.ts`): a store failure here leaves the tree in
  // place and the retry repeats the delete; written after, the retry answered 404 and no tombstone was ever written.
  // The tree's are published once the tree has gone, the sidecars' once THEY have — a later step, below (I16, P4-3) —
  // and a removal that stops part way publishes the files it did remove (P4-2): see `actUnderPendingTombstones`.
  const pending = await writePendingFileTombstones(spaceId, [...tree, ...sidecars], undefined, dirPath);
  let movedHere: MoveMarker[] = [];
  await actUnderPendingTombstones(pending, async () => {
    if (!present) return;
    movedHere = await removeWhatAMovedFileLeftAtItsSource(spaceId, dirPath, 'directory');
    await removeTree(abs, { mustExist: true });   // a converter may still be writing under it
    log.info(`Deleted directory ${peerText(dirPath)} (space: ${peerText(spaceId)})`);
  }, pendingAmong(pending, tree));
  invalidateUsageCache(); // freed disk — reflect it in the next quota check
  await removeWhatADirectoryLeftBesideItsRows(spaceId, dirPath);
  // That removal survives its own failure, so the sidecars' tombstones are settled from the disk: published where the
  // bytes went, dropped where they are still here.
  await settlePendingFileTombstones(pendingAmong(pending, sidecars));
  // The links this instance wrote from the files that are gone from disk (those a failure left standing keep theirs), before the rows
  // and called directly, so a failure fails the delete with the rows still there to find it owed.
  const surviving = await filesStillUnder(spaceId, dirPath);
  await removeLinksOfDeletedFiles(spaceId, dirPath, 'directory', { surviving });
  // LAST, as for one file: the records under the folder are what tell a retry this delete is still owed. Soft-flag
  // the user-visible file records (retain for audit) or hard-delete them; derived chunk records are always removed.
  await retireRowsUnderDirectory(spaceId, dirPath, announcedBy(spaceId, actor));
  // A link written while the rows were still live: the pass above again, bounded to links written by the instant the rows went.
  await removeLinksOfDeletedFiles(spaceId, dirPath, 'directory', { surviving: await filesStillUnder(spaceId, dirPath), createdUntil: new Date().toISOString() });
  for (const m of movedHere) await forgetFinishedMove(spaceId, m.from, m.to);
}

const directoryAt = (spaceId: string, dirPath: string): string => `for space ${peerText(spaceId)}, path ${peerText(dirPath)}`;

/**
 * What the files under a directory left BESIDE their rows, taken by prefix: their queued jobs, their conversion sidecars and the
 * cached hash of each. One command per kind of leaving whatever the number of files, which is why a directory's removal goes
 * through this and never through {@link removeFileHere} once per file. A store failure is thrown, so the act fails and its retry
 * completes it; any other failure is logged and survived (`unlessTheStoreFailed`). The rows are not here: they are the caller's,
 * LAST ({@link retireRowsUnderDirectory}), because they are what tells a retry the act is still owed.
 */
async function removeWhatADirectoryLeftBesideItsRows(spaceId: string, dirPath: string): Promise<void> {
  const at = directoryAt(spaceId, dirPath);
  // Queued jobs under the folder would outlive their sources and retry forever against paths that no longer exist.
  await unlessTheStoreFailed(`cancelJobsOwnedBy error ${at}`, () => cancelJobsOwnedBy(spaceId, dirPath, 'directory'));
  // Sidecar records and files (`_converted/<path>`, `_extracted/<path>`) live outside the folder prefix.
  await unlessTheStoreFailed(`deleteConversionArtifactsByPrefix error ${at}`, () => deleteConversionArtifactsByPrefix(spaceId, dirPath));
  // The cached hash of every file the tree held, as one file's delete forgets its own: the cache must not advertise a path nothing holds.
  await unlessTheStoreFailed(`forgetFileHashesByPrefix error ${at}`, () => forgetFileHashesByPrefix(spaceId, dirPath));
}

/**
 * The records under a directory, as the configured retention says (`retireFileMetaUnder`), failing with the store's failure.
 * `onRetired` is told the paths of each page of live files once the page is retired (the announcement a directory delete makes).
 */
async function retireRowsUnderDirectory(spaceId: string, dirPath: string, onRetired?: (paths: readonly string[]) => void): Promise<void> {
  await unlessTheStoreFailed(`retireFileMetaUnder error ${directoryAt(spaceId, dirPath)}`,
    () => retireFileMetaUnder(spaceId, dirPath, onRetired ? { onRetired } : {}));
}

/**
 * What a directory delete tells its subscribers about the files it removed: a `file.deleted` per path, as one file's delete tells it, and
 * for a caller with no actor nothing at all (the brain family's one rule; the TTL sweep, which has an actor of its own, still reports).
 */
function announcedBy(spaceId: string, actor: WebhookActor | undefined): (paths: readonly string[]) => void {
  return (paths) => {
    if (actor) for (const path of paths) emitWebhookEvent({ event: 'file.deleted', spaceId, entry: { path }, ...actor });
  };
}

/** The files still on disk under a directory, as ids: what a delete that stopped part way left, or a write into it meanwhile. None when the tree is gone. */
async function filesStillUnder(spaceId: string, dirPath: string): Promise<string[]> {
  return (await listFilesRecursive(spaceId, dirPath)).map(toDocId);
}

/**
 * A path deleted where a move carried a file TO it, while the move is still owed: whatever the move had not yet carried away from
 * its source goes with it, the records of `from` by the one list of what a file leaves ({@link removeFileHere}) — for a directory, by
 * the directory delete's own removal by prefix, not file by file — and the links this instance wrote from `from`
 * ({@link removeLinksOfDeletedFiles}, before the rows, as the cascade does): a link at the source is something of the file still there,
 * which keeps the move owed, so a delete that left it left the marker standing. Returns the moves,
 * so the caller clears their markers once the bytes at `to` are gone (before that the move still reads as owed: a link row
 * the delete does not remove keeps it so).
 *
 * ## What it prevents
 *
 * The file is deleted at the destination and the records stay at the source: a record listing a file that has no bytes anywhere,
 * which no delete reaches (the path it names has nothing to delete) and housekeeping finishes as a move whose bytes were deleted.
 *
 * Only a move that is OWED by `moveIsOwed` — the bytes at `to` are the moved ones — is acted on: an unrelated file that now stands
 * at `to` is deleted like any other and the source's records are left, since they are not what this delete was asked about.
 * Run BEFORE the bytes are removed, inside the act's pending tombstone: a failure here leaves the bytes where they are and
 * the delete still deletable.
 */
async function removeWhatAMovedFileLeftAtItsSource(spaceId: string, to: string, kind: PathKind): Promise<MoveMarker[]> {
  const carried: MoveMarker[] = [];
  for (const move of await movesBegunInto(spaceId, to)) {
    if (!(await moveIsOwed(spaceId, move.from, move.to))) continue;
    if (kind === 'directory') {
      await removeWhatADirectoryLeftBesideItsRows(spaceId, move.from);
      await removeLinksOfDeletedFiles(spaceId, move.from, 'directory', { surviving: await filesStillUnder(spaceId, move.from) });
      await retireRowsUnderDirectory(spaceId, move.from);
    } else {
      await removeLinksOfDeletedFiles(spaceId, move.from, 'file');
      await removeFileHere(spaceId, move.from, { failure: 'throw' });
    }
    carried.push(move);
  }
  return carried;
}

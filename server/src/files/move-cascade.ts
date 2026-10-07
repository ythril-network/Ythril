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
 * The tombstones for every path left behind are written FIRST, pending, before a byte moves, and each is published
 * only once ITS bytes have moved — the file's with the rename, a sidecar's after its own move — and dropped if they
 * did not (bundle-30 I13, I15, I16, see `files/tombstones.ts`). The bytes move or
 * the call throws. Everything after them survives its own failure, logged — but not the STORE's (bundle-30 I14): with
 * the store paused, a move used to carry the bytes, fail every record step and answer `200`, its metadata left at a
 * path with no file. Now that answers `503`, the metadata record is renamed last, and the retried move finds the
 * bytes at `dst`, the record at `src` and the MARKER its first attempt wrote with its tombstones, and completes the
 * steps it owes (`afterTheBytesMoved`). The marker is what makes it a move still owed: no bytes at `src` and a file
 * at `dst` is also an orphan `src` beside an unrelated file, which this used to "complete" by overwriting that file's
 * jobs, chunks and sidecars (preship-3 P3-2). A source that is not there, and owes nothing, is a `NotFoundError` (404
 * on both doors), checked before anything is written.
 */
import { moveFile, listFilesRecursive } from './files.js';
import { hasLiveFileRecordAt, renameFileMeta, renameFileMetaByPrefix } from './file-meta.js';
import { holdJobsForMove, releaseMoveHold, rekeyJobsForMove } from './media/job-queue.js';
import { movedId, movedSidecars, parentIdsUnder, type PathKind } from './moved-paths.js';
import { rekeyedRow } from '../sync/local-only-fields.js';
import { resolveSafePathChecked } from './sandbox.js';
import { bytesPresent, isStoredDirectory } from './stored-bytes.js';
import { actUnderPendingTombstones, forgetFinishedMove, moveWasBegun, pendingAmong, settleBegunMove, writePendingFileTombstones } from './tombstones.js';
import { NotFoundError } from '../util/errors.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { writeInOneCommands } from '../db/one-command.js';
import { spaceCollection } from '../db/space-collection.js';
import type { FileMetaDoc } from '../config/types.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { unlessTheStoreFailed } from '../brain/store-failure.js';
import { log, peerText } from '../util/log.js';

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Whether a space-relative path has bytes on disk (`bytesPresent`): a path outside the sandbox is the caller's
 * `RangeError`, and a failure to look is thrown — never read as "absent", which would send a move into its
 * completion path (preship-3 P3-6).
 */
const exists = async (spaceId: string, relPath: string): Promise<boolean> =>
  bytesPresent(await resolveSafePathChecked(spaceId, relPath));

/**
 * Every file path the move takes away, for the tombstones: the files themselves (`moved`, gone with the rename) and
 * their sidecars (`sidecars`, gone only once `afterTheBytesMoved` moves them, which can fail). Sync has no rename
 * detection, so a path without a tombstone is still advertised by a peer's manifest and comes back on the next pull.
 */
async function pathsLeaving(spaceId: string, src: string, dst: string): Promise<{ moved: string[]; sidecars: string[] }> {
  // What `src` IS decides which sidecars it owns, so it is read from the disk (`isStoredDirectory`), never inferred from whether it
  // has children: an empty directory has none and is still a directory, whose trees are not a file's converted Markdown.
  const kind = await kindAt(spaceId, src);
  const children = await listFilesRecursive(spaceId, src);
  const sidecars: string[] = [];
  for (const { from } of await movedSidecars(spaceId, src, dst, kind)) {
    const under = await listFilesRecursive(spaceId, from);
    if (under.length > 0) sidecars.push(...under);
    else if (await exists(spaceId, from)) sidecars.push(from);
  }
  return { moved: children.length > 0 ? children : [src], sidecars };
}

/** What the path at `relPath` is on disk — a directory or, whatever else, a file: the kind its sidecars are asked by. */
async function kindAt(spaceId: string, relPath: string): Promise<PathKind> {
  return await isStoredDirectory(await resolveSafePathChecked(spaceId, relPath)) ? 'directory' : 'file';
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
    // Written out again under a new identity, so it is a record written HERE and nobody's delivery (`rekeyedRow`).
    return rekeyedRow(d, { _id: id, path: id, parentFileId: movedId(d.parentFileId!, src, dst) ?? d.parentFileId, updatedAt: now });
  });
  await files.deleteMany(asFilter<FileMetaDoc>({ _id: { $in: [...derived.map(d => d._id), ...moved.map(d => d._id)] } }));
  // ONE insert command for anything within the driver's one-command limits, 99 999 rows and 16 MiB (`db/one-command.ts`), as the driver sent it
  // before the write was sliced. The file's derived rows are deleted BEFORE this insert, so a set larger than that — several commands — can
  // fail between two of them and leave the later rows deleted and not re-inserted: the limit of delete-then-insert, stated
  // here rather than hidden. Making it insert-first changes what the move does with a destination that is taken, and is owed
  // its own tests against the store.
  await writeInOneCommands(moved.map(d => asDoc<FileMetaDoc>(d)), (slice, { ordered }) => files.insertMany(slice, { ordered }), { ordered: true });
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
  if (!(await exists(spaceId, src))) {
    // The bytes already moved and the records did not: a move a store failure stopped after its bytes, completed —
    // but only a move begun HERE, which its marker says. Without it this is an orphan `src` beside whatever `dst` is.
    const owed = await exists(spaceId, dst) && await moveWasBegun(spaceId, src, dst) && await hasLiveFileRecordAt(spaceId, src);
    if (!owed) throw new NotFoundError(`Path '${src}' not found in space '${spaceId}'`);
    // Its tombstones were written before those bytes moved; `afterTheBytesMoved` settles any its first attempt left
    // pending, once the sidecars have had their turn.
    await afterTheBytesMoved(spaceId, src, dst, await holdJobsForMove(spaceId, src));
    emitWebhookEvent({ event: 'file.updated', spaceId, entry: { path: dst, previousPath: src }, ...(actor ?? {}) });
    return;
  }
  const { moved, sidecars } = await pathsLeaving(spaceId, src, dst);

  // The tombstones BEFORE the bytes move, pending (bundle-30 I13, I15, `files/tombstones.ts`): a store failure here
  // leaves the source where it was, so the retry repeats the move — written after, the retry found no source and the
  // paths left behind were never tombstoned. Each is published once ITS bytes have moved — the file's with the rename,
  // a sidecar's only after its own move (bundle-30 I16, preship-4 P4-3) — and dropped if they did not, since nobody
  // asked for those paths to go. Pending, no peer is told of them meanwhile.
  const pending = await writePendingFileTombstones(spaceId, [...moved, ...sidecars], { from: src, to: dst });
  let held: string[] = [];
  await actUnderPendingTombstones(pending, async () => {
    try {
      held = await holdJobsForMove(spaceId, src);
      await moveFile(spaceId, src, dst);
    } catch (err) {
      await releaseMoveHold(spaceId, held).catch(e => log.warn(`releaseMoveHold error for ${peerText(spaceId)}/${peerText(src)}: ${peerText(why(e))}`));
      throw err;
    }
  }, pendingAmong(pending, moved));
  await afterTheBytesMoved(spaceId, src, dst, held);
  emitWebhookEvent({ event: 'file.updated', spaceId, entry: { path: dst, previousPath: src }, ...(actor ?? {}) });
}

/**
 * Everything that follows the bytes, in the order a retry can finish (bundle-30 I14, verify-drive-4 D1): each step's
 * own failure is logged and survived, the STORE's fails the move (`unlessTheStoreFailed`, so the door answers `503`),
 * and the metadata record is renamed LAST — while it is still at `src`, the retry finds the move owed and completes
 * it here. Each step finds its work at `src`, so a step that already ran finds none.
 */
async function afterTheBytesMoved(spaceId: string, src: string, dst: string, held: string[]): Promise<void> {
  // The bytes have moved, so what the path IS is read where they went.
  for (const sidecar of await movedSidecars(spaceId, src, dst, await kindAt(spaceId, dst))) {
    if (!(await exists(spaceId, sidecar.from))) continue;
    await moveFile(spaceId, sidecar.from, sidecar.to).catch(err =>
      log.warn(`move sidecar error for ${peerText(spaceId)}, ${peerText(sidecar.from)} → ${peerText(sidecar.to)}: ${peerText(why(err))}`));
  }
  // Every byte this move will carry has moved, or failed to: the tombstones it left pending — the sidecars', and on a
  // retry any of the file's — are settled from the disk. A sidecar that could not move is still here, so its tombstone
  // is dropped rather than published (preship-4 P4-3).
  await settleBegunMove(spaceId, src, dst);
  const at = `for ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)}`;
  await unlessTheStoreFailed(`rekeyJobsForMove error ${at}`, () => rekeyJobsForMove(spaceId, src, dst, held));
  await unlessTheStoreFailed(`relocateDerivedFileMeta error ${at}`, () => relocateDerivedFileMeta(spaceId, src, dst));
  await unlessTheStoreFailed(`renameFileMeta error ${at}`, () => Promise.all([
    renameFileMeta(spaceId, src, dst),
    renameFileMetaByPrefix(spaceId, src, dst),
  ]));
  // Finished: nothing is owed, so its marker must not make a later orphan at `src` look like this move.
  await forgetFinishedMove(spaceId, src, dst);
}

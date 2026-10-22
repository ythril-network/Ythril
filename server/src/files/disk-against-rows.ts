/**
 * Which of a space's files disagree with their records: the bytes on disk read against the top-level file rows.
 *
 * ## The one question
 *
 * *"For this space, which files is the record out of step with the bytes - and how?"* Two callers ask it and must get the same answer
 * for the same input: the pull (`sync/file-sync.ts`, per path, to repair what an arrival left half-recorded) and the restore
 * (`db/restore-act.ts`, per space, to say what the backup's rows no longer describe - a backup carries the database and not the bytes).
 * The pull's classifier was private to its file; written a second time for the restore it would have been the defect this repository
 * produces most (one rule, two implementations), and a spelling difference between them - the manifest is keyed by the on-disk spelling
 * and the rows by `toDocId` (NFC) - reported a name stored NFD as two files, a missing row AND a row without bytes. So both sides are
 * matched through `toDocId` here, once, and the pull gets the fix too.
 *
 * ## The classes
 *
 * The first three are the pull's repair reasons ({@link FileRepairReason}, `files/bytes-arrived.ts`); the last two are the restore's own and
 * are NOT repair reasons - the pull's repair counters never produce them, and giving them a place there would invent counter values nothing
 * moves:
 *
 * - `missing_row`: bytes that no row names;
 * - `stale_row`: a live row whose sha256 is not the bytes';
 * - `unprocessed`: a live row of a class that processes, with no processing state;
 * - `row_without_bytes`: a live row that records bytes (a sha256) and finds none on disk. A row with no sha256 records no bytes (an import
 *   drops them) and is not this;
 * - `soft_deleted_with_bytes`: a soft-deleted row whose path has bytes again. A soft-deleted row with no bytes is as it should be.
 *
 * Never a file of a derived or instance-local tree (`isInstanceLocalFile`: conversion sidecars, conflict copies, schema snapshots, legacy
 * spills) on either side - none of them travels or is recorded as a file - and never a chunk or sidecar ROW (`parentFileId`).
 *
 * ## What it does not do
 *
 * It changes nothing: no bytes, no row, no tombstone (a tombstone written by a restore would delete a peer's copy) and not the hash
 * cache - the walk is {@link buildFileManifest}'s `readOnly` mode, so a walk a caller's time bound abandoned cannot write after it.
 */
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { withinHousekeepingBound } from '../db/write-bound.js';
import { toDocId } from '../util/paths.js';
import { isInstanceLocalFile } from '../sync/file-conflict.js';
import { buildFileManifest, type ManifestEntry } from './manifest.js';
import { resolveInputFormat } from './converters/pipeline.js';
import type { FileRepairReason } from './bytes-arrived.js';
import { FILE_MISMATCH_CLASSES, type FileMismatchClass } from './file-mismatch-classes.js';
import type { FileMetaDoc } from '../config/types.js';

export { FILE_MISMATCH_CLASSES, type FileMismatchClass };

/**
 * What a read of a space's top-level file rows keeps: the hash and processing state the row records, whether it is soft-deleted, and -
 * for the pull - the hash this instance and a peer last both held.
 */
export interface HeldRow { sha256?: string; embeddingStatus?: string; deletedAt?: string; syncBase?: Record<string, string> }

/**
 * Why the bytes already on disk at `key` (hash `diskSha256`) need their record brought up to date - or `null` when they do not.
 * Pure. The three reasons are the three ways an arrival leaves a file half-recorded: a row that says another hash than the disk
 * (the write that records the arrival failed and was swallowed, or an older release stored the row and not the new bytes'), no row
 * at all (the bytes are there and nothing names them: they are taken back, never recorded, because a row made here for them
 * would name this instance their author and deliverer), and a class that processes with no processing state (a release before
 * the pull dispatched). A soft-deleted row is not repaired: the file is deleted here, and what is on disk is not its bytes.
 */
export function repairReasonOf(row: HeldRow | undefined, diskSha256: string, key: string): FileRepairReason | null {
  if (!row) return 'missing_row';
  if (row.deletedAt !== undefined) return null;
  if (row.sha256 !== diskSha256) return 'stale_row';
  if (row.embeddingStatus === undefined && resolveInputFormat(key) !== 'text') return 'unprocessed';
  return null;
}

/** The peer a pull reads the agreed hash of: its instance id, and the Mongo path the base is kept under (`syncBasePath`). */
export interface HeldRowsPeer { peerId: string; baseKey: string }

type RowRead = FileMetaDoc & { syncBase?: Record<string, string> };

/**
 * The top-level file rows of a space as the comparison needs them, by id: a full cursor, projected, under the store bound, so a read
 * that hangs ends at the bound and is the caller's failure. Chunk and sidecar rows (`parentFileId`) are not files here. With `peer`, the
 * row also carries the base recorded for that peer.
 */
export async function heldRowsFor(spaceId: string, peer?: HeldRowsPeer): Promise<Map<string, HeldRow>> {
  return withinHousekeepingBound(async () => {
    const docs = await col<RowRead>(spaceCollection(spaceId, 'files'))
      .find(asFilter<RowRead>({ parentFileId: { $exists: false } }),
        { projection: { _id: 1, sha256: 1, embeddingStatus: 1, deletedAt: 1, ...(peer ? { [peer.baseKey]: 1 } : {}) } }).toArray();
    return new Map(docs.map(d => [String(d._id), {
      ...(d.sha256 !== undefined ? { sha256: d.sha256 } : {}),
      ...(d.embeddingStatus !== undefined ? { embeddingStatus: d.embeddingStatus } : {}),
      ...(d.deletedAt !== undefined ? { deletedAt: d.deletedAt } : {}),
      ...(peer && d.syncBase?.[peer.peerId] !== undefined ? { syncBase: { [peer.peerId]: String(d.syncBase[peer.peerId]) } } : {}),
    } satisfies HeldRow]));
  });
}

/**
 * The paths of each class, sorted, for the bytes `disk` lists against the rows `held`. Pure. Both sides are matched by `toDocId`, so a
 * name stored NFD is one file, and a path is reported in that spelling.
 */
export function classifyDiskAgainstRows(
  disk: readonly Pick<ManifestEntry, 'path' | 'sha256'>[],
  held: ReadonlyMap<string, HeldRow>,
): Record<FileMismatchClass, string[]> {
  const found: Record<FileMismatchClass, string[]> = {
    missing_row: [], stale_row: [], unprocessed: [], row_without_bytes: [], soft_deleted_with_bytes: [],
  };
  const onDisk = new Set<string>();
  for (const entry of disk) {
    const key = toDocId(entry.path);
    if (isInstanceLocalFile(key) || onDisk.has(key)) continue;
    onDisk.add(key);
    const row = held.get(key);
    const reason = repairReasonOf(row, entry.sha256, key);
    if (reason) found[reason].push(key);
    else if (row?.deletedAt !== undefined) found.soft_deleted_with_bytes.push(key);
  }
  for (const [id, row] of held) {
    if (row.deletedAt !== undefined || row.sha256 === undefined) continue;
    if (!onDisk.has(id) && !isInstanceLocalFile(id)) found.row_without_bytes.push(id);
  }
  for (const cls of FILE_MISMATCH_CLASSES) found[cls].sort();
  return found;
}

/**
 * The classes of a space's files NOW: the bytes read through `walk` (the caller's bound on a file-system step; the walk is read-only),
 * the rows read under the store bound. Throws what either read throws - the caller decides what a space it could not check means.
 */
export async function readDiskAgainstRows(
  spaceId: string,
  walk: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<Record<FileMismatchClass, string[]>> {
  const disk = await walk(() => buildFileManifest(spaceId, undefined, { readOnly: true }));
  return classifyDiskAgainstRows(disk, await heldRowsFor(spaceId));
}

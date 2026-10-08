/**
 * Take back the bytes a door wrote when the row that records them could not be written — the one answer to "the record failed
 * after the bytes landed, what is on disk now".
 *
 * ## What it prevents
 *
 * Every door that stores a file does it in two steps, bytes and then the row that names them. A failure between the two (a store
 * stall, a refused write) used to leave the bytes with NO row, and the doors answered it three ways: the manifest pull took the
 * bytes back (Q-254), the upload doors (a person's, a peer's, single and chunked) and `storeFile` (MCP `write_file`, the
 * conversation ingest) left them. Bytes with no row are offered by the next manifest, and a peer that fetches them records an
 * authorless seq-0 row, delivered by this instance, for a file nobody here authored. They are skipped as "already held" by the
 * next pull of the same hash, so nothing ever records them rightly. This is the pull's removal, written once, so a door that
 * writes bytes cannot leave out the half that undoes them.
 *
 * ## The rule
 *
 * Called by a door in the `catch` of its record step, with the error it is about to rethrow:
 *
 *  - NO live row for the path afterwards: the bytes are removed (under the stored-bytes door's lock), their cached hash is
 *    forgotten, and the usage cache is invalidated so the next quota check does not charge for the freed disk.
 *  - a live row for the path afterwards (an OVERWRITE whose row write failed): the bytes are KEPT. Removing them would leave a row
 *    that names a file that is not there, and the next upload of the path rewrites the row; the failure is the door's to rethrow,
 *    which is what the caller does either way.
 *  - the store is not answering (`cause`), or the row cannot be read: it cannot be told whether a row exists, and then the bytes
 *    are removed. The failure that left them is nearly always this one, bytes with no row are the worse state of the two, and the
 *    caller answered an error, so the sender sends the file again.
 *
 * The path is resolved HERE (`peerFileKey`) from the caller's spelling, so a caller cannot hand over a key and an absolute path
 * that disagree. A soft-deleted row (`LIVE_FILE_ROW`) is not a record of these bytes.
 *
 * **It never throws.** It runs inside the `catch` of the failure being reported and must not replace it. A failure to remove the
 * bytes is said once per window through the shared reporter, with the path as its unit; the bytes are then held with no row, which
 * the pull's repair records with no deliverer.
 */
import { deleteStoredIfPresent } from './stored-bytes.js';
import { forgetFileHashes } from './manifest.js';
import { hasLiveFileRecordExactlyAt } from './file-meta.js';
import { peerFileKey } from './sandbox.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { withinWriteBound } from '../db/write-bound.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';

/** The name a failure to take the bytes back is reported under: once per space and path per window. */
const CLEANUP_STEP = declareStep('Unrecorded bytes cleanup');

function sayCleanupFailure(spaceId: string, key: string, err: unknown): void {
  reportSpaceFailure(CLEANUP_STEP, spaceId, err, { unit: key, ...(storeIsNotAnswering(err) ? { kind: 'store-down' as const } : {}) });
}

/**
 * Whether a live row names `key`. A read that fails answers `false`: the caller then removes the bytes, as it does when the store
 * is known not to be answering.
 */
async function isRecorded(spaceId: string, key: string): Promise<boolean> {
  try {
    return await withinWriteBound(() => hasLiveFileRecordExactlyAt(spaceId, key));
  } catch {
    return false;
  }
}

/**
 * @param filePath the path as the door was given it (or the pull's key): resolved and symlink-checked here
 * @param cause the error the record step threw, which the caller rethrows; a store that is not answering is not asked for the row
 */
export async function removeUnrecordedBytes(spaceId: string, filePath: string, cause: unknown): Promise<void> {
  let key = filePath;
  try {
    const resolved = await peerFileKey(spaceId, filePath);
    key = resolved.key;
    if (!storeIsNotAnswering(cause) && await isRecorded(spaceId, key)) return;
    await deleteStoredIfPresent(resolved.abs);
  } catch (err) {
    sayCleanupFailure(spaceId, key, err);
    return;
  }
  invalidateUsageCache();   // freed disk: the next quota check must not charge for it
  try {
    await withinWriteBound(() => forgetFileHashes(spaceId, [key]));
  } catch (err) {
    sayCleanupFailure(spaceId, key, err);   // a stale cache entry for a missing file is pruned by the next full manifest walk
  }
}

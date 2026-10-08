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
 * Called by a door in the `catch` of its record step, and by the pull's repair for bytes it finds held with no row:
 *
 *  - the lookup ANSWERED, and no live row names the path: the bytes are removed (under the stored-bytes door's lock), their cached
 *    hash is forgotten, and the usage cache is invalidated so the next quota check does not charge for the freed disk.
 *  - the lookup answered, and a live row names the path (an OVERWRITE whose row write failed): the bytes are KEPT. Removing them
 *    would leave a row that names a file that is not there, and the next upload of the path rewrites the row; the failure is the
 *    door's to rethrow, which is what the caller does either way.
 *  - the lookup FAILED (the store is not answering): the bytes are KEPT. It cannot prove they are unrecorded, and removing the bytes
 *    of an overwrite whose row exists leaves a row naming absent bytes. Bytes with no row are the lesser harm of the two, because
 *    they do not stay: the next pull whose peer offers the path takes them back (this function, once the store answers), and a
 *    person's retry of the upload rewrites them. Said once per window through the shared reporter.
 *  - the failure that left the bytes unrecorded (`cause`) was ITSELF the store not answering: the bytes are KEPT, as above, and the
 *    store is not asked, and nothing is said here (the caller reports the failure it holds). The lookup would go to the store that just failed, and a read retries inside its bound until the bound
 *    ends, so the door's answer to a failure it already holds waited that bound out; under a fault that fails at once, the retries
 *    spun hot enough to exhaust the process (the store-failure gate's `write_file` door, bundle-48 Full run). The cause is a
 *    required argument so that a door cannot leave it out: one with no failure in hand (the pull's repair) passes `null`.
 *
 * It answers whether it took the bytes back, so a caller that counts the removal counts only a removal.
 *
 * The path is resolved HERE (`peerFileKey`) from the caller's spelling, so a caller cannot hand over a key and an absolute path
 * that disagree. A soft-deleted row (`LIVE_FILE_ROW`) is not a record of these bytes.
 *
 * **It never throws.** It runs inside the `catch` of the failure being reported and must not replace it. A failure to look the row
 * up or to remove the bytes is said once per window through the shared reporter, with the path as its unit.
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
 * @param filePath the path as the door was given it (or the pull's key): resolved and symlink-checked here
 * @param cause the failure of the record step that left the bytes unrecorded, or `null` when there is none (the pull's repair)
 * @returns whether the bytes were taken back: `false` when a live row names the path, and `false` when the lookup (or the removal)
 *   failed, which is said, never thrown, and `false` when the store was not asked because `cause` is the store not answering
 */
export async function removeUnrecordedBytes(spaceId: string, filePath: string, cause: unknown): Promise<boolean> {
  // Not said here: the failure is the caller's, which rethrows or reports it, and a second line would log the store's text twice.
  if (cause != null && storeIsNotAnswering(cause)) return false;
  let key = filePath;
  try {
    const resolved = await peerFileKey(spaceId, filePath);
    key = resolved.key;
    // A lookup that throws is NOT "no row": it lands in the catch below with the bytes still on disk.
    if (await withinWriteBound(() => hasLiveFileRecordExactlyAt(spaceId, key))) return false;
    await deleteStoredIfPresent(resolved.abs);
  } catch (err) {
    sayCleanupFailure(spaceId, key, err);
    return false;
  }
  invalidateUsageCache();   // freed disk: the next quota check must not charge for it
  try {
    await withinWriteBound(() => forgetFileHashes(spaceId, [key]));
  } catch (err) {
    sayCleanupFailure(spaceId, key, err);   // a stale cache entry for a missing file is pruned by the next full manifest walk
  }
  return true;
}

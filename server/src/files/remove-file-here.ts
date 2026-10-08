/**
 * Take ONE file out of this instance — everything the file left — after its bytes are gone. One answer, for every caller.
 *
 * ## What it prevents
 *
 * A file is not a blob. It is bytes, a queued media job, a conversion's chunk and face rows — to every level: an extracted
 * image's caption and faces hang from the image — its `_converted/` and `_extracted/` sidecars with the rows and jobs an arrival
 * made for them, a cached content hash, a figure in the usage cache and a metadata row. The local delete
 * (`deleteFileCascade`) removed all of them in one order; the media worker's `reconcileDeletedSource` hand-wrote a
 * second copy of the last three; and the two doors of a PEER's file tombstone each removed a different one of them — the
 * push route unlinked the bytes and left the row, the pull removed bytes and row and left the chunks, the job (retrying for
 * ever against a missing path) and the hash cache (bundle-51, Q-242). Three copies, three leftovers, none the cascade's.
 * Here the list is written once, so the next artefact a file gains is added once.
 *
 * ## The order, and why the row goes last
 *
 * The job, the conversion artefacts and the cached hash first; the metadata row LAST. While the row remains, a retry (or
 * the TTL sweep) finds this removal still owed and completes it — the row is the marker (bundle-30 I14). A soft delete
 * flags it (`deletedAt`) instead of removing it, and skips one already flagged (`markFileMetaDeleted`).
 *
 * ## The one parameter: what a step's failure means
 *
 * - `'throw'` — the caller's act must fail with the store's failure so its door answers `503` and the retry completes it
 *   (the cascade, a peer's tombstone: the apply stores the tombstone only AFTER the removal, so the sender's re-send of a page
 *   that failed re-applies it). A failure that is not
 *   the store's is logged and survived: the row is still removed last.
 * - `'swallow'` — a best-effort reconcile that has nothing to retry with (the media worker, finding its source gone):
 *   every failure is logged and the next step still runs.
 *
 * It does NOT remove the bytes (the callers hold them under their own locks and their own tombstone ordering) and it does
 * NOT touch tombstones (a tombstone is the act's, written before and published after it).
 */
import { log, peerText } from '../util/log.js';
import { unlessTheStoreFailed } from '../brain/store-failure.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { cancelMediaJob } from './media/job-queue.js';
import { deleteConversionArtifacts } from './converters/pipeline.js';
import { forgetFileHashes } from './manifest.js';
import { retireFileMeta } from './file-meta.js';
import { deleteStoredIfPresent } from './stored-bytes.js';

export type RemovalFailure = 'throw' | 'swallow';

export async function removeFileHere(spaceId: string, rel: string, { failure }: { failure: RemovalFailure }): Promise<void> {
  const at = `for ${peerText(spaceId)}/${peerText(rel)}`;
  const step = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    if (failure === 'throw') { await unlessTheStoreFailed(`${what} error ${at}`, run); return; }
    await run().catch(err => log.warn(`removeFileHere: ${peerText(what)} ${at}: ${peerText(err)}`));
  };
  invalidateUsageCache(); // freed disk — reflect it in the next quota check
  // Cancel any queued media/text job so it cannot outlive the file and retry forever.
  await step('cancelMediaJob', () => cancelMediaJob(spaceId, rel));
  await step('deleteConversionArtifacts', () => deleteConversionArtifacts(spaceId, rel));
  await step('forgetFileHashes', () => forgetFileHashes(spaceId, [rel]));
  // LAST: while the record remains, a retry (or the TTL sweep) completes this delete as an orphan.
  // Soft-flag it (retained for audit) or hard-delete it, per softDeleteFileMeta — as every sidecar row an arrival made went above.
  await step('retireFileMeta', () => retireFileMeta(spaceId, rel));
}

/**
 * Remove ONE file a PEER's act (or this instance's own housekeeping of what a peer delivered) condemns: its bytes, then everything
 * it left, failing with the store's failure.
 *
 * ## What it prevents
 *
 * The same two lines — the unlink of ONE path, a directory there left alone, then {@link removeFileHere} with `'throw'` — were
 * written by a peer's file tombstone and again by the retirement of a peer's sidecars, each a place to forget that the path came
 * from outside and means one file. Dropping the `skipDirectory` half lets one peer-chosen path take a whole tree with it; putting
 * the row before the bytes loses the marker a retry needs. Here the order and the guard are written once.
 *
 * `abs` is the path the caller resolved and holds the tombstone ordering for (a peer's tombstone resolves it up front, with the
 * rest of its page). A path that is already gone is not an error, and the row and its leavings are removed all the same.
 */
export async function removeOneStoredFileHere(spaceId: string, rel: string, abs: string): Promise<void> {
  await deleteStoredIfPresent(abs, { skipDirectory: true });
  await removeFileHere(spaceId, rel, { failure: 'throw' });
}

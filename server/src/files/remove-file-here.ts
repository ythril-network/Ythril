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
 * NOT touch tombstones (a tombstone is the act's, written before and published after it). **And it does not remove the file's links,
 * on purpose**: a link is a record of whoever wrote it, so only a delete THIS instance makes takes the links this instance wrote
 * ({@link removeLinksOfDeletedFiles}, below, called by the local cascade around this one). The media worker's reconcile and a
 * peer's file tombstone come through here too, and a peer deleting its copy of a file is not this instance deciding that the people,
 * facts and chrono entries its links name are no longer the file's (ADR 05).
 */
import { log, peerText } from '../util/log.js';
import { toDocId } from '../util/paths.js';
import { fileLinkSourcesOf } from '../brain/link-adjacency.js';
import { removeFileLinksThisInstanceWrote } from '../brain/links.js';
import { isDerivedRowOf, type PathKind } from './moved-paths.js';
import { topLevelFilesAmong } from './derived-rows.js';
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

/**
 * Remove the links THIS instance wrote from the files a delete took, from each file and from its derived ids, and write their
 * tombstones, so no peer restores them. The delete's own step, written ONCE for a file, a directory and the source a moved file left.
 *
 * ## What it prevents
 *
 * A link hangs off a path. A delete that left its links behind gave them to whatever was uploaded at the path next (a face
 * auto-labelling reads them), kept a stopped move owed for ever (a link at the source is something of the file still there) and let
 * the links of every file in a deleted directory outlive it. They are removed in the cascade's order: the bytes, then THIS, then the
 * row. The row is last because it is what tells a retry (REST, MCP, the TTL sweep, a peer's re-sent tombstone) the delete is still
 * owed, so a failure here leaves the act owed and is THROWN: callers call this directly and never through a step that logs and
 * survives a failure (`file-mutation-tools-state-their-cascade.test.js` holds both the order and the direct call).
 *
 * ## What it removes, and what it leaves
 *
 * The links `fileLinkSourcesOf` names for `path` as a `kind`, written by this instance or by nobody who signed them. A link
 * ANOTHER instance wrote stays with it: its file's tombstone does not carry it, and removing it here would be one instance deciding
 * for another (ADR 05; the wider rule is the owner's decision D-31). A link that points AT a file from a fact or a chrono entry is not
 * file-sourced and is not touched. `surviving` are file ids still on disk under `path` (a directory delete that stopped part way,
 * or a file written into it meanwhile): their links, and those of their derived ids, stay. `createdUntil` ends the read at an
 * instant: the second pass, made once the row is gone, asks with the instant it went, so it catches a link written while the row was
 * still live and never the new link of a file uploaded at the path since.
 *
 * Batched: a command per `READ_CHUNK` sources however many files there are, never one per file. Returns how many links it removed.
 */
export async function removeLinksOfDeletedFiles(
  spaceId: string, path: string, kind: PathKind,
  { surviving = [], createdUntil }: { surviving?: readonly string[]; createdUntil?: string } = {},
): Promise<number> {
  let sources = await fileLinkSourcesOf(spaceId, path, kind);
  if (surviving.length > 0) {
    const alive = new Set(surviving.map(toDocId));
    // A derived row of a file that is still there goes with that file, never ahead of it; one that is a top-level file of its own is read as that file.
    const derived = sources.filter(s => s.includes('#') && !alive.has(s));
    const topLevel = await topLevelFilesAmong(spaceId, derived);
    const survivors = [...alive];
    const ofSurvivor = (s: string): boolean => s.includes('#') && survivors.some(a => isDerivedRowOf(s, a, topLevel));
    sources = sources.filter(s => !alive.has(s) && !ofSurvivor(s));
  }
  const removed = await removeFileLinksThisInstanceWrote(spaceId, sources, createdUntil === undefined ? {} : { createdUntil });
  if (kind === 'directory' && removed > 0) log.info(`Removed ${removed} link(s) of the files of directory ${peerText(path)} (space: ${peerText(spaceId)})`);
  return removed;
}

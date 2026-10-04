/**
 * Full file deletion — one cascade, shared by every delete path.
 *
 * Deleting a file is not just unlinking the blob: it must also propagate a sync tombstone (or a peer's
 * manifest re-pushes the file), remove or soft-flag the metadata record, cancel any queued media/text job
 * (a stale job retries forever against the missing path), and delete conversion artifacts. This exact
 * sequence was duplicated in the REST `DELETE /api/files/:spaceId` handler and the MCP `delete_file` tool;
 * it lives here so both — and the TTL sweep (F12) — clean up identically and no path orphans bytes, jobs
 * or artifacts.
 *
 * ## The order, and what each failure leaves (bundle-30 I13)
 *
 * The path is resolved first (a path outside the space is the caller's `RangeError`, before anything is written),
 * then the TOMBSTONE, then the bytes — see `files/tombstones.ts` for why the tombstone must not come after. A store
 * failure on it throws with the file untouched, so the retry repeats the whole cascade.
 *
 * **A file whose bytes are already gone and whose metadata remains** (removed out of band, or by a cascade an older
 * version could not finish) is COMPLETED here: tombstone, metadata, jobs, artifacts, webhook — rather than left for
 * each door to special-case. The REST door answered that case itself and wrote no tombstone, and the TTL sweep
 * failed on it for ever. **A path with neither bytes nor metadata** is a `NotFoundError`: `404` on REST, on
 * `/api/delete_file` and in MCP's error result — it used to reach MCP as the filesystem's `ENOENT`, carrying the
 * absolute data path.
 *
 * Metadata / job / artifact cleanup is best-effort — logged, never fatal, because the bytes are already gone and a
 * failed secondary cleanup must not leave the delete half-done from the caller's perspective.
 */
import fs from 'fs/promises';
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { NotFoundError } from '../util/errors.js';
import { toDocId } from '../util/paths.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import type { FileMetaDoc } from '../config/types.js';
import { resolveSafePathChecked } from './sandbox.js';
import { deleteStored } from './stored-bytes.js';
import { deleteFileMeta, markFileMetaDeleted } from './file-meta.js';
import { cancelMediaJob } from './media/job-queue.js';
import { deleteConversionArtifacts } from './converters/pipeline.js';
import { writeFileTombstones } from './tombstones.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Whether the bytes are on disk. Only "not there" is an answer; any other failure to look is the caller's to see. */
async function bytesPresent(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function deleteFileCascade(spaceId: string, filePath: string, actor?: WebhookActor): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, filePath);
  const present = await bytesPresent(abs);
  if (!present) {
    const known = await col<FileMetaDoc>(spaceCollection(spaceId, 'files'))
      .findOne(asFilter<FileMetaDoc>({ _id: toDocId(filePath) }), { projection: { _id: 1 } });
    if (!known) throw new NotFoundError(`File '${filePath}' not found in space '${spaceId}'`);
  }
  // BEFORE the bytes go: a peer's manifest re-pushes a file it has no tombstone for, and nothing writes it later.
  await writeFileTombstones(spaceId, [filePath]);
  // A concurrent delete that got there first has done this half; anything else is the caller's failure.
  if (present) await deleteStored(abs).catch(err => { if (!isMissing(err)) throw err; });
  // Metadata: soft-flag (retain for audit) or hard-delete, per softDeleteFileMeta.
  if (getConfig().softDeleteFileMeta === true) {
    await markFileMetaDeleted(spaceId, filePath).catch(err => log.warn(`markFileMetaDeleted error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`));
  } else {
    await deleteFileMeta(spaceId, filePath).catch(err => log.warn(`deleteFileMeta error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`));
  }
  // Cancel any queued media/text job so it cannot outlive the file and retry forever.
  await cancelMediaJob(spaceId, filePath).catch(err => log.warn(`cancelMediaJob error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`));
  await deleteConversionArtifacts(spaceId, filePath).catch(err => log.warn(`deleteConversionArtifacts error for ${peerText(spaceId)}/${peerText(filePath)}: ${peerText(err)}`));
  invalidateUsageCache(); // freed disk — reflect it in the next quota check
  emitWebhookEvent({ event: 'file.deleted', spaceId, entry: { path: filePath }, ...(actor ?? {}) });
}

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
 * The blob unlink and the tombstone write may throw (the caller decides how to respond). Metadata / job /
 * artifact cleanup is best-effort — logged, never fatal, because the bytes are already gone and a failed
 * secondary cleanup must not leave the delete half-done from the caller's perspective.
 */
import { getConfig } from '../config/loader.js';
import { log, peerText } from '../util/log.js';
import { deleteFile } from './files.js';
import { deleteFileMeta, markFileMetaDeleted } from './file-meta.js';
import { cancelMediaJob } from './media/job-queue.js';
import { deleteConversionArtifacts } from './converters/pipeline.js';
import { writeFileTombstones } from './tombstones.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';

export async function deleteFileCascade(spaceId: string, filePath: string, actor?: WebhookActor): Promise<void> {
  await deleteFile(spaceId, filePath);
  // Propagate the deletion to sync peers, else the peer's manifest re-pushes the file.
  await writeFileTombstones(spaceId, [filePath]);
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

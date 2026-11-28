/**
 * What this instance and one peer last agreed a file is, and what a peer's other copy of it becomes: the decision both byte doors
 * (the pull in `sync/file-sync.ts` and the peer upload at `POST /api/files/:spaceId`) take, and the records it leaves.
 *
 * ## What it prevents
 *
 * A file has no `seq`, so two copies with different bytes cannot be ordered: the rule (`decideFilePull`) replaces ours only when ours is
 * still the hash both last held (`syncBase.<peer>`), and otherwise keeps ours and saves theirs as a conflict copy. The pull asked it; the
 * upload door a peer pushes to did not, and stored a peer's bytes over the live file whenever no tombstone spoke (Q-410). So a sender
 * with no agreed hash whose clock ran ahead, or any client holding a peer token, overwrote local work with nothing to recover from.
 * Both doors now ask {@link decidePeerCopy}, record a conflict through {@link recordFileConflict} and an agreement through
 * {@link recordSyncBase}, so the two cannot answer the same situation differently.
 *
 * The agreed hash is LOCAL state, never replicated (the ingest schema does not declare `syncBase`, and the space hash leaves it out).
 */
import { v4 as uuidv4 } from 'uuid';
import type { ConflictDoc, FileMetaDoc } from '../config/types.js';
import { col, asFilter, asDoc, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { log, peerText } from '../util/log.js';
import { toDocId } from '../util/paths.js';
import { assertSpaceTakesWrites, isActRefusal } from '../spaces/space-write-gate.js';
import { decideFilePull, type FilePullAction } from './file-conflict.js';

/** A file row with the agreed hash per peer (`syncBase.<peer instance id>`). */
export type SyncedFileMeta = FileMetaDoc & { syncBase?: Record<string, string> };

/**
 * The Mongo path of the base recorded for `peerId` (`syncBase.<peer instance id>`): the ONE place the key is formed, read by the
 * pull, the push door and the file stamp report.
 */
export function syncBasePath(peerId: string): string {
  return `syncBase.${peerId}`;
}

/** Record that this instance and `peerId` now both hold `sha256` for the file at `filePath`. A space an act holds is left alone. */
export async function recordSyncBase(spaceId: string, filePath: string, peerId: string, sha256: string): Promise<void> {
  try { assertSpaceTakesWrites(spaceId, 'files'); } catch (err) { if (isActRefusal(err)) return; throw err; }
  await col<SyncedFileMeta>(spaceCollection(spaceId, 'files'))
    .updateOne(asFilter<SyncedFileMeta>({ _id: filePath }), asUpdate<SyncedFileMeta>({ $set: { [syncBasePath(peerId)]: sha256 } }))
    .catch(err => log.warn(`recordSyncBase ${peerText(filePath)}: ${peerText(err)}`));
}

/**
 * What a peer's copy of the file at `key` (resolved key, never the peer's spelling) with `incomingSha256` becomes here, read from the
 * live row: `write` (no live file), `skip` (the same bytes, or the agreed version while ours moved on), `replace` (ours is still the
 * agreed version) or `conflict-copy`. A row deleted here, or one with no hash recorded, is no live copy to keep.
 */
export async function decidePeerCopy(
  spaceId: string, key: string, incomingSha256: string, peerId: string,
): Promise<{ action: FilePullAction; sameBytes: boolean }> {
  const row = await col<SyncedFileMeta>(spaceCollection(spaceId, 'files')).findOne(
    asFilter<SyncedFileMeta>({ _id: toDocId(key) }),
    { projection: { sha256: 1, deletedAt: 1, [syncBasePath(peerId)]: 1 } },
  );
  const live = row && !row.deletedAt && typeof row.sha256 === 'string' ? { path: key, sha256: row.sha256 } : undefined;
  const base = row?.syncBase?.[peerId];
  const action = decideFilePull(live, { path: key, sha256: incomingSha256 }, typeof base === 'string' ? base : undefined);
  return { action, sameBytes: live?.sha256 === incomingSha256 };
}

/**
 * Record a conflict: ours kept at `originalPath`, the peer's bytes saved at `conflictPath`, for the operator to settle in Settings ->
 * Conflicts. Logged once as `FILE_CONFLICT`, the same line whichever door met it.
 */
export async function recordFileConflict(
  spaceId: string, originalPath: string, conflictPath: string, peer: { instanceId: string; label: string },
): Promise<void> {
  const conflictDoc: ConflictDoc = {
    _id: uuidv4(),
    spaceId,
    originalPath,
    conflictPath,
    peerInstanceId: peer.instanceId,
    peerInstanceLabel: peer.label,
    detectedAt: new Date().toISOString(),
  };
  await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts')).insertOne(asDoc<ConflictDoc>(conflictDoc));
  log.warn(
    `FILE_CONFLICT: '${peerText(originalPath)}' from peer '${peerText(peer.label)}' differs from local copy. `
    + `Conflict copy saved as '${peerText(conflictPath)}'. Resolve in Settings → Conflicts.`,
  );
}

/**
 * File sync tombstones.
 *
 * A `FileTombstoneDoc` in the per-space `<spaceId>_file_tombstones` collection
 * records that a file was deleted locally. The sync engine pushes these to peers,
 * which then unlink the file and drop its metadata — without them, a peer's manifest
 * still advertises the file and pushes it straight back (resurrection). Every code
 * path that deletes a file (API, folder delete, MCP) must write one.
 *
 * ## The tombstone is written BEFORE the bytes go (bundle-30 I13)
 *
 * Every path that removes a file — `deleteFileCascade`, the directory delete, `moveFileCascade` — writes the tombstone
 * first and only then unlinks, removes or moves. The two orders fail differently, and only one of them recovers:
 *
 * - **A tombstone for a removal that then failed** names a file the caller asked to remove and was told was not. The
 *   caller's retry completes it, and a peer that applied the tombstone meanwhile holds what it would hold after a
 *   delete followed by a re-upload — a state sync already lives with. A move that fails withdraws the tombstones it
 *   wrote (`withdrawFileTombstones`), because nobody asked for that path to go.
 * - **Bytes gone with no tombstone** is repaired by nothing: the retry finds no file, and a peer's manifest pushes it
 *   back for good. That is what I12's rethrow produced while the write ran after the unlink — the retried REST
 *   delete took its orphan branch and wrote none, the directory delete answered 404, the move found no source, and
 *   the TTL sweep met ENOENT on every cycle.
 *
 * So a store failure here leaves the file exactly where it was, the caller is answered `503`, and the retry repeats
 * the whole act. A file whose bytes are already gone while its metadata remains is completed by the cascade
 * (`files/delete-cascade.ts`), tombstone included.
 */

import { v4 as uuidv4 } from 'uuid';
import { toDocId } from '../util/paths.js';
import { col, asDoc, asFilter } from '../db/mongo.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { log, peerText } from '../util/log.js';
import { throwIfStoreSide } from '../brain/store-failure.js';
import { spaceCollection } from '../db/space-collection.js';

/**
 * Insert a sync tombstone for each of `paths` so peers remove the files too, and answer the ids written (none when
 * the write failed on a condition that is not the store's).
 * Paths are normalised (forward slashes, no leading slash) and deduped.
 * Best-effort for a failure that is not the store's (logged, the act goes on); a STORE failure is thrown, so the door
 * answers it as every door answers one and the caller knows to retry (bundle-30 I12) — and since it is written before
 * the bytes go, nothing has happened yet that the retry would miss.
 */
export async function writeFileTombstones(spaceId: string, paths: string[]): Promise<string[]> {
  const unique = [...new Set(paths.map(toDocId))].filter(Boolean);
  if (unique.length === 0) return [];
  const now = new Date().toISOString();
  const docs: FileTombstoneDoc[] = unique.map(p => ({ _id: uuidv4(), spaceId, path: p, deletedAt: now }));
  try {
    await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones')).insertMany(docs.map(d => asDoc<FileTombstoneDoc>(d)));
    return docs.map(d => d._id);
  } catch (err) {
    throwIfStoreSide(err);
    log.warn(`writeFileTombstones error for space ${peerText(spaceId)} (${unique.length} paths): ${peerText(err)}`);
    return [];
  }
}

/**
 * Remove tombstones this instance just wrote for an act that then failed — a move whose bytes did not move. Best
 * effort and logged: a tombstone left behind names a file that is still here — the state a delete followed by a
 * re-upload leaves, which sync already lives with (see the module docblock); what must never happen is the reverse.
 */
export async function withdrawFileTombstones(spaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'))
    .deleteMany(asFilter<FileTombstoneDoc>({ _id: { $in: [...ids] } }))
    .catch(err => log.warn(`withdrawFileTombstones error for space ${peerText(spaceId)} (${ids.length}): ${peerText(err)}`));
}

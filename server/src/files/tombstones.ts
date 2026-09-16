/**
 * File sync tombstones.
 *
 * A `FileTombstoneDoc` in the per-space `<spaceId>_file_tombstones` collection
 * records that a file was deleted locally. The sync engine pushes these to peers,
 * which then unlink the file and drop its metadata — without them, a peer's manifest
 * still advertises the file and pushes it straight back (resurrection). Every code
 * path that deletes a file (API, folder delete, MCP) must write one.
 */

import { v4 as uuidv4 } from 'uuid';
import { toDocId } from '../util/paths.js';
import { col, asDoc } from '../db/mongo.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { log } from '../util/log.js';
import { spaceCollection } from '../db/space-collection.js';

/**
 * Insert a sync tombstone for each of `paths` so peers remove the files too.
 * Paths are normalised (forward slashes, no leading slash) and deduped.
 * Best-effort — logs on failure rather than throwing, so a delete still returns success.
 */
export async function writeFileTombstones(spaceId: string, paths: string[]): Promise<void> {
  const unique = [...new Set(paths.map(toDocId))].filter(Boolean);
  if (unique.length === 0) return;
  const now = new Date().toISOString();
  const docs: FileTombstoneDoc[] = unique.map(p => ({ _id: uuidv4(), spaceId, path: p, deletedAt: now }));
  try {
    await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones')).insertMany(docs.map(d => asDoc<FileTombstoneDoc>(d)));
  } catch (err) {
    log.warn(`writeFileTombstones error for space ${spaceId} (${unique.length} paths): ${err instanceof Error ? err.message : String(err)}`);
  }
}

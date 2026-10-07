/**
 * Which file bytes a peer has TOLD this instance it holds a tombstone for — so a push is not repeated for ever (bundle-51, Q-229).
 *
 * ## What it prevents
 *
 * A peer that holds a tombstone for a path answers an upload of the deleted bytes `200 { tombstoned: true }` and stores
 * nothing (`api/files-upload.ts`). The answer is a success — an older sender would read any 4xx as a failure and upload the
 * whole file again every cycle — but the SENDER's manifest comparison still finds the peer without the file, so without a
 * memory of the answer it uploads the same bytes every cycle too: the same cost, with a 200 on it. Told once, it skips the
 * path while its own hash for it is unchanged, and uploads again the moment the file changes (a new version is not the
 * one the tombstone erased).
 *
 * ## Why in memory
 *
 * It is a saving, never a rule: a restart forgets it and costs one more upload per path, answered the same way, and nothing
 * is lost. A persisted copy would be one more local field on a replicated row (classified, restored, exported) for a
 * saving that is only ever one request. Bounded (`LruMap`, least recently used out), so a space of ten thousand deleted
 * files costs a fixed amount of memory.
 */
import { LruMap } from '../util/lru-map.js';

const MAX_TOLD = 10_000;
const told = new LruMap<string, string>(MAX_TOLD);

const keyOf = (peerId: string, spaceId: string, path: string): string => JSON.stringify([peerId, spaceId, path]);

/** Remember that `peerId` answered an upload of `path` with `sha256` as a deleted file's bytes. */
export function noteToldTombstoned(peerId: string, spaceId: string, path: string, sha256: string): void {
  told.set(keyOf(peerId, spaceId, path), sha256);
}

/** Was this exact content of `path` told to be a deleted file's, by `peerId`? A changed hash is a new version: not told. */
export function wasToldTombstoned(peerId: string, spaceId: string, path: string, sha256: string): boolean {
  return told.get(keyOf(peerId, spaceId, path)) === sha256;
}

/** Forget everything told. For tests. */
export function forgetToldTombstoned(): void { told.clear(); }

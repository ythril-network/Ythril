/**
 * What a peer has ANSWERED to an upload of exact bytes, remembered so the same bytes are not sent again to be answered the same
 * way: that it holds a tombstone for them (bundle-51, Q-229), and that it refused them (bundle-48, Q-296).
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
 * A REFUSAL is the same shape with a worse bill. A chunked upload is judged at its last chunk (the assembled hash is not the
 * one promised, `x-expected-sha256`), so a file the receiver will refuse costs the whole file before it says so, and the
 * sender's next cycle finds the peer still without the file and sends the whole file again. Refused once, the same bytes of
 * the same path are not offered to the same peer again until they change.
 *
 * ## One module, two memories
 *
 * The two are one question asked of two answers (`uploadAnswerMemory`: peer, space, path, hash), kept as two INSTANCES so that a
 * refusal is never read as a tombstone (a tombstone's own `wasToldTombstoned` is what `decideFilePush` reads first) and
 * neither can evict the other's entries. A per-answer flag would be one memory answering two questions.
 *
 * ## Why in memory
 *
 * It is a saving, never a rule: a restart forgets it and costs one more upload per path, answered the same way, and nothing
 * is lost. A persisted copy would be one more local field on a replicated row (classified, restored, exported) for a
 * saving that is only ever one request. Bounded (`LruMap`, least recently used out), so a space of ten thousand deleted
 * files costs a fixed amount of memory.
 */
import { LruMap } from '../util/lru-map.js';

const MAX_REMEMBERED = 10_000;

/** What a peer answered about the content (`sha256`) of a path in a space: remembered, bounded, forgotten when the content changes. */
export interface UploadAnswerMemory {
  /** Remember that `peerId` gave this answer to an upload of `path` with `sha256`. */
  note(peerId: string, spaceId: string, path: string, sha256: string): void;
  /** Was this exact content of `path` given that answer by `peerId`? A changed hash is a new version: not remembered. */
  was(peerId: string, spaceId: string, path: string, sha256: string): boolean;
  /** Forget everything remembered. For tests. */
  clear(): void;
}

const keyOf = (peerId: string, spaceId: string, path: string): string => JSON.stringify([peerId, spaceId, path]);

/** One bounded memory of a peer's answers to uploads. Each answer worth remembering has its own instance. */
export function uploadAnswerMemory(): UploadAnswerMemory {
  const answers = new LruMap<string, string>(MAX_REMEMBERED);
  return {
    note: (peerId, spaceId, path, sha256) => { answers.set(keyOf(peerId, spaceId, path), sha256); },
    was: (peerId, spaceId, path, sha256) => answers.get(keyOf(peerId, spaceId, path)) === sha256,
    clear: () => { answers.clear(); },
  };
}

const told = uploadAnswerMemory();
const refused = uploadAnswerMemory();

/** Remember that `peerId` answered an upload of `path` with `sha256` as a deleted file's bytes. */
export function noteToldTombstoned(peerId: string, spaceId: string, path: string, sha256: string): void {
  told.note(peerId, spaceId, path, sha256);
}

/** Was this exact content of `path` told to be a deleted file's, by `peerId`? A changed hash is a new version: not told. */
export function wasToldTombstoned(peerId: string, spaceId: string, path: string, sha256: string): boolean {
  return told.was(peerId, spaceId, path, sha256);
}

/** Forget everything told. For tests. */
export function forgetToldTombstoned(): void { told.clear(); }

/** Remember that `peerId` REFUSED an upload of `path` with `sha256` (a 4xx that is about these bytes, not about the moment). */
export function noteRefusedUpload(peerId: string, spaceId: string, path: string, sha256: string): void {
  refused.note(peerId, spaceId, path, sha256);
}

/** Did `peerId` refuse exactly this content of `path`? A changed hash is a new version: not refused. */
export function wasRefusedUpload(peerId: string, spaceId: string, path: string, sha256: string): boolean {
  return refused.was(peerId, spaceId, path, sha256);
}

/** Forget every refusal. For tests. */
export function forgetRefusedUploads(): void { refused.clear(); }

import { warnOnce } from '../util/warn-once.js';

/**
 * Stored files this process found present but undecodable — a foreign key, altered bytes, or an encrypted file on
 * an instance with no secret (F-43) — and the paths whose LOOK failed (a refused `stat` or `readdir`, an I/O error at the open).
 *
 * **Two different things, one memory.** This module only answers "is this news, so should it be logged": the first time a path is met, and
 * again after it changed. What the manifest ENDS UP SAYING about a path is not decided here. A CONTENT verdict (the file was read and cannot
 * be decoded) is a skip the peer's copy answers by landing beside it, so the manifest leaves it out and does not name it. A failure to LOOK
 * (a path that is neither present nor absent as far as this process could tell) is named in the manifest's `unreadable`
 * (`files/manifest.ts`, `files/unreadable-paths.ts`), and every reader of the manifest (the hash cache's prune, the wire, file sync, the
 * restore check) keeps it apart from a path that is gone. This module is the log's, never a reader's.
 *
 * Two reasons it is kept, and both are why it is one module rather than a Set in each reader:
 *
 * - **Warn once, not every cycle.** The manifest is rebuilt on every sync cycle and skips such a file each time; a
 *   warning per cycle is a line a minute per file for ever, and an operator learns to scroll past the one signal
 *   that says data cannot be read. A file is reported again only once it has changed (a new mtime or size).
 * - **The security posture counts them.** Without this the count exists only in scattered log lines.
 *
 * In memory on purpose: a restart re-finds every such file on the first manifest or migration pass, and a stored
 * list would outlive the fix that made a file readable again.
 *
 * "Is this news" is `util/warn-once.ts`'s question, with the file's version (size and mtime) as the report's version.
 * Bounded there, at `MAX_TRACKED`: past it the least recently reported file is forgotten, so the posture count is a
 * floor rather than growing without limit on a store full of unreadable files — a forgotten one is re-found, and
 * counted again, on the next manifest pass.
 */
const MAX_TRACKED = 100_000;
const seen = warnOnce<string>({ max: MAX_TRACKED });
const keyOf = (spaceId: string, relPath: string): string => `${spaceId}\0${relPath}`;

/**
 * Record `relPath` in `spaceId` as unreadable. Returns true when this is news — first seen, or seen again after it
 * changed — which is when a caller should log it.
 */
export function noteUnreadable(spaceId: string, relPath: string, version: string): boolean {
  // The report itself is the caller's (it logs the reason it has); here only "is this news" is answered.
  return seen(keyOf(spaceId, relPath), () => {}, version);
}

/** Forget a file that has been read successfully, deleted, or replaced. */
export function clearUnreadable(spaceId: string, relPath: string): void { seen.forget(keyOf(spaceId, relPath)); }

/** How many stored files are currently known to be unreadable. */
export function unreadableCount(): number { return seen.size; }

/**
 * Stored files this process found present but undecodable — a foreign key, altered bytes, or an encrypted file on
 * an instance with no secret (F-43).
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
 */
const seen = new Map<string, string>();
const keyOf = (spaceId: string, relPath: string): string => `${spaceId}\0${relPath}`;

/**
 * Record `relPath` in `spaceId` as unreadable. Returns true when this is news — first seen, or seen again after it
 * changed — which is when a caller should log it.
 */
export function noteUnreadable(spaceId: string, relPath: string, version: string): boolean {
  const k = keyOf(spaceId, relPath);
  if (seen.get(k) === version) return false;
  seen.set(k, version);
  return true;
}

/** Forget a file that has been read successfully, deleted, or replaced. */
export function clearUnreadable(spaceId: string, relPath: string): void { seen.delete(keyOf(spaceId, relPath)); }

/** How many stored files are currently known to be unreadable. */
export function unreadableCount(): number { return seen.size; }

/**
 * Path normalisation — single source of truth. Two clearly-named variants because the
 * two use cases have different safety requirements, and hand-rolled copies had drifted
 * (the media worker stripped `..` for traversal defense while every other copy did not).
 */

/**
 * THE key of a space-relative path — the Mongo document `_id` / `path` of a file row, a tombstone's path, a queue entry.
 * NFC, forward slashes, no leading slash, empty and `.` segments dropped, a `..` that stays inside the root collapsed against
 * the segment before it (`a/x/../b` is `a/b`). A `..` that would climb above the root is left in place: the result is a key,
 * never a filesystem path, and it is the sandbox that refuses a path leaving the space. A trailing slash is kept as one slash
 * (the callers that want a bare directory strip it), and a path naming the root is `''`.
 *
 * ## What it prevents
 *
 * A path has one identity. The bytes of a file land at the sandbox-resolved path (NFC, `.` and empty segments collapsed), and
 * every peer door keys what a peer sends by that resolved path (`fileKeyOf`, `peerFileKey` in `files/sandbox.ts`) and refuses
 * a file row whose id is anything else. A local write that keyed a row by the caller's SPELLING (a decomposed name from a
 * macOS client, `a//b`, `./a`) made an id every peer refuses for ever, so that file's metadata never replicated. Written
 * here, once, the local writers and the peer doors cannot disagree on it.
 */
export function toDocId(p: string): string {
  const kept: string[] = [];
  for (const segment of p.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop();
    else kept.push(segment);
  }
  const key = kept.join('/');
  return key !== '' && /[\\/]$/.test(p) ? key + '/' : key;
}

/**
 * Normalise a peer/user-supplied path that will be joined to a filesystem root: forward
 * slashes, `..` segments stripped, no leading slash. Use this (not `toDocId`) whenever the
 * result feeds `path.join(root, …)` — it is defense-in-depth alongside the caller's boundary
 * check, not a replacement for it.
 */
export function toSafeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\.\.\//g, '').replace(/^\/+/, '');
}

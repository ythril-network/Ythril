/**
 * The paths a look at the files tree could not answer for, as a set to ask about: what the manifest names, what a peer says it could
 * not look at, and the one look the upload door makes (bundle-70, Q-350 b).
 *
 * ## The question it answers
 *
 * "Could this path be looked at?" A path whose `stat` or `readdir` failed with anything but "cannot exist" is neither present nor absent
 * to the code that read it: a peer that pulled "its" copy over it, a hash cache that pruned its entry, a restore report that called its row
 * "no bytes" all took it for absent. The manifest names such paths (`files/manifest.ts`, `unreadable`); this module is how the readers
 * ask about them, so no reader spells the directory-prefix rule or the bounds of a peer's list itself.
 *
 * ## The spelling
 *
 * A name is a file's KEY (the NFC document id, `toDocId`). A directory whose `readdir` failed is named as its key and a trailing `/`
 * (`d/`), once, and covers everything under it ({@link UnreadablePaths.covers}); a path that only shares the text (`dd/` against `d/`) is not
 * covered. An entry whose `stat` failed is named by its key alone, and covers the paths under it too (it may be a directory).
 *
 * ## What it prevents
 *
 * - A pull, a push or a prune acting on a path as if it were absent, because the one place that knew it was unreadable was a log line.
 * - A peer's list (`unreadable` in its manifest) reaching the disk or the logs unbounded or unresolved: it is typed, bounded and resolved
 *   as a manifest entry is ({@link peerUnreadableOf}), and only ever matched against our own keys, never opened.
 * - An upload door that read a body for a path it could not judge ({@link existingEntryUnreadable}).
 */
import fsp from 'node:fs/promises';
import { cannotExist } from '../util/path-present.js';
import { MAX_PEER_PATH_LENGTH } from '../util/request-bounds.js';
import { fileKeyOf } from './sandbox.js';

/**
 * The most paths a manifest names (and the most a peer's list is read for). A broken mount can make every path of a space unreadable; the
 * list is a hint to the reader, so past this it is cut and the cut is said (`unreadableTruncated`), never unbounded.
 */
export const MAX_UNREADABLE_PATHS = 1000;

/**
 * The `code` of the `409` the upload door answers a PEER's push at a path whose existing entry it cannot look at ({@link existingEntryUnreadable}),
 * and what the sender reads as a refusal (`sync/file-push.ts`): one spelling for the two sides of the answer.
 */
export const PATH_UNREADABLE_CODE = 'path_unreadable';

/** The names (keys, a directory with a trailing `/`) of paths that could not be looked at, and the one question to ask of them. */
export class UnreadablePaths {
  private readonly names: ReadonlySet<string>;

  constructor(names: Iterable<string> = []) { this.names = new Set(names); }

  get size(): number { return this.names.size; }

  /**
   * Whether `key` is named, or lies under a named directory: the key itself, or any ancestor of it spelled as a directory prefix (`a/`) or as
   * an entry whose `stat` failed (`a`). Pure; the cost is the key's depth, never the size of the set.
   */
  covers(key: string): boolean {
    if (this.names.size === 0) return false;
    if (this.names.has(key)) return true;
    for (let i = key.indexOf('/'); i !== -1; i = key.indexOf('/', i + 1)) {
      const dir = key.slice(0, i);
      if (this.names.has(`${dir}/`) || this.names.has(dir)) return true;
    }
    return false;
  }
}

/** What a peer said of the paths it could not look at, as it is used: the ones it named (resolved to our keys) and whether its list was cut. */
export interface PeerUnreadable {
  paths: UnreadablePaths;
  /** The peer's list is not the whole list: a path it does not name may be one it could not look at. */
  truncated: boolean;
}

/**
 * A peer manifest's `unreadable` and `unreadableTruncated`, as a value this instance may act on. A field of the wrong shape is ignored (an
 * older peer sends none; a list that is not an array names nothing), never fatal; an entry that is not a string, is empty or past the longest
 * path a peer may name ({@link MAX_PEER_PATH_LENGTH}) is dropped; at most {@link MAX_UNREADABLE_PATHS} are read, and a longer list is read as
 * cut. Each name is resolved to a key the way a manifest entry is (`fileKeyOf`: lexical, no disk), so a decomposed spelling names our NFC
 * key and a path that leaves the space names nothing. `unreadableTruncated` counts only when it is exactly `true`.
 */
export function peerUnreadableOf(spaceId: string, body: { unreadable?: unknown; unreadableTruncated?: unknown }): PeerUnreadable {
  const raw = Array.isArray(body.unreadable) ? body.unreadable : [];
  const keys: string[] = [];
  for (const item of raw.slice(0, MAX_UNREADABLE_PATHS)) {
    if (typeof item !== 'string' || item === '' || item.length > MAX_PEER_PATH_LENGTH) continue;
    const isDirectory = item.endsWith('/') || item.endsWith('\\');
    try {
      const { key } = fileKeyOf(spaceId, item);
      keys.push(isDirectory ? `${key}/` : key);
    } catch { /* names nothing of this space (it leaves it, or is its root): matched against nothing */ }
  }
  return { paths: new UnreadablePaths(keys), truncated: body.unreadableTruncated === true || raw.length > MAX_UNREADABLE_PATHS };
}

/**
 * Whether the entry at `abs` cannot be looked at: one `lstat` (nothing is followed, read or hashed), `false` for a path that is absent or
 * cannot exist ({@link cannotExist}) and for one that can be looked at, `true` for any other failure of the look (EACCES on the file or a
 * directory above it, EIO, a stuck mount). A failure that is no file-system error is thrown.
 */
export async function existingEntryUnreadable(abs: string): Promise<boolean> {
  try {
    await fsp.lstat(abs);
    return false;
  } catch (err) {
    if (cannotExist(err)) return false;
    if (typeof (err as NodeJS.ErrnoException | null)?.code === 'string') return true;
    throw err;
  }
}

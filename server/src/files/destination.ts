/**
 * Can a path be created in a space? The one answer, asked by every door that places bytes or a directory at a caller's path, and
 * by the move cascade the move doors share. Which doors those are is not listed here: `every-door-that-places-bytes-checks-its-destination`
 * derives them from the doors' own imports and holds each to this call.
 *
 * ## What it prevents
 *
 * Nothing looked at a destination's ancestors. A move, a `mkdir`, an upload or a `write_file` whose path runs THROUGH a regular
 * file (`a.txt/x` where `a.txt` is a file) reached the filesystem and failed there, and each door reported the failure in its own
 * words: REST a bare `500`, MCP a `400` carrying the raw message, which names the server's absolute data path. A directory moved
 * into itself failed the same way by another errno, after the move had published pending tombstones and held the queued jobs.
 * A refusal about the CALLER'S path is answered as one, before anything is written, with a name relative to the space
 * (`PathBlocked`, `files/act-answers.ts`).
 *
 * ## What it answers
 *
 * - {@link assertDestinationReachable}: may a file or directory be created at this path — does a regular file stand where a
 *   directory must be?
 * - {@link assertNotMovedIntoItself}: is this move onto itself, or into its own subtree? Decided on whole path segments, so `a`
 *   to `ab` is a move.
 * - {@link fsRefusalOf}: what a failed filesystem call means for the caller, asked AFTER it failed: a refusal about the path the
 *   checks above could not see (a name held by a directory, a race), and any other failure, which becomes a fault in words that
 *   carry no path.
 *
 * What none of them asks is whether the NAME is taken by a file: a destination file is replaced, and that is the guarantee
 * the move and write tools state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystemFault, PathBlocked, fileActAnswer } from './act-answers.js';
import { fileKeyOf, resolveSafePathChecked, spaceRoot } from './sandbox.js';
import { isAtOrUnder } from './moved-paths.js';
import { isMissingPath } from './stored-bytes.js';
import { toDocId } from '../util/paths.js';

/**
 * Refuse a path a regular file stands in the way of: some ancestor of `relPath`, below the space root, is not a directory.
 *
 * The path is resolved through the sandbox first (`resolveSafePathChecked`), so a path that leaves the space, or a symlink that
 * does, is the sandbox's `RangeError` and not this module's refusal. Ancestors are then followed through symlinks and judged by
 * what they point at: a symlinked directory inside the space is a directory. The walk stops at the first ancestor that does not
 * exist, since nothing below it can be in the way.
 *
 * The name in the refusal is the blocker's, relative to the space and always a prefix of the requested path, so what a caller
 * learns is about the path it asked for and never about another part of the tree.
 *
 * @throws PathBlocked when an ancestor is not a directory.
 * @throws RangeError when the path leaves the space.
 */
export async function assertDestinationReachable(spaceId: string, relPath: string): Promise<void> {
  const abs = await resolveSafePathChecked(spaceId, relPath);
  const root = spaceRoot(spaceId);
  const segments = path.relative(root, abs).split(path.sep).filter(s => s !== '');
  let probe = root;
  // The last segment is the destination itself, which is not an ancestor of anything here.
  for (const segment of segments.slice(0, -1)) {
    probe = path.join(probe, segment);
    let found;
    try {
      found = await fs.stat(probe);
    } catch (err) {
      if (isMissingPath(err)) return;
      throw fsRefusalOf(err, [toDocId(path.relative(root, abs))]);
    }
    if (!found.isDirectory()) {
      const blocker = toDocId(path.relative(root, probe));
      throw new PathBlocked(blocker, `'${toDocId(path.relative(root, abs))}' cannot be created: '${blocker}' is a file, and a directory is needed there.`);
    }
  }
}

/**
 * Refuse a move that is onto itself or into its own subtree: `src` and `dst` are the same path, or `dst` lies under `src`.
 * Compared as keys of whole path segments (the key of a path is what its records are filed under), so `a` to `ab` is not
 * "under" and is allowed. Both are resolved lexically, without the disk.
 *
 * @throws PathBlocked naming `src` (the directory that would have to hold itself) or, for an identical pair, the path.
 * @throws RangeError when either path leaves the space or names the space itself.
 */
export function assertNotMovedIntoItself(spaceId: string, src: string, dst: string): void {
  const from = fileKeyOf(spaceId, src).key;
  const to = fileKeyOf(spaceId, dst).key;
  if (from === to) throw new PathBlocked(to, `'${from}' cannot be moved onto itself.`);
  if (isAtOrUnder(to, from)) throw new PathBlocked(from, `'${from}' cannot be moved into itself: '${to}' lies under it.`);
}

/**
 * Whether `err` is a destination refusal: the answer every door gives it says `path_blocked`. Asked through the answer rather than the
 * class, so a caller that must act on a refusal (an upload discarding what it staged) and the door that reports it cannot disagree
 * about which errors those are.
 */
export function isPathBlocked(err: unknown): err is PathBlocked {
  return fileActAnswer(err)?.body.code === 'path_blocked';
}

/** The filesystem's refusals that are about the CALLER'S path rather than about the server, each with what it means for the caller. */
const REFUSED_BY_THE_TREE: Readonly<Record<string, string>> = Object.freeze({
  EEXIST: 'a file stands where a directory is needed',
  ENOTDIR: 'a file stands where a directory is needed',
  EISDIR: 'a directory stands where a file is needed',
  ENOTEMPTY: 'a directory that is not empty stands there',
  EINVAL: 'a directory cannot be moved into itself',
  ENAMETOOLONG: 'the name is too long',
  ELOOP: 'the path loops through symbolic links',
});

/**
 * What a failed filesystem call (`mkdir`, `rename`, a write) means for the caller. `relPaths` are the space-relative paths the
 * act was given, the DESTINATION last.
 *
 * A code in the table is a {@link PathBlocked} naming the destination, built from `relPaths`. Every other failure,
 * whatever it is, becomes a {@link FileSystemFault} holding the original as its `cause` for the log: `err.message` of the
 * filesystem carries the server's absolute data path, and is never what a caller is told.
 */
export function fsRefusalOf(err: unknown, relPaths: readonly string[]): PathBlocked | FileSystemFault {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const meaning = typeof code === 'string' && Object.hasOwn(REFUSED_BY_THE_TREE, code) ? REFUSED_BY_THE_TREE[code] : undefined;
  if (meaning === undefined) return new FileSystemFault(err);
  const destination = toDocId(relPaths.at(-1) ?? '');
  return new PathBlocked(destination, `'${destination}' cannot be created: ${meaning}.`);
}

/**
 * What the disk says about a path's sidecars and kind — the half of `files/moved-paths.ts` that LOOKS at the file system.
 *
 * ## The question it answers
 *
 * "Which of the sidecar paths the algebra names are really this path's, and what kind of thing is this path?" — asked of the disk, because
 * the algebra of paths (`files/moved-paths.ts`, decided over strings) cannot tell a FILE `g` whose converted Markdown is
 * `_converted/g.md` from a DIRECTORY `g.md/` whose converted tree is the same path. The answer needs the sandbox (the configuration) and the
 * stored-bytes reader (the file system), so it lives here and the algebra does not import them.
 *
 * ## What it prevents
 *
 * The pure rules importing the disk. `files/tombstone-shadow.ts` and `files/moved-paths.ts` are held to an import closure with no I/O in it
 * (`the-shadow-rules-import-no-io`), so the rule that decides an arrival can be read and tested without a store behind it; a function that
 * reads the disk added to either goes red there, and belongs here.
 */
import type { PathKind, Sidecar } from './moved-paths.js';
import { sidecarsOf } from './moved-paths.js';
import { resolveSafePathChecked } from './sandbox.js';
import { isStoredDirectory } from './stored-bytes.js';

/**
 * The sidecars of `p` that are really its own: {@link sidecarsOf}, less the one the disk says belongs to somebody else.
 *
 * For a FILE `g` the converted Markdown is `_converted/g.md` — which is also the converted TREE of a directory `g.md/`
 * standing beside it. A directory there is not the file's, and removing or moving it as if it were takes a tree the delete
 * never named. The check is here, behind the one function every caller reaches, so no caller can leave it out. A failure to
 * look at the path is thrown, never read as "not a directory" (`isStoredDirectory`).
 */
export async function sidecarsOwnedBy(spaceId: string, p: string, kind: PathKind): Promise<Sidecar[]> {
  const owned: Sidecar[] = [];
  for (const s of sidecarsOf(p, kind)) {
    if (s.shape === 'file' && await isStoredDirectory(await resolveSafePathChecked(spaceId, s.path))) continue;
    owned.push(s);
  }
  return owned;
}

/**
 * What the path at `relPath` is on disk — a directory or, whatever else, a file: the kind its sidecars and jobs are asked by.
 * Read from the disk and never inferred from whether it has children: an empty directory has none and is still a directory, whose
 * trees are not a file's converted Markdown. A path the sandbox refuses is its `RangeError`; a failure to look is thrown.
 */
export async function kindAt(spaceId: string, relPath: string): Promise<PathKind> {
  return await isStoredDirectory(await resolveSafePathChecked(spaceId, relPath)) ? 'directory' : 'file';
}

/**
 * The sidecar paths that belong to `src` — a directory's two trees, or a file's converted Markdown and its extracted tree, by
 * `kind` (what `src` IS, read from the disk by the caller: `isStoredDirectory`) — with where each goes when `src` moves to
 * `dst`. Only the sidecars that are `src`'s own ({@link sidecarsOwnedBy}); whether they are on disk is the caller's to ask.
 */
export async function movedSidecars(
  spaceId: string, src: string, dst: string, kind: PathKind,
): Promise<Array<{ from: string; to: string }>> {
  const target = sidecarsOf(dst, kind);
  return (await sidecarsOwnedBy(spaceId, src, kind)).flatMap(s => {
    const to = target.find(t => t.role === s.role);
    return to === undefined ? [] : [{ from: s.path, to: to.path }];
  });
}

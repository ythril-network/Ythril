/**
 * Where everything that belongs to a path goes when that path moves — one answer for the metadata, the job queue and
 * the sidecar files.
 *
 * A file is more than its own `_id`. A converted document owns chunk records (`<path>#chunk<n>`), a converted
 * Markdown sidecar (`_converted/<path>.md`) and extracted images (`_extracted/<path>/…`), each pointing back at it
 * through `parentFileId`; a directory owns all of that for every file under it. The move used to re-root only ids
 * that started with `<src>/`, so a single-file rename left every chunk at the old path, a directory move left each
 * chunk's `parentFileId` naming a file that no longer existed, and the sidecars moved for neither. Three consumers
 * asking the same question is how those answers drifted; this module is the one place it is answered.
 *
 * ## Which sidecar paths belong to a path (bundle-71, Q-349)
 *
 * The same question is asked by everything that writes a sidecar, removes one or follows a path that moves: the conversion
 * that writes them, the delete that removes them, the job queue that cancels the extracted images' jobs, the move and the
 * arrival predicate that shadows a sidecar by its parent's tombstone. Each used to spell `_converted/<p>.md` and
 * `_extracted/<p>/` itself, and each spelling was right for a FILE and wrong for a DIRECTORY, or the other way round: a
 * directory `g.md/` has its converted tree at `_converted/g.md/`, which is exactly where the converted Markdown of a FILE
 * `g` goes, so a delete of the file removed the tree of a directory it never named. {@link sidecarsOf} answers it by KIND,
 * {@link sidecarsOwnedBy} drops the one candidate the disk says belongs to a directory, {@link parentOfSidecar} is the inverse.
 */
import { toDocId } from '../util/paths.js';
import { escapeRegex } from '../util/redos.js';
import { resolveSafePathChecked } from './sandbox.js';
import { isStoredDirectory } from './stored-bytes.js';

/**
 * The two sidecar roots a conversion writes under, mirroring the original file's path. Exported for the one question that is
 * about the TREE and not about a sidecar's parent: "is this path inside a derived tree" (`isInstanceLocalFile`,
 * `sync/file-conflict.ts`), which {@link parentOfSidecar} cannot answer — it refuses `_converted/x`, a path no conversion writes.
 */
export const CONVERTED_ROOT = '_converted/';
export const EXTRACTED_ROOT = '_extracted/';
const SIDECAR_ROOTS = [CONVERTED_ROOT, EXTRACTED_ROOT] as const;

/** A path as the stores key it, without a trailing slash — `a/b/` and `a/b` are the same move. */
export function movedRoot(p: string): string {
  return toDocId(p).replace(/\/+$/, '');
}

/** What a path is, for the one question that depends on it: which sidecars it owns. */
export type PathKind = 'file' | 'directory';

/**
 * One path a conversion owns for another path. `shape` is what stands there: a single `file` (the converted Markdown) or a
 * `tree` of files. `role` is which root it is under, so a source's sidecar and its destination's are paired by it.
 */
export interface Sidecar { path: string; shape: 'file' | 'tree'; role: 'converted' | 'extracted' }

/** `p` as the root of a sidecar path, refusing the empty one: `_extracted/` alone would claim every sidecar there is. */
function rootOfSidecarOwner(p: string): string {
  const root = movedRoot(p);
  if (!root) throw new RangeError('A sidecar belongs to a path, and this one is empty');
  return root;
}

/** The converted Markdown of the FILE `p`. Where the conversion writes it, and the only place a delete or a move looks for it. */
export const convertedFileOf = (p: string): string => `${CONVERTED_ROOT}${rootOfSidecarOwner(p)}.md`;

/** The tree of images extracted from the FILE `p` — and, for a DIRECTORY, the tree of everything its files extracted. */
export const extractedTreeOf = (p: string): string => `${EXTRACTED_ROOT}${rootOfSidecarOwner(p)}`;

/**
 * The sidecar paths of `p`, by its kind and nothing else (pure; the disk's say is {@link sidecarsOwnedBy}).
 *
 *  - a FILE owns its converted Markdown, `_converted/<p>.md`, and the tree of its extracted images, `_extracted/<p>/`;
 *  - a DIRECTORY owns two trees, `_converted/<p>/` and `_extracted/<p>/`, one entry per file under it.
 *
 * Keys are the stores' (`movedRoot`: forward slashes, no leading or trailing one). An empty path owns nothing.
 */
export function sidecarsOf(p: string, kind: PathKind): Sidecar[] {
  if (!movedRoot(p)) return [];
  const extracted: Sidecar = { path: extractedTreeOf(p), shape: 'tree', role: 'extracted' };
  return kind === 'file'
    ? [{ path: convertedFileOf(p), shape: 'file', role: 'converted' }, extracted]
    : [{ path: `${CONVERTED_ROOT}${movedRoot(p)}`, shape: 'tree', role: 'converted' }, extracted];
}

/**
 * The `_id` clauses that match what `paths` hold, for an `$or`: a `file` by its id, a `tree` by its prefix WITH the slash, so
 * `d` never takes `d2`. One spelling for every store keyed by path (file rows, the job queue), so a remover cannot match a
 * sidecar file as a tree or drop the slash.
 */
export function idsUnder(paths: ReadonlyArray<Pick<Sidecar, 'path' | 'shape'>>): Array<{ _id: string | { $regex: string } }> {
  return paths.map(s => s.shape === 'file' ? { _id: s.path } : { _id: { $regex: `^${escapeRegex(`${s.path}/`)}` } });
}

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
 * The inverse of {@link sidecarsOf}: the FILE a sidecar path is a product of, and which root it is under — or `null` for a
 * path that is nobody's sidecar. `_converted/<q>.md` is the converted Markdown of `<q>`, and the file at `_extracted/<q>/<leaf>`
 * is an image extracted from `<q>`. Never a directory: a conversion's product is its file's, and a directory has no
 * tombstone for anything to be shadowed by. A name that merely STARTS like a sidecar (`_converted/x`, `_extractedx/…`) is not one.
 *
 * The arrival predicate asks it of an arriving path, to read the tombstone held for the parent (`files/tombstones.ts`). Takes
 * a resolved key (`peerFileKey`), never a peer's spelling.
 */
export function parentOfSidecar(key: string): { parent: string; role: Sidecar['role'] } | null {
  if (key.startsWith(CONVERTED_ROOT)) {
    const tail = key.slice(CONVERTED_ROOT.length);
    return tail.length > '.md'.length && tail.endsWith('.md') ? { parent: tail.slice(0, -'.md'.length), role: 'converted' } : null;
  }
  if (key.startsWith(EXTRACTED_ROOT)) {
    const tail = key.slice(EXTRACTED_ROOT.length);
    const leaf = tail.lastIndexOf('/');
    return leaf > 0 && leaf < tail.length - 1 ? { parent: tail.slice(0, leaf), role: 'extracted' } : null;
  }
  return null;
}

/**
 * The id `id` has after `src` moves to `dst`, or `null` when `id` does not belong to `src`.
 *
 * Belonging is: `src` itself, anything under `src/`, a chunk of `src` (`src#chunk<n>`), and the same three under
 * either sidecar root — plus the converted sidecar of `src` itself, `_converted/<src>.md`.
 */
export function movedId(id: string, src: string, dst: string): string | null {
  const from = movedRoot(src);
  const to = movedRoot(dst);
  if (!from || !to) return null;   // an empty root would claim the whole space
  const root = SIDECAR_ROOTS.find(r => id.startsWith(r)) ?? '';
  const tail = id.slice(root.length);
  if (tail === from) return root + to;
  if (tail.startsWith(`${from}/`) || tail.startsWith(`${from}#`)) return root + to + tail.slice(from.length);
  if (root === CONVERTED_ROOT && tail === `${from}.md`) return `${root}${to}.md`;
  return null;
}

/**
 * The paths whose JOBS belong to `p`, as a `kind`: the path itself — a FILE's own id, a DIRECTORY's subtree — and every sidecar
 * {@link sidecarsOf} names for it. Fed to {@link idsUnder} for a job's `_id`. The one answer to "which job ids does this path
 * own", asked by the delete that cancels them and the move that holds and re-keys them, so the two cannot disagree about a
 * sidecar again: a peer that never converts holds `_converted/<f>.md` as an ordinary file with a job of its own, which only
 * a rule that names sidecar FILES can reach.
 *
 * Chunks are never queued, and a `#` rule here would sweep in a real file whose name happens to begin with `p#`. An empty path
 * owns nothing.
 */
export function jobPathsOf(p: string, kind: PathKind): Array<Pick<Sidecar, 'path' | 'shape'>> {
  const root = movedRoot(p);
  if (!root) return [];
  return [{ path: root, shape: kind === 'directory' ? 'tree' : 'file' }, ...sidecarsOf(root, kind)];
}

/** The regex that selects, by `parentFileId`, every DERIVED record of a file at or under `src`. */
export function parentIdsUnder(src: string): RegExp | null {
  const from = escapeRegex(movedRoot(src));
  return from ? new RegExp(`^${from}(/|$)`) : null;
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

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
 */
import { toDocId } from '../util/paths.js';
import { escapeRegex } from '../util/redos.js';

/** The two sidecar roots a conversion writes under, mirroring the original file's path. */
const SIDECAR_ROOTS = ['_converted/', '_extracted/'] as const;

/** A path as the stores key it, without a trailing slash — `a/b/` and `a/b` are the same move. */
export function movedRoot(p: string): string {
  return toDocId(p).replace(/\/+$/, '');
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
  if (root === '_converted/' && tail === `${from}.md`) return `${root}${to}.md`;
  return null;
}

/**
 * The regexes that select, by `_id`, every JOB belonging to `src` — the file(s) and any extracted image. Chunks and
 * converted Markdown are never queued, and a `#` rule here would sweep in a real file whose name happens to begin
 * with `src#`.
 */
export function jobIdsUnder(src: string): RegExp[] {
  const from = escapeRegex(movedRoot(src));
  if (!from) return [];
  return [new RegExp(`^${from}(/|$)`), new RegExp(`^_extracted/${from}/`)];
}

/** The regex that selects, by `parentFileId`, every DERIVED record of a file at or under `src`. */
export function parentIdsUnder(src: string): RegExp | null {
  const from = escapeRegex(movedRoot(src));
  return from ? new RegExp(`^${from}(/|$)`) : null;
}

/** The sidecar paths on disk that belong to `src`, with where each goes: a directory's trees, or one file's own. */
export function movedSidecars(src: string, dst: string): Array<{ from: string; to: string }> {
  const from = movedRoot(src);
  const to = movedRoot(dst);
  if (!from || !to) return [];
  return [
    { from: `_converted/${from}`, to: `_converted/${to}` },        // a directory's converted tree
    { from: `_converted/${from}.md`, to: `_converted/${to}.md` },  // one file's converted Markdown
    { from: `_extracted/${from}`, to: `_extracted/${to}` },        // extracted images, file or directory
  ];
}

/**
 * Formatting shared by the file manager and the pieces extracted out of it.
 *
 * ## Why a module rather than a copy
 *
 * The preview extraction (G-3) needed `formatSize` for one row of its metadata card, and the tempting move was
 * four lines of pure arithmetic copied across. That is this codebase's most expensive defect in miniature —
 * one rule with two implementations, where the weaker one wins silently — and it is on the project's own list
 * of things to extract instead. A size that reads `1.5 KB` in the table and `2 KB` in the preview is a bug
 * nobody would file and everybody would notice.
 */

/**
 * A byte count as a human-readable size.
 *
 * **The boundary belongs to the LARGER unit** — 1023 is `1023 B`, 1024 is `1.0 KB` — and the precision widens
 * with the unit: none for bytes, one decimal for KB and MB, two for GB. That last step is deliberate rather
 * than an oversight: a figure in gigabytes moves slowly enough that a single decimal looks stuck.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * A chunk's position in a timed source, as `m:ss` or `m:ss-m:ss`.
 *
 * Media provenance: an audio or video file is chunked by TIME, so "where did this text come from" is a clock
 * range rather than a page or a byte offset. A null offset means the chunk has no timed provenance at all —
 * the ordinary case for a document — and renders as nothing rather than as `0:00`, which would claim the very
 * beginning of a file that has no timeline.
 *
 * A null duration means a point rather than a span, and prints as one clock.
 */
export function msRange(offsetMs: number | null, durationMs: number | null): string {
  if (offsetMs === null) return '';
  const clock = (ms: number) => {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  return durationMs ? `${clock(offsetMs)}-${clock(offsetMs + durationMs)}` : clock(offsetMs);
}

/**
 * A space-relative path built from a directory and a name.
 *
 * Trivial, and shared for a reason the file manager's own characterization spec states: `joinPath` and the
 * breadcrumb accumulator are the only two places that build a path in this page, and they agree about nothing
 * today. A second copy is how they start to disagree — which is why the tree's nodes are built with THIS
 * function, and why a case asserts that a node's path equals what this returns rather than a literal.
 *
 * Root is `/`, so the endsWith check is not a cosmetic guard: without it every top-level path would be `//x`,
 * and that string is a different `_id` from `/x` on the server.
 */
export function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

/**
 * The directory a space-relative path lives in: `/docs/a.txt` is in `/docs`, `/docs` is in `/`, and root has no parent but
 * answers `/` too, so a caller walking upward stops rather than falls off.
 *
 * The inverse of `joinPath`, and shared for the same reason: the tree store, the tree component and the page each need "the
 * parent of this path" (a removal reloads it, focus goes to it, a move reloads two of them), and three spellings of one
 * regex is how one of them ends up treating a trailing slash differently.
 */
export function parentPath(path: string): string {
  return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
}

/** The last segment of a path: the name an operator knows an entry by. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

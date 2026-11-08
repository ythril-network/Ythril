/**
 * The one way a filter asks "is this row's `_id` under this prefix" (bundle-255).
 *
 * ## What it prevents
 *
 * The idiom `{ _id: { $regex: '^' + escapeRegex(prefix) } }` was written by hand at each site that reads a folder's rows. A site that forgets the escape
 * turns a folder named `a.b` into a pattern that also matches `aXb`, and a caller's `(` into a refused query: a prefix is TEXT, never a pattern. Here the
 * escape is inside, so no caller can drop it, and the anchor too, so no caller matches mid-path.
 *
 * An empty prefix matches every id: a caller for whom "everything" is wrong (a directory delete) refuses an empty path before it asks.
 */
import { escapeRegex } from './redos.js';

/** The `_id` condition of the rows whose id starts with `prefix`, as text. */
export function underPrefix(prefix: string): { $regex: string } {
  return { $regex: `^${escapeRegex(prefix)}` };
}

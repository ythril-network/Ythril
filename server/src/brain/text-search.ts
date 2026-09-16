/**
 * Server-side freetext (substring) search for the brain list endpoints — slice 2b-iii-a.
 *
 * The docked column filters need a `?search=` that matches a substring of a record's text fields,
 * across the WHOLE paginated set (same reason the sort in 2a had to be server-side). Chrono already
 * had one; entities/edges/memories did not — their list `name` param was an EXACT match and memories
 * had no text param at all. This adds a uniform, escaped substring match to the ones that lacked it.
 *
 * The user's text is `escapeRegex`-ed before it reaches `$regex`: an un-escaped user string is a
 * regex-injection / ReDoS vector (a value like `(a+)+$` handed straight to the engine), so it is
 * treated as a literal substring, never as a pattern.
 */
import { escapeRegex } from '../util/redos.js';

/** Text fields each collection searches, OR-matched. `createdAt`/ids are not text and stay out. */
export const SEARCHABLE_FIELDS = {
  entities: ['name', 'description'],
  edges: ['label', 'description'],
  facts: ['fact', 'description'],
  chrono: ['title', 'description'],
  files: ['path', 'description'],
} as const;

/**
 * Build a case-insensitive substring `$or` over `fields`, or `null` when there's nothing to search
 * (empty/whitespace). The returned object is merged into a collection's Mongo filter.
 */
export function textSearchOr(
  search: string | undefined,
  fields: readonly string[],
): { $or: Record<string, unknown>[] } | null {
  const q = search?.trim();
  if (!q) return null;
  const regex = { $regex: escapeRegex(q), $options: 'i' };
  return { $or: fields.map(f => ({ [f]: regex })) };
}

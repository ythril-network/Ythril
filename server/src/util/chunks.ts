/**
 * Split a list into consecutive slices of at most `size` — the one spelling of "a batch at a time".
 *
 * Written inline three times before it was extracted (the embed-job runner, the predicate recall's id reads, and
 * the write read set), and the inline copies are where it goes wrong: an off-by-one that drops the last slice,
 * or a size of 0 that loops for ever. A non-positive size is refused rather than read as "no slicing", because a
 * caller passing 0 has a bug and an unbounded `$in` is exactly what the size exists to prevent.
 */
export function inChunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`inChunks: size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

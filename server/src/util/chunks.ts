/**
 * Split a list into consecutive slices of at most `size` — the one spelling of "a batch at a time".
 *
 * Written inline three times before it was extracted (the embed-job runner, the predicate recall's id reads, and
 * the write read set), and the inline copies are where it goes wrong: an off-by-one that drops the last slice,
 * or a size of 0 that loops for ever. A non-positive size is refused rather than read as "no slicing", because a
 * caller passing 0 has a bug and an unbounded `$in` is exactly what the size exists to prevent.
 */
/**
 * Rows per bulk write or `$in` delete command — the one number for "how many rows one command may carry", where a
 * hub's merge, cascade or re-key issues thousands and one command per row was the cost. It was three constants of one
 * value (`REKEY_CHUNK`, `MERGE_CHUNK`, `TOMBSTONE_CHUNK`, bundle-30 I6, C13). A different question keeps its own
 * number: `EDGE_REMOVAL_CHUNK` sizes a TRANSACTION (the read, delete and tombstones of one chunk commit together).
 */
export const ROWS_PER_BULK_COMMAND = 1_000;

export function inChunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`inChunks: size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

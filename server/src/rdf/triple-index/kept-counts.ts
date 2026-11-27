/**
 * The planning counts of the triple index, kept in this process by space, under a hash of everything a count depends on (bundle-378, Q-976
 * S2, contract row 3; fix round A).
 *
 * ## The question it answers
 *
 * "Has this pattern of this space's index, at this build and write counter, been counted already?" The engine asks for a count of each free
 * pattern before it plans a join; a count is kept so a query that was counted before sends none (`read.ts` `IndexRead.estimate`).
 *
 * ## What it prevents
 *
 * - **Query text kept in memory.** The key was `JSON.stringify` of the pattern's bound terms, so a query's IRI and literal text stayed in
 *   it for as long as the entry did, with no time bound. The key is now the space and a SHA-256 of the rest; no term text is kept.
 * - **A deleted space's counts outliving it.** Counts are listed by space (the key starts with it); the space's deletion calls
 *   {@link forgetKeptCounts}, so they do not take slots of the bound for a space that is gone.
 * - **A count of an index that changed.** The key holds the build id and the write counter the caller read, so a changed index is another
 *   key (the caller's concern; this module only keeps what it is given under the key it is given).
 * - **A bound that grows.** At most {@link KEPT_COUNTS_MAX} counts, the least recently used first (`WalkableLru`).
 * - **Every lookup uncounted.** Each is counted, `ythril_cache_lookups_total{cache="planning_count"}`, and the entries held are a gauge.
 */
import { WalkableLru } from '../../util/walkable-lru.js';
import { sha256Hex } from '../../util/sha256-hex.js';
import { noteCacheLookup, reportCacheSize } from '../../metrics/cache-metrics.js';

/** The most planning counts this process keeps; past it the least recently used goes. */
export const KEPT_COUNTS_MAX = 10_000;

/** Separates the space from the hash in a key: no space id holds a NUL. */
const SEP = '\u0000';

const counts = new WalkableLru<number>(KEPT_COUNTS_MAX);
reportCacheSize('planning_count', () => counts.size);

/** The key of a count: the space, then a hash of what the count depends on (`dependsOn`, any JSON-able value). */
export function keptCountKey(space: string, dependsOn: unknown): string {
  return `${space}${SEP}${sha256Hex(JSON.stringify(dependsOn))}`;
}

/** The kept count under `key`, counted as a hit; `undefined` (counted as a miss) when none is kept. */
export function keptCount(key: string): number | undefined {
  const n = counts.get(key);
  noteCacheLookup('planning_count', n === undefined ? 'miss' : 'hit');
  return n;
}

/** Keep `n` under `key`. */
export function keepCount(key: string, n: number): void {
  counts.set(key, n);
}

/** Drop every count kept for `space`: when the space is deleted. */
export function forgetKeptCounts(space: string): void {
  const prefix = `${space}${SEP}`;
  counts.forgetWhere(key => key.startsWith(prefix));
}

/** The keys held now, for a spec: each a space and a hash, never a text. */
export function keptCountKeys(): string[] {
  return counts.heldKeys();
}

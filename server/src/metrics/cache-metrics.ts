/**
 * How a cache of this process says what it answered and what it holds, without importing the metrics registry (bundle-378, Q-976, fix
 * round A).
 *
 * ## The question it answers
 *
 * "How does a cache count its lookups and report its size when the registry imports the modules that own the caches?" The registry imports
 * recall, the triple index and the RDF state, so none of them can import it (`no-runtime-import-cycles`); this leaf holds no import of it. The
 * registry gives it the counter (`setCacheLookupSink`, as `scan-hold-count.ts` does) and reads the sizes at scrape time ({@link cacheEntries});
 * a lookup made before then (a unit that never loads the registry) is dropped, as no scrape would have read it. The series are
 * `ythril_cache_lookups_total{cache,result}` and `ythril_cache_entries{cache}`.
 *
 * ## What it prevents
 *
 * - **A cache nobody can see.** {@link CACHES} is the one list: the registry declares a series at zero per entry and a cache can only name a
 *   member of it, so a new cache is added here or it counts nothing.
 * - **A size that is a copy.** A cache registers a function that answers its size ({@link reportCacheSize}); the gauge reads it at scrape time,
 *   so it can never disagree with what the cache holds.
 */
import { countSink } from './count-sink.js';

/** The caches that report: a recall's query vector (`brain/recall.ts`), the planner's pattern counts, the RDF schema verdict. */
export const CACHES = ['query_vector', 'planning_count', 'schema_verdict'] as const;
export type CacheName = typeof CACHES[number];

/** Whether a lookup was answered from the cache (`hit`) or computed (`miss`). */
export type CacheResult = 'hit' | 'miss';

const lookups = countSink<[cache: CacheName, result: CacheResult]>();

/** Called once by the registry, at load. */
export const setCacheLookupSink = lookups.set;

/** One lookup of `cache`, answered from it or computed. */
export const noteCacheLookup = lookups.add;

const sizes = new Map<CacheName, () => number>();

/** Say how many entries `cache` holds, as a function read at every scrape. */
export function reportCacheSize(cache: CacheName, size: () => number): void {
  sizes.set(cache, size);
}

/** The entries each cache holds now; a cache that has not reported (its module is not loaded) holds none. */
export function cacheEntries(): Array<[CacheName, number]> {
  return CACHES.map(c => [c, sizes.get(c)?.() ?? 0]);
}

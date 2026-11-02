/**
 * A Map holding at most `max` entries, the least recently used dropped first. Defined in `@ythril/schema` (`schema/src/lru-map.ts`,
 * with why it is a module) because the schema rule verdicts are cached in one; re-exported so every bounded cache of the server is
 * the same one.
 */
export { LruMap, type LruWeight } from '@ythril/schema/internal';

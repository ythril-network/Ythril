/**
 * A bounded cache (`LruMap`) whose keys can be walked: forgotten by a rule, and listed (bundle-378, Q-976, fix round A).
 *
 * ## The question it answers
 *
 * "Which entries of this cache must go now, though the bound has not dropped them?": the expired ones of a timed cache, and a deleted
 * space's. `LruMap` cannot be walked, so each cache that needed it kept a second set of its keys beside the map, kept in step by hand
 * (`util/cached-probe.ts` first; the query vector cache and the planning counts after it).
 *
 * ## What it prevents
 *
 * - **A key set that drifts from the map.** The set is changed in the one place an entry enters (`set`) and in the two places one leaves
 *   (`delete`, and the bound's eviction through `LruMap`'s `onEvict`), so a forgotten entry cannot stay listed and a listed one is held.
 * - **A walk that touches.** `forgetWhere` reads with `peek`, so asking which entries to drop never makes them the most recently used.
 *
 * Keys are strings (every user of it hashes or joins its parts).
 */
import { LruMap } from './lru-map.js';

export class WalkableLru<V> {
  private readonly keys = new Set<string>();
  private readonly map: LruMap<string, V>;

  constructor(max: number) {
    this.map = new LruMap<string, V>(max, (key) => { this.keys.delete(key); });
  }

  /** The value for `key`, which becomes the most recently used. */
  get(key: string): V | undefined { return this.map.get(key); }

  /** Store `value` as the most recently used, dropping the least recently used past the bound. */
  set(key: string, value: V): void {
    this.map.set(key, value);
    this.keys.add(key);
  }

  delete(key: string): void {
    this.map.delete(key);
    this.keys.delete(key);
  }

  /** Drop every entry `drop(key, value)` says yes to, without changing the order of the rest; how many went. */
  forgetWhere(drop: (key: string, value: V) => boolean): number {
    let gone = 0;
    for (const key of [...this.keys]) {
      const value = this.map.peek(key);
      if (value === undefined || drop(key, value)) { this.delete(key); gone++; }
    }
    return gone;
  }

  /** The keys held now, in no promised order: for a spec and a size check, never for a lookup. */
  heldKeys(): string[] { return [...this.keys]; }

  get size(): number { return this.map.size; }
}

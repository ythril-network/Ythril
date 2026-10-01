/**
 * Which write sites write — or may write — a RECORD collection. One answer for every gate that asks.
 *
 * ## Why this is a module
 *
 * Three gates ask it: `a-create-converge-write-lives-in-the-commit` (the create path writes only through the
 * commit), `an-arrival-is-written-by-one-writer` (the sync and import doors write only through `writeArrivals`)
 * and `a-receiver-embeds-by-its-own-rules` (no raw write survives in the ingest files). The first one carried the
 * predicate inline; the second site is where it is extracted (`Q-107` part 1), before the copies drift.
 *
 * ## The guards a hand-written copy drops
 *
 * - **A computed name counts.** A site whose collection name is a parameter, or a `${id}_${suffix}` with a
 *   variable suffix, may be a record collection, so it is held to the rule rather than guessed away. So is a
 *   receiver `_space-writers.mjs` cannot resolve at all (`unknown`). The safe direction is a finding a person
 *   reads.
 * - **The write methods come from `db/record-write-observer.ts`**, never from a list written here: a method the
 *   observer counts as a write and this did not would be a door every gate built on it is blind to.
 * - **The sequence counter is excluded by what it is**, not by an exemption per caller. `ythril_counters` is a
 *   space write (`_space-writers.mjs` classifies it so, rightly: every peer's position depends on it) but not a
 *   record: allocating or bumping a seq stores nobody's document. It is recognised by the classification the
 *   writer module itself gives it, so a rename of the counter collection is a rename in one place.
 * - **The floors.** `spaceWriters` throws below its floors; this adds one on the record sites themselves, because
 *   a predicate edited to match nothing makes every door clean.
 */
import assert from 'node:assert/strict';
import { spaceWriters } from './_space-writers.mjs';

const { COLLECTION_METHOD_EFFECT } = await import('../../server/dist/db/record-write-observer.js');

/** Methods that write or delete, from the observer's own table. */
export const WRITE_METHODS = Object.entries(COLLECTION_METHOD_EFFECT)
  .filter(([, e]) => e !== 'read' && (e.write || e.delete))
  .map(([m]) => m);

/** How `_space-writers.mjs` names a counter site, directly or through a helper that returns the counter. */
const COUNTER = /\bythril_counters\b/;

/**
 * The record-collection write sites of an index.
 *
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} index  after any route bodies are registered, so a
 *   write inside an inline handler is attributed to its route rather than left an orphan.
 * @param {{collections: Iterable<string>, floors?: Record<string, number>, recordFloor?: number}} opts
 *   `collections` is the set of record collection suffixes the caller's rule governs (derived by the caller from
 *   `BRAIN_COLLECTIONS`, never listed); `floors` go to `spaceWriters`; `recordFloor` is the fewest record sites
 *   that may be found before this throws.
 * @returns {{ sites: object[], orphans: object[], byKey: Map<string, object[]>, writers: object, isRecordWrite: (s: object) => boolean }}
 */
export function recordWrites(index, { collections, floors = {}, recordFloor = 1 }) {
  const governed = new Set(collections);
  assert.ok(governed.size >= 1, 'recordWrites was handed no record collections — derive them from BRAIN_COLLECTIONS');
  const writers = spaceWriters(index, { floors });
  const isRecordWrite = (s) => WRITE_METHODS.includes(s.op)
    && !COUNTER.test(s.why ?? '')
    && ((s.kind === 'space' && (s.collection == null || governed.has(s.collection))) || s.kind === 'unknown');
  const sites = writers.sites.filter(isRecordWrite);
  const orphans = writers.orphans.filter(isRecordWrite);
  const byKey = new Map();
  for (const s of sites) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  // Aliases (`handle: handleX`) write what their target writes, as `spaceWriters` already resolves them.
  for (const [key, list] of writers.byKey) {
    if (!byKey.has(key)) {
      const own = list.filter(isRecordWrite);
      if (own.length > 0) byKey.set(key, own);
    }
  }
  assert.ok(sites.length >= recordFloor,
    `only ${sites.length} record-collection write site(s) found, below the floor of ${recordFloor}. The predicate `
    + 'or the scan is broken, not the code — a thin set makes every door report clean.');
  return { sites, orphans, byKey, writers, isRecordWrite };
}

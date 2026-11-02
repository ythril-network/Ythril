/**
 * Is this a vector index that cannot be queried YET — absent, or still being built? (Q-325, narrowed by Q-326)
 *
 * ## What it is for
 *
 * A collection's vector index is built after its first record and asynchronously (`spaces/search-index-presence.ts`),
 * and rebuilt in the background after a definition change. Until it serves, mongot refuses every `$vectorSearch`
 * against it. `recallByType` asks this first; on a "not yet" it asks `holdsRecordTheIndexShouldServe` whether the
 * collection holds a record the index should be serving: none, and the refusal is an empty collection (a new space,
 * whose fresh writes the fresh-write scan finds); one, and the answer is partial and says `index_not_ready`.
 *
 * ## The defect it prevents
 *
 * The recogniser was a regex written inside `recallByType`, and it did not know mongot's FIRST wording. Measured on
 * the test store by creating an index over one record and querying it every 20 ms until it served (bundle-30 I9,
 * bundle-72 PROBE M1), mongot says, in order, all as code 8 `UnknownError` under
 * `Executor error during aggregate command … :: caused by ::`:
 *
 *     Index <name> not initialized
 *     cannot query vector index <id> (vector index <name> …) while in state NOT_STARTED
 *     cannot query vector index <id> (vector index <name> …) while in state INITIAL_SYNC
 *
 * and a lexical `$search` index says `cannot query search index … while in state UNKNOWN`, then INITIAL_SYNC, with no
 * Executor prefix. The first lasts tens of milliseconds on a warm mongot and longer on a loaded one.
 *
 * ## An allowlist of the not-yet states, and why
 *
 * It matched `search.*index` and the any-state `cannot query … vector index` too, so it also swallowed an index in
 * state FAILED or STALE, code 125 `Error connecting to Search Index Management service.`, and any error naming a
 * `research_index` namespace (bundle-72 P8) — each answered as an empty collection with nothing saying so. FAILED could
 * not be produced on atlas-local (PROBE M1), so the rule is the states SEEN while building, plus the absent-index
 * wordings (an absent index is "not yet" too), and nothing else: a dimension mismatch, a path not indexed as vector,
 * a synonym mapping in state INVALID, a dead mongot and every state not listed fall to the caller's will-not-serve or
 * store-failure branch.
 *
 * ## What it must NOT match
 *
 * A deadline, a malformed query, an `_id` filter the index refuses (`isIdFilterRefusal`, asked first where it
 * matters), or any other executor error. Each of those read as an empty collection is an incomplete answer reported
 * as a complete one.
 *
 * Matched on the MESSAGE, because a code-8 `UnknownError` says nothing; the wording is what mongot gives us.
 */
const NOT_QUERYABLE_YET = new RegExp([
  /index.*not.*found/.source,
  /no.*such.*index/.source,
  /while in state (NOT_STARTED|INITIAL_SYNC|PENDING|BUILDING|STARTING|UNKNOWN)\b/.source,
  // mongot's first answer for an index it has accepted and not yet begun building.
  /\bindex\b.*\bnot initiali[sz]ed\b/.source,
].join('|'), 'i');

/** True when `err` (an error or its message) says the vector index is absent or not serving yet. */
export function isIndexNotQueryableYet(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return NOT_QUERYABLE_YET.test(msg);
}

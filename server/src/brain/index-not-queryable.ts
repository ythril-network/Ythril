/**
 * Is this a vector index that cannot be queried YET — absent, or still being built? (Q-325)
 *
 * ## What it is for
 *
 * A collection's vector index is built after its first record and asynchronously (`spaces/search-index-presence.ts`),
 * and rebuilt in the background after a definition change. Until it serves, mongot refuses every `$vectorSearch`
 * against it. A reader answers that refusal as "this collection has nothing for the vector channel yet" — the promise
 * `search-index-presence.ts` makes for an absent index — and the records the index has not ingested are found by the
 * fresh-write scan instead. Recall, `findSimilar` and the insert-time `checkDuplicates` all read through
 * `recallByType`, which asks this; the face gallery's own catch answers every non-deadline failure as "no gallery".
 *
 * ## The defect it prevents
 *
 * The recogniser was a regex written inside `recallByType`, and it did not know mongot's FIRST wording. Measured on
 * the test store by creating an index over one record and querying it every 20 ms until it served (bundle-30 I9),
 * mongot says, in order, all as code 8 `UnknownError` under `Executor error during aggregate command … :: caused by ::`:
 *
 *     Index <name> not initialized
 *     cannot query vector index <id> (vector index <name> …) while in state NOT_STARTED
 *     cannot query vector index <id> (vector index <name> …) while in state INITIAL_SYNC
 *
 * The first lasts tens of milliseconds on a warm mongot and longer on a loaded one. It fell through to the store
 * failure classifier and answered 503, so a recall straight after a space's first write answered 503 or 200
 * depending on which millisecond it landed in.
 *
 * ## What it must NOT match
 *
 * A deadline, a malformed query, an `_id` filter the index refuses (`isIdFilterRefusal`, asked first where it
 * matters), or any other executor error. Each of those read as an empty collection is an incomplete answer reported
 * as a complete one. The older alternatives are kept as they were, `search.*index` and the any-state
 * `cannot query … vector index` included: narrowing them changes which failures answer 503, which is its own change.
 *
 * Matched on the MESSAGE, because a code-8 `UnknownError` says nothing; the wording is what mongot gives us.
 */
const NOT_QUERYABLE_YET = new RegExp([
  /index.*not.*found/.source,
  /no.*such.*index/.source,
  /search.*index/.source,
  /cannot query.*vector index/.source,
  /while in state (NOT_STARTED|INITIAL_SYNC|PENDING|BUILDING|STARTING)/.source,
  // mongot's first answer for an index it has accepted and not yet begun building.
  /\bindex\b.*\bnot initiali[sz]ed\b/.source,
].join('|'), 'i');

/** True when `err` (an error or its message) says the vector index is absent or not serving yet. */
export function isIndexNotQueryableYet(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return NOT_QUERYABLE_YET.test(msg);
}

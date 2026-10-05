/**
 * What a space's collections hold, whole and comparable — the question "did a refused operation change anything".
 *
 * ## Why a module
 *
 * A refusal test reads every collection the operation could have written before and after it, and compares. Every
 * -db test that asks it (`a-refused-cascade-removes-nothing-db` today) reads the same parts the same way, so a part
 * seeded is a part compared; the push door's `wipe` clears the same list (`RECORD_PARTS`).
 *
 * ## The guards a hand-written copy drops
 *
 * - **A stable order.** `find({})` returns documents in whatever order the store has them, and a write that moves a
 *   document can reorder the rest; compared as JSON, two snapshots of identical contents then differ. Every part is
 *   read sorted by `_id`.
 * - **A snapshot of nothing.** No parts, or two snapshots with no keys, compare equal whatever the operation did —
 *   the assertion "nothing changed" passes about nothing. Both throw instead.
 */
import assert from 'node:assert/strict';

/**
 * Every document of each of `parts` in `space`, sorted by `_id`: `{ [part]: doc[] }`.
 *
 * @param {object} mongo  the server's `db/mongo.js` module (as `openTestMongo` hands it)
 * @param {string} space
 * @param {readonly string[]} parts  collection suffixes (`facts`, `edges`, …) — at least one
 */
export async function snapshotParts(mongo, space, parts) {
  assert.ok(parts.length > 0, 'a snapshot of no parts compares equal whatever happened');
  const out = {};
  for (const p of parts) out[p] = await mongo.col(`${space}_${p}`).find({}).sort({ _id: 1 }).toArray();
  return out;
}

/**
 * The record parts a refusal or a push test seeds and clears: the knowledge collections, the tombstones and the embed
 * jobs. One list for the snapshot and the wipe, so a part seeded is a part compared and cleared.
 */
export const RECORD_PARTS = Object.freeze(['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones', 'embed_jobs']);

/**
 * Empty `parts` of `space` — the push door's wipe and a refusal test's, one loop. Throws on no parts, like the
 * snapshot: a wipe of nothing leaves the last case's records for the next to trip over, silently.
 */
export async function wipeParts(mongo, space, parts) {
  assert.ok(parts.length > 0, 'a wipe of no parts clears nothing');
  for (const p of parts) await mongo.col(`${space}_${p}`).deleteMany({});
}

/** The keys of two snapshots whose contents differ, but for `ignore` — named, so a failure says WHAT changed. */
export function changedParts(before, after, { ignore = [] } = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  assert.ok(keys.length > 0, 'two empty snapshots compare equal whatever happened');
  return keys.filter(k => !ignore.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

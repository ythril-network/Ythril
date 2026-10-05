/**
 * What a space's collections hold, whole and comparable — the question "did a refused operation change anything".
 *
 * ## Why a module
 *
 * A refusal test reads every collection the operation could have written before and after it, and compares. Two
 * -db tests wrote it (`a-refused-cascade-removes-nothing-db`, `a-refused-merge-answers-alike-on-every-door-db`),
 * each with its own loop and its own comparison.
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

/** The keys of two snapshots whose contents differ, but for `ignore` — named, so a failure says WHAT changed. */
/**
 * The record parts a refusal or a push test seeds and clears: the knowledge collections, the tombstones and the embed
 * jobs. One list for the snapshot and the wipe, so a part seeded is a part compared and cleared.
 */
export const RECORD_PARTS = Object.freeze(['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones', 'embed_jobs']);

/**
 * Empty `parts` of `space` — the push door's wipe and a refusal test's, one loop (bundle-30 I6, T4). Throws on no
 * parts, like the snapshot: a wipe of nothing leaves the last case's records for the next to trip over, silently.
 */
export async function wipeParts(mongo, space, parts) {
  assert.ok(parts.length > 0, 'a wipe of no parts clears nothing');
  for (const p of parts) await mongo.col(`${space}_${p}`).deleteMany({});
}

export function changedParts(before, after, { ignore = [] } = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  assert.ok(keys.length > 0, 'two empty snapshots compare equal whatever happened');
  return keys.filter(k => !ignore.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/**
 * WHICH documents differ between two snapshots, by identity: `["<part> <_id>: added|removed|changed", …]`, sorted.
 * `changedParts` says that a part differs; a test that has to say what LANDED — a write the caller was told had not
 * completed, arriving afterwards — names the document, since a count passes when one landed and another went.
 *
 * A part present in only one of the snapshots is an error, not an empty part: comparing a snapshot with something it
 * does not hold would report every document of the other as added.
 */
export function changedDocuments(before, after) {
  assert.deepEqual(Object.keys(before).sort(), Object.keys(after).sort(), 'two snapshots of different parts are not comparable');
  assert.ok(Object.keys(before).length > 0, 'two empty snapshots compare equal whatever happened');
  const out = [];
  for (const part of Object.keys(before)) {
    const was = new Map(before[part].map(d => [d._id, JSON.stringify(d)]));
    const now = new Map(after[part].map(d => [d._id, JSON.stringify(d)]));
    for (const [id, json] of now) {
      if (!was.has(id)) out.push(`${part} ${id}: added`);
      else if (was.get(id) !== json) out.push(`${part} ${id}: changed`);
    }
    for (const id of was.keys()) if (!now.has(id)) out.push(`${part} ${id}: removed`);
  }
  return out.sort();
}

/**
 * `snapshotParts` plus the space's counter row, in ONE round trip: `{ [part]: doc[], counter: doc[] }`.
 *
 * For a test that reads a space while something else may be writing to it and has to take that read at a chosen
 * moment — `snapshotParts` reads one part after another, so a read begun just before a write lands straddles it, and
 * a read of many parts at once from many spaces at once exhausts the driver's pool and starves the very writes under
 * test (`Q-372`: 22 spaces x 9 reads made the doors fail "connection checkout"). One aggregation (`$unionWith` over every
 * part, from the counter collection, which always exists) is one connection and one answer.
 */
export async function snapshotSpaceInOneRead(mongo, space, parts) {
  assert.ok(parts.length > 0, 'a snapshot of no parts compares equal whatever happened');
  const tagged = (part) => ({ $project: { _id: 0, part: { $literal: part }, doc: '$$ROOT' } });
  const rows = await mongo.col('ythril_counters').aggregate([
    { $match: { _id: space } },
    tagged('counter'),
    ...parts.map(p => ({ $unionWith: { coll: `${space}_${p}`, pipeline: [tagged(p)] } })),
    { $sort: { part: 1, 'doc._id': 1 } },
  ]).toArray();
  const out = Object.fromEntries([...parts, 'counter'].map(p => [p, []]));
  for (const r of rows) out[r.part].push(r.doc);
  return out;
}

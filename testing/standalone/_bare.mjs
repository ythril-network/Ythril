/**
 * A seed document without the keys whose value is `undefined`.
 *
 * ## What it prevents (Q-792, part 9)
 *
 * `row({ description: undefined })` meant "a row with no description key". The MongoDB driver stores a key whose value is `undefined` as `null`
 * (it ignores undefined only when the client is opened with `ignoreUndefined`, which the harness client is not), so the seeded row HAD a
 * description, `null`, and the case exercised the null row while its name said absent. A seed helper that wants "no such field" to be spelt
 * `undefined` hands its document through this function before any write; `a-seed-never-stores-null-for-an-absent-field` fails a seed that
 * lets such a key reach `insertOne`, `insertMany`, `replaceOne`, `updateOne`, `updateMany` or `bulkWrite` another way.
 *
 * ## What it does and does not touch
 *
 * Plain objects lose their `undefined` keys at every depth, and an array is walked so an object inside it does too. An array keeps its positions
 * (an `undefined` element cannot be dropped without moving the rest), and `null`, `0`, `''` and `false` are values and stay. Anything that is not a
 * plain object (a `Date`, an `ObjectId`, a `Buffer`, a class instance) is returned as it is: the driver knows how to store it, and rebuilding it as
 * an object would change what is stored. The input is never changed; a copy comes back.
 *
 * Not for request arguments: `_fork-kinds.mjs` strips those for another reason (a JSON body drops `undefined` itself).
 */

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** `doc` without its `undefined`-valued keys, at every depth; see the module comment. */
export function bare(doc) {
  if (Array.isArray(doc)) return doc.map(bare);
  if (!isPlainObject(doc)) return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (v !== undefined) out[k] = bare(v);
  return out;
}

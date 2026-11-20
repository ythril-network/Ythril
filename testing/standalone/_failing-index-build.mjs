/**
 * Make the build of ONE index on ONE collection fail with an error the store itself gave, while every other index builds
 * (bundle-101, Q-445 design rev 5.1 item 7: "a failing best-effort or report index", "the background pass names a failed index",
 * "a restore whose unique build fails (store error injected)"), or of a SET of indexes at once ({@link failIndexBuilds},
 * bundle-356: a case that refuses one index per pass pays one pass per index).
 *
 * ## Why not `_write-faults.mjs` `failWrites`
 *
 * `failWrites` arms a METHOD on a COLLECTION: every `createIndex` on `<space>_edges` would fail, and a test of "the rest still
 * build" would have failed the rest too. The question here is narrower - one index, chosen by its name or its keys - so it is
 * its own module.
 *
 * ## What a hand-written copy drops
 *
 * **A fault that never fired.** An index the code under test never builds (or builds through a method this did not wrap) fails
 * nothing, and "a failing index does not stop X" then passes having failed nothing. {@link failIndexBuild}'s `fired` says how
 * many builds it refused, and a test asserts it before believing the rest. With a set of targets the total is not enough (one
 * refused target hides another that never fired), so {@link failIndexBuilds} counts each target on its own.
 *
 * **An error nobody would get.** The error thrown is the store's own refusal of an index it cannot build (a key with an unknown
 * index type, code 67 `CannotCreateIndex`), taken from the harness store once ({@link storeIndexRefusal}): a `space-failure` to
 * every verdict, never a duplicate key and never a store that stopped answering. It names no index of the space, so a line or
 * an error that names the failed index named it itself.
 *
 * Both `createIndex` and `createIndexes` are wrapped: a builder that moves from one to the other is still refused.
 */
import assert from 'node:assert/strict';
import { defaultIndexName } from './_space-index-declaration.mjs';

/** The store's refusal of an unbuildable index, produced on `db` (a scratch collection, dropped after). */
export async function storeIndexRefusal(db) {
  const scratch = db.collection('_q445_index_refusal');
  try {
    await scratch.createIndex({ a: 'no-such-index-type' });
  } catch (err) {
    return err;
  } finally {
    await scratch.drop().catch(() => {});
  }
  throw new Error('storeIndexRefusal: the store built an index of an unknown type, so there is no refusal to hand back');
}

/** The name a `createIndex(keys, options)` call builds. */
const nameOfCall = (keys, options) => options?.name ?? defaultIndexName(keys);

const targetKey = (collectionName, indexName) => `${collectionName}\u0000${indexName}`;

/**
 * Wrap `proto` (`Collection.prototype`) so that a build of any armed index on its armed collection throws the armed error.
 * Each armed target is counted on its own.
 *
 * @returns {{
 *   fail(targets: { collectionName: string, indexName: string }[], err: Error): void,
 *   firedOf(collectionName: string, indexName: string): number,
 *   fired(): number,
 *   clear(): void,
 *   restore(): void,
 * }}
 */
export function failIndexBuilds(proto) {
  const originals = { createIndex: proto.createIndex, createIndexes: proto.createIndexes };
  let armed = null;
  /** @type {Map<string, number>} */
  let firedBy = new Map();
  const hit = (coll, keys, options) => {
    const key = targetKey(coll.collectionName, nameOfCall(keys, options));
    if (!armed?.keys.has(key)) return false;
    firedBy.set(key, (firedBy.get(key) ?? 0) + 1);
    return true;
  };
  proto.createIndex = async function createIndex(keys, options, ...rest) {
    if (hit(this, keys, options)) throw armed.err;
    return originals.createIndex.call(this, keys, options, ...rest);
  };
  proto.createIndexes = async function createIndexes(specs, ...rest) {
    // One call is refused whole, and every target in it is counted: the store refuses the batch, not one spec of it.
    const refused = (specs ?? []).map(s => hit(this, s.key, s)).filter(Boolean).length > 0;
    if (refused) throw armed.err;
    return originals.createIndexes.call(this, specs, ...rest);
  };
  return {
    fail(targets, err) {
      assert.ok(err instanceof Error, 'failIndexBuilds: the fault is not an error');
      assert.ok(targets.length > 0, 'failIndexBuilds: no target is armed, so nothing would be refused');
      armed = { keys: new Set(targets.map(t => targetKey(t.collectionName, t.indexName))), err };
      firedBy = new Map();
    },
    firedOf: (collectionName, indexName) => firedBy.get(targetKey(collectionName, indexName)) ?? 0,
    fired: () => [...firedBy.values()].reduce((a, b) => a + b, 0),
    clear() { armed = null; firedBy = new Map(); },
    restore() { armed = null; Object.assign(proto, originals); },
  };
}

/**
 * {@link failIndexBuilds} for ONE index on ONE collection: the form a case that refuses one build at a time reads.
 *
 * @returns {{ fail(collectionName: string, indexName: string, err: Error): void, fired(): number, clear(): void, restore(): void }}
 */
export function failIndexBuild(proto) {
  const many = failIndexBuilds(proto);
  return {
    fail: (collectionName, indexName, err) => many.fail([{ collectionName, indexName }], err),
    fired: many.fired,
    clear: many.clear,
    restore: many.restore,
  };
}

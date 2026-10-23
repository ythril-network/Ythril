/**
 * Make the build of ONE index on ONE collection fail with an error the store itself gave, while every other index builds
 * (bundle-101, Q-445 design rev 5.1 item 7: "a failing best-effort or report index", "the background pass names a failed index",
 * "a restore whose unique build fails (store error injected)").
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
 * many builds it refused, and a test asserts it before believing the rest.
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

/**
 * Wrap `proto` (`Collection.prototype`) so that a build of the armed index on the armed collection throws `err`.
 *
 * @returns {{ fail(collectionName: string, indexName: string, err: Error): void, fired(): number, clear(): void, restore(): void }}
 */
export function failIndexBuild(proto) {
  const originals = { createIndex: proto.createIndex, createIndexes: proto.createIndexes };
  let armed = null;
  let fired = 0;
  const hits = (coll, keys, options) => armed && coll.collectionName === armed.collectionName && nameOfCall(keys, options) === armed.indexName;
  proto.createIndex = async function createIndex(keys, options, ...rest) {
    if (hits(this, keys, options)) { fired++; throw armed.err; }
    return originals.createIndex.call(this, keys, options, ...rest);
  };
  proto.createIndexes = async function createIndexes(specs, ...rest) {
    if ((specs ?? []).some(s => hits(this, s.key, s))) { fired++; throw armed.err; }
    return originals.createIndexes.call(this, specs, ...rest);
  };
  return {
    fail(collectionName, indexName, err) {
      assert.ok(err instanceof Error, `failIndexBuild: the fault for ${indexName} is not an error`);
      armed = { collectionName, indexName, err };
      fired = 0;
    },
    fired: () => fired,
    clear() { armed = null; fired = 0; },
    restore() { armed = null; Object.assign(proto, originals); },
  };
}

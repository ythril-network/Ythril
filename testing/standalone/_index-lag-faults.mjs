/**
 * Faults for a FILTERED recall over an index that serves but may have missed a match, and a way to count the reads that
 * ask whether it did (Q-696).
 *
 * ## Why this is a module
 *
 * A filtered recall whose native `$vectorSearch` answers nothing says "no match" with no reason (Q-696), and the question
 * "did the index miss one?" is two reads: the filtered holds-read (a `findOne` over the collection that applies the
 * caller's predicate to aged vectored records) and a probe of the index itself (an unfiltered `$vectorSearch`). Three
 * tests need the same three seams - a lagging index, a refusing probe, a holds-read that times out or is counted - and a
 * second spelling of any of them is how one of them ends up matching a read it was not meant to. They live here once,
 * beside `_mongot-refusals.mjs`, whose wordings the probe refusal reuses.
 *
 * ## What each seam does, and what it leaves alone
 *
 *  - `lagFilteredVectorSearch` lets every `$vectorSearch` reach the real store and answers the ones that carry a native
 *    `filter` with no hits - an index that serves and has not ingested the matches yet. The UNFILTERED `$vectorSearch`
 *    (the probe: no `filter` key) is the real index's answer, or, with `probeRefusal`, the refusal that `make` gives.
 *  - `watchHoldsRead` wraps `Collection.findOne` and acts only on a read `matches(collectionName, filter)` accepts - the
 *    filtered holds-read, never another `findOne`. It counts them and, with `timeout`, answers them with the store's
 *    `MaxTimeMSExpired`, as the driver delivers it. Everything else, including the unfiltered holds-read, runs untouched.
 *
 * Both patches are process-wide: always `restore()` in a `finally`.
 */
import { Collection, MongoServerError } from 'mongodb';

/**
 * Answer every native-filtered `$vectorSearch` aggregate (optionally only on collections `only(collectionName)` accepts)
 * with no hits. With `probeRefusal` (a `REFUSALS` entry, or a function of `(namespace, indexName)` giving the same shape),
 * an unfiltered `$vectorSearch` is refused with it instead of answered.
 * Returns `{ emptied(), refusedProbes(), restore() }`.
 */
export function lagFilteredVectorSearch({ only = () => true, probeRefusal } = {}) {
  const original = Collection.prototype.aggregate;
  let emptied = 0;
  let refusedProbes = 0;
  Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    const stage = Array.isArray(pipeline) ? pipeline[0]?.['$vectorSearch'] : undefined;
    if (!stage || !only(this.collectionName)) return cursor;
    if (stage.filter !== undefined) {
      cursor.toArray = async () => { emptied++; await cursor.close(); return []; };
    } else if (probeRefusal) {
      const err = new MongoServerError({ ok: 0, ...probeRefusal(`${this.dbName}.${this.collectionName}`, stage.index) });
      cursor.toArray = async () => { refusedProbes++; await cursor.close(); throw err; };
    }
    return cursor;
  };
  return { emptied: () => emptied, refusedProbes: () => refusedProbes, restore: () => { Collection.prototype.aggregate = original; } };
}

/**
 * The filtered holds-read, and only it: a `findOne` that projects records carrying a vector, older than the fresh-write
 * window, AND names `marker` - a value only the caller's predicate holds. The unfiltered holds-read (no predicate) and every
 * other `findOne` of the code under test do not contain it.
 */
export function filteredHoldsRead(marker) {
  return (collectionName, filter) => {
    const text = JSON.stringify(filter ?? {});
    return text.includes('"embedding"') && text.includes('"updatedAt"') && text.includes(marker);
  };
}

/**
 * Count the `findOne` calls `matches(collectionName, filter)` accepts; with `timeout`, answer each with the store's
 * `MaxTimeMSExpired` instead of reading. Returns `{ calls(), restore() }`; `calls()` is the collection name of each match.
 */
export function watchHoldsRead(matches, { timeout = false } = {}) {
  const original = Collection.prototype.findOne;
  const calls = [];
  Collection.prototype.findOne = function findOne(filter, ...rest) {
    if (!matches(this.collectionName, filter)) return original.call(this, filter, ...rest);
    calls.push(this.collectionName);
    if (!timeout) return original.call(this, filter, ...rest);
    return Promise.reject(new MongoServerError({
      ok: 0, code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'Executor error during find command :: caused by :: operation exceeded time limit',
    }));
  };
  return { calls: () => [...calls], restore: () => { Collection.prototype.findOne = original; } };
}

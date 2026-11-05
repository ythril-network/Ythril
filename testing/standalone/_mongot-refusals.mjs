/**
 * mongot's refusals of a `$vectorSearch`, verbatim from the bundle-72 probe, and a way to make the REAL store give one.
 *
 * ## Why this is a module
 *
 * The `-db` tests of bundle-72 (recall, similar, the dupe scanner, the gallery, the media job) each need the answer a
 * real mongot gives for an index that is not serving yet, or will not serve, at a moment the harness cannot hold open:
 * `Index <name> not initialized` lasts tens of milliseconds, and FAILED could not be produced on atlas-local at all.
 * `a-recall-while-the-index-initialises-is-answered-db.test.js` wrote its own copy of the injection; a second and third
 * spelling of the wordings is how one of them ends up missing a state, so the wordings and the injection live here once.
 *
 * ## What it does, and does not
 *
 * `refuseVectorSearch` lets every `$vectorSearch` aggregate reach the real store and then answers its `toArray` with the
 * refusal, as the driver delivers it (a `MongoServerError`, code 8 `UnknownError`, at the read). Everything else the code
 * under test does - the fresh-write scan, the record reads, the emptiness read - runs against the real store. A refusal
 * a REAL mongot gives (an index created with the wrong `numDimensions`) is made by the test itself, not injected here.
 *
 * The messages are the probe's own (`plan.md` PROBE M1/M2): the namespace and index name are the caller's.
 */
import { Collection, MongoServerError } from 'mongodb';

const executor = (ns, cause) => `Executor error during aggregate command on namespace: ${ns} :: caused by :: ${cause}`;
const cannotQuery = (ns, index, state) => executor(ns, `cannot query vector index 6ac200536babb9145b2f38d3 (vector index ${index} `
  + `collection ${ns.split('.')[1]} (1f5dc6dd-5793-469f-8217-0740a958d21a) in database ${ns.split('.')[0]}) while in state ${state}`);

/**
 * Every wording the probe saw, as a function of the namespace (`db.collection`) and the index name.
 * `notYet` are the three a building index gives, in order; `willNotServe` are the ones for an index that exists and
 * will not serve without action; `storeCondition` is a dead mongot (code 6), which is a store failure and not an index one.
 */
export const REFUSALS = {
  notInitialized: (ns, index) => ({ code: 8, codeName: 'UnknownError', errmsg: executor(ns, `Index ${index} not initialized`) }),
  notStarted: (ns, index) => ({ code: 8, codeName: 'UnknownError', errmsg: cannotQuery(ns, index, 'NOT_STARTED') }),
  initialSync: (ns, index) => ({ code: 8, codeName: 'UnknownError', errmsg: cannotQuery(ns, index, 'INITIAL_SYNC') }),
  /** Synthetic: FAILED could not be produced on atlas-local (PROBE); the wording is the `while in state` form with FAILED. */
  failed: (ns, index) => ({ code: 8, codeName: 'UnknownError', errmsg: cannotQuery(ns, index, 'FAILED') }),
  dimensionMismatch: (ns) => ({ code: 8, codeName: 'UnknownError',
    errmsg: executor(ns, 'vector field is indexed with 32 dimensions but queried with 64') }),
  notIndexedAsVector: (ns) => ({ code: 8, codeName: 'UnknownError', errmsg: executor(ns, 'emb is not indexed as vector') }),
  hostUnreachable: (ns) => ({ code: 6, codeName: 'HostUnreachable',
    errmsg: executor(ns, 'Error connecting to localhost:27027 :: caused by :: Connection refused') }),
};

/**
 * The server's error for the refusal `make(namespace, indexName)` gives (a `REFUSALS` entry or a function of the same shape), as the driver delivers it.
 * The one place a test builds mongot's refusal: a suite that builds its own `MongoServerError` is a second spelling of the wording, which is how one
 * copy ends up missing a state the shared one learned (`an-index-not-queryable-yet-is-an-empty-collection.test.js` holds the tests to it).
 */
export function refusalError(make, namespace, indexName) {
  return new MongoServerError({ ok: 0, ...make(namespace, indexName) });
}

/** The store's `MaxTimeMSExpired` (code 50) for a read that ran past its `maxTimeMS`, as the driver delivers it: what a bounded read of ours answers with when it is cut off. */
export function maxTimeExpiredError() {
  return new MongoServerError({
    ok: 0, code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'Executor error during find command :: caused by :: operation exceeded time limit',
  });
}

/** A `forQuery` that accepts the searches made with `vector` (a seed's stored embedding) and no other. */
export const searchesWith = (vector) => (queryVector) =>
  Array.isArray(queryVector) && queryVector.length === vector.length && queryVector.every((x, i) => Math.abs(x - vector[i]) < 1e-9);

/**
 * The ONE patch of `Collection.prototype.aggregate` for a `$vectorSearch`: every such aggregate reaches the real store (the cursor is made as ever), and
 * `answerOf({ stage, collectionName, namespace })` says what its `toArray` answers instead. It returns `undefined` to leave that search alone, or an answer:
 * `async (realToArray, cursor) => docs`, which may call `realToArray()` (a spy that watches what the store gave), or close the cursor and answer for it
 * ({@link refusesWith}, {@link answersNothing}). `stage` is the `$vectorSearch` stage, `namespace` is `db.collection`.
 *
 * The refusal, the lagging index and the spy of a recall in the build window were three copies of this skeleton (patch, read `pipeline[0].$vectorSearch`, pick
 * the searches, replace `toArray`, restore); a fourth would be a fourth place for one to match a search it was not meant to. Returns `{ restore() }`; always
 * `restore()` in a `finally`, because the patch is process-wide. `an-index-not-queryable-yet-is-an-empty-collection.test.js` holds every test to it.
 */
export function patchVectorSearch(answerOf) {
  const original = Collection.prototype.aggregate;
  Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    const stage = Array.isArray(pipeline) ? pipeline[0]?.['$vectorSearch'] : undefined;
    if (!stage) return cursor;
    const answer = answerOf({ stage, collectionName: this.collectionName, namespace: `${this.dbName}.${this.collectionName}` });
    if (!answer) return cursor;
    const real = cursor.toArray.bind(cursor);
    cursor.toArray = () => answer(real, cursor);
    return cursor;
  };
  return { restore: () => { Collection.prototype.aggregate = original; } };
}

/** An answer for {@link patchVectorSearch}: close the cursor and throw `err` (the store's refusal). `onAnswered` is told each time, so a test can count them. */
export const refusesWith = (err, onAnswered = () => {}) => async (_real, cursor) => { onAnswered(); await cursor.close(); throw err; };

/** An answer for {@link patchVectorSearch}: close the cursor and answer no hits - an index that serves and has not ingested the matches yet. */
export const answersNothing = (onAnswered = () => {}) => async (_real, cursor) => { onAnswered(); await cursor.close(); return []; };

/**
 * Answer every `$vectorSearch` aggregate (optionally only those on collections `only(collectionName)` accepts) with the
 * refusal `make(namespace, indexName)` returns. `make` is a `REFUSALS` entry or a function giving the same shape.
 * Returns `{ refused(), restore() }`; always `restore()` in a `finally`, because the patch is process-wide.
 *
 * `forQuery(queryVector)` narrows it to the searches ONE seed asks (Q-697): a neighbour search is made with the seed's own stored
 * vector, so a test that gives each record a distinct vector refuses the search of the one record it chose and lets every other seed
 * reach the real index. The per-collection `only` could not say "the third seed of the batch", which is the state a held scan needs:
 * a seed in mid-batch, with seeds before it that were settled and seeds after it that were not reached.
 */
export function refuseVectorSearch(make, { only = () => true, forQuery = () => true } = {}) {
  let refused = 0;
  const patch = patchVectorSearch(({ stage, collectionName, namespace }) => {
    if (!only(collectionName) || !forQuery(stage.queryVector)) return undefined;
    return refusesWith(refusalError(make, namespace, stage.index), () => { refused++; });
  });
  return { refused: () => refused, restore: patch.restore };
}

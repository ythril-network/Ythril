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
 * Answer every `$vectorSearch` aggregate (optionally only those on collections `only(collectionName)` accepts) with the
 * refusal `make(namespace, indexName)` returns. `make` is a `REFUSALS` entry or a function giving the same shape.
 * Returns `{ refused(), restore() }`; always `restore()` in a `finally`, because the patch is process-wide.
 */
export function refuseVectorSearch(make, { only = () => true } = {}) {
  const original = Collection.prototype.aggregate;
  let refused = 0;
  Collection.prototype.aggregate = function aggregate(pipeline, ...rest) {
    const cursor = original.call(this, pipeline, ...rest);
    const stage = Array.isArray(pipeline) ? pipeline[0]?.['$vectorSearch'] : undefined;
    if (!stage || !only(this.collectionName)) return cursor;
    const err = new MongoServerError({ ok: 0, ...make(`${this.dbName}.${this.collectionName}`, stage.index) });
    cursor.toArray = async () => { refused++; await cursor.close(); throw err; };
    return cursor;
  };
  return { refused: () => refused, restore: () => { Collection.prototype.aggregate = original; } };
}

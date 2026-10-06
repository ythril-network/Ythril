/**
 * "The store cannot answer" is ONE question, asked of one module (`db/store-condition.ts`) — and an unsatisfiable
 * write concern is NOT an answer to it (bundle-53 G1; Q-330, Q-343, feeds Q-274).
 *
 * ## What it holds
 *
 * - **A pool-checkout failure is the store's.** The driver raises two errors from the connection pool that are NOT
 *   `MongoNetworkError`s — `PoolClosedError` and `WaitQueueTimeoutError`, both `MongoDriverError`s — so a classifier
 *   keyed on the network class answered an exhausted or closed pool as "an internal fault" (500, not retryable).
 *   They are matched by `instanceof MongoDriverError` AND by their INSTANCE name (`MongoPoolClosedError`,
 *   `MongoWaitQueueTimeoutError`, the driver's `get name()`), never by the class name and never by name alone: a
 *   plain `Error` that happens to carry the name is not the driver's.
 * - **Each of the store's server codes is recognised, and the two deadline codes are not on the list** (`isWriteTimeout`
 *   answers them first; a row for them could never be reached).
 * - **The module says WHICH kind matched** (class / code / label), because a label-only match is weaker evidence
 *   than a class and the housekeeping walk reads it differently (O4).
 * - **An unsatisfiable write concern is a misconfiguration, never an outage.** Server codes 100 and 79, and code 2 with
 *   the exact text a standalone mongod answers a `w > 1` with — the one text match, taken from a driver error only. A
 *   store that cannot be reached is not retried into; a write concern that can never be met would be retried for ever.
 *   So `isStoreUnreachable` is FALSE for it.
 * - **The guard that must not be dropped:** nothing under `server/src` reaches the driver through `createRequire`
 *   (O9) — the classes are imported by name, so a driver upgrade that renames one is a compile error and not a
 *   silently empty match.
 *
 * Run: node --test testing/standalone/store-condition.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

// A module that is missing fails each case that asks it, by name, rather than the file at load.
const sc = await import('../../server/dist/db/store-condition.js').catch(() => ({}));
const errorChainModule = await import('../../server/dist/db/error-chain.js');

const requireFromServer = createRequire(path.resolve('server/package.json'));
const driver = requireFromServer('mongodb');
const cmap = requireFromServer(path.join(path.dirname(requireFromServer.resolve('mongodb')), 'cmap', 'errors.js'));
const {
  MongoServerError, MongoNetworkError, MongoDriverError, MongoWriteConcernError, MongoBulkWriteError, MongoError,
} = driver;

const STANDALONE_TEXT = "cannot use 'w' > 1 when a host is not replicated";
const POOL = { address: 'mongo-a.internal:27017' };

/** A write concern failure as the driver builds it: single (a `MongoWriteConcernError`). */
const single = (code, errmsg = 'wc failed', codeName) =>
  new MongoWriteConcernError({ writeConcernError: { code, errmsg, ...(codeName ? { codeName } : {}) } });
/** … and bulk: the code lives on `result.getWriteConcernError()`, never on the wrapper. */
const bulk = (code, errmsg = 'wc failed') =>
  new MongoBulkWriteError({ message: errmsg, writeErrors: [] }, { getWriteConcernError: () => ({ code, errmsg }) });

describe('pool-checkout failures are the store\'s condition', () => {
  const instances = {
    PoolClosedError: () => new cmap.PoolClosedError(POOL),
    WaitQueueTimeoutError: () => new cmap.WaitQueueTimeoutError('Timed out while checking out a connection from connection pool', POOL.address),
  };

  for (const [cls, make] of Object.entries(instances)) {
    it(`${cls}: a MongoDriverError by class, matched by its instance name, kind "class"`, () => {
      const e = make();
      assert.ok(e instanceof MongoDriverError, `${cls} no longer derives from MongoDriverError — re-read the finding`);
      assert.ok(!(e instanceof MongoNetworkError), `${cls} is a network error now: the table is redundant, re-read it`);
      assert.equal(sc.isStoreCondition(e), true);
      assert.equal(sc.storeConditionKind(e), 'class');
      assert.equal(sc.isStoreUnreachable(e), true);
    });
  }

  it('the production name table holds the INSTANCE names the driver reports, not its class names', () => {
    assert.deepEqual([...sc.POOL_CHECKOUT_ERROR_NAMES].sort(), ['MongoPoolClosedError', 'MongoWaitQueueTimeoutError']);
    for (const make of Object.values(instances)) {
      assert.ok(sc.POOL_CHECKOUT_ERROR_NAMES.includes(make().name), `${make().constructor.name} is not in the table by its name`);
    }
  });

  it('a plain Error carrying the name is NOT the driver\'s', () => {
    for (const name of sc.POOL_CHECKOUT_ERROR_NAMES) {
      const e = Object.assign(new Error('boom'), { name });
      assert.equal(sc.isStoreCondition(e), false, `a plain Error named ${name} was taken for the store`);
      assert.equal(sc.storeConditionKind(e), null);
    }
  });

  it('a MongoDriverError with another name is not one of them', () => {
    assert.equal(sc.isStoreCondition(new MongoDriverError('x')), false);
  });

  it('is found under a wrapper — isStoreUnreachable reads through errorChain', () => {
    const wrapped = new Error('outer', { cause: instances.WaitQueueTimeoutError() });
    assert.equal(sc.isStoreUnreachable(wrapped), true);
    assert.equal(sc.isStoreUnreachable(new Error('outer')), false);
  });
});

describe('the server codes that mean "not answerable right now"', () => {
  // A fixture is allowed to be literal: it states the twelve the module is held to.
  const CODES = [11600, 91, 11602, 189, 13436, 6, 7, 89, 9001, 10107, 13435, 134];

  it('the exported set is exactly these, and neither deadline code is in it', () => {
    assert.deepEqual([...sc.STORE_ERROR_CODES].sort((a, b) => a - b), [...CODES].sort((a, b) => a - b));
    assert.ok(!sc.STORE_ERROR_CODES.has(50) && !sc.STORE_ERROR_CODES.has(262),
      '50 / 262 are answered by isWriteTimeout first; a row here could never be reached');
  });

  for (const code of CODES) {
    it(`a MongoServerError with code ${code} is a store condition, kind "code"`, () => {
      const e = new MongoServerError({ errmsg: 'x', code });
      assert.equal(sc.isStoreCondition(e), true);
      assert.equal(sc.storeConditionKind(e), 'code');
    });
  }

  it('an unlisted code is not', () => {
    const e = new MongoServerError({ errmsg: 'x', code: 51091 });
    assert.equal(sc.isStoreCondition(e), false);
    assert.equal(sc.storeConditionKind(e), null);
  });

  it('a non-driver object with the code is not', () => {
    assert.equal(sc.isStoreCondition({ code: 189 }), false);
  });
});

describe('which kind matched: class, code, or label-only', () => {
  it('a network error is "class"', () => {
    assert.equal(sc.storeConditionKind(new MongoNetworkError('x')), 'class');
  });

  it('a server error with an unlisted code and only a label is "label"', () => {
    const e = new MongoServerError({ errmsg: 'x', code: 999_999 });
    e.addErrorLabel('RetryableWriteError');
    assert.equal(sc.isStoreCondition(e), true);
    assert.equal(sc.storeConditionKind(e), 'label');
  });

  it('a class match is "class" even when the error also carries a label or a listed code', () => {
    const e = new MongoNetworkError('x');
    e.addErrorLabel('RetryableWriteError');
    assert.equal(sc.storeConditionKind(e), 'class');
    const s = new MongoServerError({ errmsg: 'x', code: 189 });
    s.addErrorLabel('RetryableWriteError');
    assert.equal(sc.storeConditionKind(s), 'code');
  });

  it('a write concern failure that is not unsatisfiable (a timeout, 64) is the store\'s, kind "code"', () => {
    for (const e of [single(64), bulk(64)]) {
      assert.equal(sc.isStoreCondition(e), true, `${e.name} code 64`);
      assert.equal(sc.storeConditionKind(e), 'code');
    }
  });
});

describe('an unsatisfiable write concern', () => {
  it('the codes are 100 and 79', () => {
    assert.deepEqual([...sc.UNSATISFIABLE_WRITE_CONCERN_CODES].sort((a, b) => a - b), [79, 100]);
  });

  for (const code of [100, 79]) {
    it(`single, code ${code}: unsatisfiable, and NOT the store's condition`, () => {
      const e = single(code, 'Not enough data-bearing nodes');
      assert.equal(sc.isUnsatisfiableWriteConcern(e), true);
      assert.equal(sc.isStoreCondition(e), false, 'an unsatisfiable concern was taken for an outage and would be retried for ever');
      assert.equal(sc.storeConditionKind(e), null);
      assert.equal(sc.isStoreUnreachable(e), false);
      assert.equal(sc.unsatisfiableWriteConcern(e)?.code, code);
    });

    it(`bulk, code ${code} on result.getWriteConcernError(): unsatisfiable, and NOT the store's condition`, () => {
      const e = bulk(code, 'Not enough data-bearing nodes');
      assert.notEqual(e.code, code, 'the fixture must keep the code on the result, which is where the driver puts it');
      assert.equal(sc.isUnsatisfiableWriteConcern(e), true);
      assert.equal(sc.isStoreCondition(e), false);
      assert.equal(sc.isStoreUnreachable(e), false);
      assert.equal(sc.unsatisfiableWriteConcern(e)?.code, code);
    });
  }

  it('it carries the server\'s name for the code, from the error or from the stable table', () => {
    assert.equal(sc.unsatisfiableWriteConcern(single(100, 'x', 'UnsatisfiableWriteConcern'))?.codeName, 'UnsatisfiableWriteConcern');
    assert.equal(sc.unsatisfiableWriteConcern(bulk(100))?.codeName, 'UnsatisfiableWriteConcern');
    assert.equal(sc.unsatisfiableWriteConcern(bulk(79))?.codeName, 'UnknownReplWriteConcern');
  });

  it('bulk, the other shape the driver raises: the code copied onto the wrapper, the result holding none', () => {
    // `bulk/common.js` raises a write concern failure thrown by one batch as { message, code } over the batch's result.
    const e = new MongoBulkWriteError({ message: 'Not enough data-bearing nodes', code: 100, writeErrors: [] },
      { getWriteConcernError: () => undefined });
    assert.equal(e.code, 100);
    assert.equal(sc.isUnsatisfiableWriteConcern(e), true);
    assert.equal(sc.isStoreCondition(e), false);
  });

  it('a write concern TIMEOUT (64) is not unsatisfiable', () => {
    assert.equal(sc.isUnsatisfiableWriteConcern(single(64)), false);
    assert.equal(sc.isUnsatisfiableWriteConcern(bulk(64)), false);
  });

  it('a bulk that also refused documents is the documents\' (the driver raises a refusal first)', () => {
    const e = new MongoBulkWriteError({ message: 'x', writeErrors: [{ index: 0, code: 11000 }] },
      { getWriteConcernError: () => ({ code: 100, errmsg: 'x' }) });
    assert.equal(sc.isUnsatisfiableWriteConcern(e), false);
  });

  it('code 2 with the exact standalone text is unsatisfiable — driver errors only', () => {
    const e = new MongoServerError({ errmsg: STANDALONE_TEXT, code: 2, codeName: 'BadValue' });
    assert.equal(sc.isUnsatisfiableWriteConcern(e), true);
    assert.equal(sc.unsatisfiableWriteConcern(e)?.code, 2);
    assert.equal(sc.isStoreUnreachable(e), false);
  });

  it('code 2 with the text inside a bulk write\'s per-operation error is unsatisfiable too', () => {
    const e = new MongoBulkWriteError({ message: 'bulk', writeErrors: [{ index: 0, code: 2, errmsg: STANDALONE_TEXT }] },
      { getWriteConcernError: () => undefined });
    assert.equal(sc.isUnsatisfiableWriteConcern(e), true);
  });

  it('code 2 with any OTHER text is a bad value — a document\'s refusal, not ours to take', () => {
    for (const errmsg of ['bad value', "cannot use 'w' > 1", 'w > 1 when a host is not replicated', 'BadValue: something else']) {
      assert.equal(sc.isUnsatisfiableWriteConcern(new MongoServerError({ errmsg, code: 2 })), false, errmsg);
    }
  });

  it('the text with another code is not it either', () => {
    assert.equal(sc.isUnsatisfiableWriteConcern(new MongoServerError({ errmsg: STANDALONE_TEXT, code: 14 })), false);
  });

  it('a non-driver object with those fields is not it', () => {
    assert.equal(sc.isUnsatisfiableWriteConcern({ code: 100, message: 'x' }), false);
    assert.equal(sc.isUnsatisfiableWriteConcern({ code: 2, message: STANDALONE_TEXT }), false);
    assert.equal(sc.isUnsatisfiableWriteConcern(Object.assign(new Error(STANDALONE_TEXT), { code: 2 })), false,
      'a plain Error with the text is ours or a caller\'s, never the server\'s');
    assert.equal(sc.isUnsatisfiableWriteConcern(null), false);
    assert.equal(sc.isUnsatisfiableWriteConcern(undefined), false);
  });

  it('is read through our wrappers and the driver\'s nesting', () => {
    const inner = bulk(100);
    assert.equal(sc.isUnsatisfiableWriteConcern(Object.assign(new Error('page'), { underlying: inner })), true);
    assert.equal(sc.isUnsatisfiableWriteConcern(new Error('sliced', { cause: inner })), true);
  });

  it('one that also carries a retry label is still not the store\'s: the exclusion is by what it IS', () => {
    const e = single(100);
    e.addErrorLabel('RetryableWriteError');
    assert.equal(sc.isStoreCondition(e), false);
    assert.equal(sc.isStoreUnreachable(e), false);
  });

  it('every OTHER store condition is still unreachable — the exclusion took nothing else with it', () => {
    assert.equal(sc.isStoreUnreachable(new MongoNetworkError('x')), true);
    assert.equal(sc.isStoreUnreachable(new MongoServerError({ errmsg: 'x', code: 189 })), true);
    assert.equal(sc.isStoreUnreachable(new Error('plain')), false);
    assert.equal(sc.isStoreUnreachable(undefined), false);
  });
});

describe('errorChain reads an AggregateError as every error it holds (vet-B S2)', () => {
  const { errorChain } = errorChainModule;

  it('a store-side member anywhere makes the aggregate\'s chain the store\'s', () => {
    const agg = new AggregateError([new Error('one space failed'), new MongoNetworkError('connection closed'), new Error('two')], 'reload');
    assert.equal(sc.isStoreUnreachable(agg), true);
    assert.equal(sc.isStoreUnreachable(new AggregateError([new Error('a'), new TypeError('b')], 'reload')), false);
  });

  it('lists the aggregate, then its members in order — outermost first', () => {
    const [a, b] = [new Error('a'), new Error('b')];
    const agg = new AggregateError([a, b], 'x');
    assert.deepEqual(errorChain(agg), [agg, a, b]);
  });

  it('reads a member\'s own wrapping, and an aggregate inside an aggregate', () => {
    const net = new MongoNetworkError('closed');
    const inner = new AggregateError([new Error('x', { cause: net })], 'inner');
    assert.equal(sc.isStoreUnreachable(new AggregateError([inner], 'outer')), true);
  });

  it('stops on a cycle', () => {
    const agg = new AggregateError([], 'loop');
    agg.errors.push(agg, new Error('b'));
    assert.ok(errorChain(agg).length <= 3);
  });

  it('is bounded: an aggregate of a thousand failed units is not a thousand-entry list', () => {
    const agg = new AggregateError(Array.from({ length: 1000 }, (_, i) => new Error(`unit ${i}`)), 'reload');
    const n = errorChain(agg).length;
    assert.ok(n > 100 && n < 1000, `${n} entries`);
  });

  it('a linear chain is exactly what it was: itself and what it wraps, to a bounded depth', () => {
    const deep = [0, 1, 2, 3, 4, 5, 6, 7].reduce((cause, i) => new Error(`level ${i}`, { cause }), undefined);
    assert.equal(errorChain(deep).length, 5);
    const outer = new Error('outer', { cause: new Error('inner') });
    assert.deepEqual(errorChain(outer).map(e => e.message), ['outer', 'inner']);
  });
});

describe('the driver is imported by name, never reached through createRequire (O9)', () => {
  it('no source under server/src builds a require with createRequire', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 300 });
    const hits = files.filter(f => /\bcreateRequire\b/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(hits, [], `createRequire in: ${hits.join(', ')} — a renamed driver class would stop matching with no error`);
  });
});

describe('the module is where the definitions live', () => {
  it('brain/store-failure.ts no longer defines the class, label, code tables or the predicates', () => {
    const src = stripComments(readFileSync('server/src/brain/store-failure.ts', 'utf8'));
    for (const name of ['STORE_CONDITION_CLASSES', 'STORE_CONDITION_LABELS', 'STORE_ERROR_CODES', 'function isStoreCondition',
      'function isWriteConcernFailure', 'function hasLabel']) {
      assert.ok(!src.includes(name), `${name} is defined in brain/store-failure.ts again — a second copy of the question`);
    }
    assert.match(src, /db\/store-condition\.js/);
  });
});

describe('the sanity of the fixtures themselves', () => {
  it('MongoError is the base of everything built here', () => {
    for (const e of [single(100), bulk(100), new cmap.PoolClosedError(POOL)]) assert.ok(e instanceof MongoError);
  });
});

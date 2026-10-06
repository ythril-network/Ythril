/**
 * ONE verdict for "what did this failure mean to a walk over spaces" (`Q-274`, bundle-53 G8).
 *
 * ## The defect it prevents
 *
 * A background walk over the spaces has three possible answers to a failure and, before this module, four places that gave them
 * and disagreed: `isWriteTimeout` (our own bound ended the operation), `isStoreUnreachable` (the store cannot answer), the
 * boot retry's own list, and each loop's own `catch`. A hung space was read as a dead store (the walk stopped for every space)
 * or a dead store as one space's fault (one bound per space), depending on which the author happened to ask first.
 *
 * ## The table, which is the module's truth
 *
 * | the failure | the verdict |
 * |---|---|
 * | a CLASS or a server CODE of the store's condition (network, selection, pool, 11600, ...) | `store-down`, at once, no ping |
 * | only a LABEL says "the driver would try again" | `store-down` when the store does not answer a ping, else the space's own |
 * | a bound of ours ended it (`StoreTimeout`, `MongoOperationTimeoutError`, code 50) | `store-down` when the store does not answer a ping, else `space-timeout` |
 * | code 112 with `TransientTransactionError`: a hot document | `space-failure` while the store answers (one record, not the space) |
 * | anything else | `space-failure` |
 *
 * Run: node --test testing/standalone/walk-verdict.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MongoServerError, MongoNetworkError, MongoOperationTimeoutError, MongoWriteConcernError, MongoServerSelectionError,
} from 'mongodb';
import { walkVerdict } from '../../server/dist/util/space-failure.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';

/** A `storeAnswers` that says what it is told and counts how often it was asked. */
function store(answer) {
  const s = { calls: 0, answers: async () => { s.calls++; if (answer === 'throws') throw new Error('ping failed'); return answer; } };
  return s;
}

const labelled = (code, label) => { const e = new MongoServerError({ errmsg: 'x', code }); e.addErrorLabel(label); return e; };

describe('walkVerdict: what the store itself says decides first', () => {
  it('is async: it resolves to the verdict, never returns it bare', async () => {
    const p = walkVerdict(new Error('x'), { storeAnswers: store(true).answers });
    assert.ok(p instanceof Promise, 'a verdict that can consult the store is a Promise');
    assert.equal(await p, 'space-failure');
  });

  it('a driver CLASS of the store\'s condition is store-down at once, without a ping', async () => {
    for (const err of [new MongoNetworkError('socket closed'), new MongoServerSelectionError('no server', new Map())]) {
      const s = store(true);
      assert.equal(await walkVerdict(err, { storeAnswers: s.answers }), 'store-down', err.name);
      assert.equal(s.calls, 0, `${err.name}: the class is the evidence, so nothing asks the store`);
    }
  });

  it('a server CODE of the store\'s condition is store-down at once, without a ping', async () => {
    for (const code of [11600, 189, 91]) {
      const s = store(true);
      assert.equal(await walkVerdict(new MongoServerError({ errmsg: 'x', code }), { storeAnswers: s.answers }), 'store-down', String(code));
      assert.equal(s.calls, 0, String(code));
    }
  });

  it('looks through a wrapper: a store error under a StoreTimeout, and one member of an AggregateError', async () => {
    const s = store(true);
    assert.equal(await walkVerdict(new StoreTimeout(undefined, { cause: new MongoNetworkError('x') }), { storeAnswers: s.answers }), 'store-down');
    assert.equal(await walkVerdict(new AggregateError([new Error('a space'), new MongoNetworkError('x')], 'two'), { storeAnswers: s.answers }), 'store-down');
    assert.equal(s.calls, 0);
  });

  it('a LABEL alone is store-down only when the store does not answer: ping false, or a ping that throws', async () => {
    const err = () => labelled(999_999, 'RetryableWriteError');
    const up = store(true);
    assert.equal(await walkVerdict(err(), { storeAnswers: up.answers }), 'space-failure', 'the store answers: the space\'s own failure');
    assert.equal(up.calls, 1);
    assert.equal(await walkVerdict(err(), { storeAnswers: store(false).answers }), 'store-down');
    assert.equal(await walkVerdict(err(), { storeAnswers: store('throws').answers }), 'store-down', 'a ping that throws is a store that does not answer');
  });

  it('code 112 with TransientTransactionError is one hot document: a space failure while the store answers', async () => {
    const err = () => labelled(112, 'TransientTransactionError');
    assert.equal(await walkVerdict(err(), { storeAnswers: store(true).answers }), 'space-failure',
      'not a timeout, though the write-timeout classifier reads the last attempt of a bounded transaction that way');
    assert.equal(await walkVerdict(err(), { storeAnswers: store(false).answers }), 'store-down', 'and the store, when it does not answer');
  });
});

describe('walkVerdict: a bound that ended the operation', () => {
  const timeouts = () => [
    ['StoreTimeout', new StoreTimeout()],
    ['MongoOperationTimeoutError', new MongoOperationTimeoutError('Timed out')],
    ['code 50', new MongoServerError({ errmsg: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' })],
    ['StoreTimeout over code 50', new StoreTimeout(undefined, { cause: new MongoServerError({ errmsg: 'x', code: 50 }) })],
  ];

  it('is space-timeout while the store answers its ping', async () => {
    for (const [name, err] of timeouts()) {
      const s = store(true);
      assert.equal(await walkVerdict(err, { storeAnswers: s.answers }), 'space-timeout', name);
      assert.equal(s.calls, 1, `${name}: asked exactly once`);
    }
  });

  it('is store-down when the store does not answer: the fast path that spares one bound per space', async () => {
    for (const [name, err] of timeouts()) {
      assert.equal(await walkVerdict(err, { storeAnswers: store(false).answers }), 'store-down', name);
    }
  });

  it('is store-down when the ping itself throws', async () => {
    for (const [name, err] of timeouts()) {
      assert.equal(await walkVerdict(err, { storeAnswers: store('throws').answers }), 'store-down', name);
    }
  });
});

describe('walkVerdict: everything else is the space\'s own', () => {
  it('a plain error, a refused document, an unsatisfiable write concern and a lookalike name are space-failure with no ping', async () => {
    const lookalike = new Error('nope');
    lookalike.name = 'MongoNetworkError';
    const concern = new MongoWriteConcernError({ writeConcernError: { code: 100, errmsg: 'Not enough data-bearing nodes', codeName: 'UnsatisfiableWriteConcern' } });
    for (const [name, err] of [
      ['plain', new Error('x')], ['duplicate key', new MongoServerError({ errmsg: 'dup', code: 11000 })],
      ['unsatisfiable write concern', concern], ['a plain Error that carries a driver name', lookalike],
      ['a string', 'boom'], ['undefined', undefined], ['null', null],
    ]) {
      const s = store(false);
      assert.equal(await walkVerdict(err, { storeAnswers: s.answers }), 'space-failure', name);
      assert.equal(s.calls, 0, `${name}: nothing to ask the store about`);
    }
  });
});

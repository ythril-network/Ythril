/**
 * A bounded plain write is called with no driver clock of its own — even when the CLIENT carries a `timeoutMS`
 * (`Q-372`, pre-ship finding F1). The wire-level rule is held in `a-write-the-bound-ended-never-lands-db` (its second
 * variant runs a client whose `MONGO_URI` sets `timeoutMS`); this is the same rule seen at the arguments, with no database.
 *
 * ## Why
 *
 * The bound puts `maxTimeMS` on a plain write and deliberately no `timeoutMS`: a driver clock starts before the operation
 * has a connection, so it fires before the server's deadline and the caller is answered while the write is alive. But the
 * driver resolves `options?.timeoutMS ?? parent?.timeoutMS`, so a `timeoutMS` on the client (an operator's `MONGO_URI`)
 * is inherited by an operation that sets none — the bound has to set `timeoutMS: 0`, the driver's "no client deadline"
 * for that operation, or the order is reversed for that operator.
 *
 * ## The rule
 *
 * - a plain write called under a database that carries a `timeoutMS` gets `timeoutMS: 0` and the bound as `maxTimeMS`;
 * - with none inherited it gets no `timeoutMS` key at all (the path the suite proved is unchanged);
 * - a read keeps its own `timeoutMS` = the bound whatever the client carries;
 * - every method of `PLAIN_WRITE_METHODS` (derived) takes the same, at its own options argument;
 * - a driver timeout of the shape `timeoutMS: 0` produces (`MongoOperationTimeoutError`, no code 50) is still answered
 *   as `StoreTimeout`, with the driver's error as the cause.
 *
 * Run: node --test testing/standalone/a-write-bound-neutralises-a-client-timeout.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  callBounded, withinWriteBound, setWriteBoundForTest, PLAIN_WRITE_METHODS, BOUNDED_OPTIONS_ARGUMENT,
} from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';

const BOUND_MS = 4000;
const CLIENT_TIMEOUT_MS = 300;
/** The target a call states: where it goes, and the `timeoutMS` the client carries (`undefined` for none). */
const targetOf = (inheritedTimeoutMs) => ({ collection: 'sp_memories', inheritedTimeoutMs });

/** What the driver is called with: the arguments of the one call, captured; answers `result`. */
async function calledWith(method, inherited, { result = { ok: true } } = {}) {
  let seen;
  const args = Array.from({ length: BOUNDED_OPTIONS_ARGUMENT[method] + 1 }, () => ({}));
  const out = await withinWriteBound(async () => {
    const returned = callBounded(method, args, (a) => { seen = a; return Promise.resolve(result); }, targetOf(inherited));
    return returned;
  });
  assert.equal(out, result, `${method}: the driver's answer was not handed back`);
  return seen[BOUNDED_OPTIONS_ARGUMENT[method]];
}

describe('a bounded plain write and a timeoutMS the client carries', () => {
  before(() => setWriteBoundForTest({ writeTimeoutMs: BOUND_MS, holdDeadlineMs: BOUND_MS * 2 }));
  after(() => setWriteBoundForTest(null));

  it('the plain write methods are derived and floored, so an empty set cannot pass', () => {
    assert.ok(PLAIN_WRITE_METHODS.size >= 8, `only ${PLAIN_WRITE_METHODS.size} plain write method(s) — the set is broken`);
  });

  for (const method of [...PLAIN_WRITE_METHODS]) {
    it(`${method}: a client timeoutMS is neutralised with 0 and the server's deadline is the bound`, async () => {
      const options = await calledWith(method, CLIENT_TIMEOUT_MS);
      assert.equal(options.timeoutMS, 0, `${method}: the operation inherits the client's ${CLIENT_TIMEOUT_MS} ms clock, which ends it before the server's deadline`);
      assert.equal(options.maxTimeMS, BOUND_MS, `${method}: the server's deadline is not the bound`);
    });

    it(`${method}: with no client timeoutMS the operation carries none at all`, async () => {
      const options = await calledWith(method, undefined);
      assert.equal('timeoutMS' in options, false, `${method}: a timeoutMS appeared where the client carries none`);
      assert.equal(options.maxTimeMS, BOUND_MS);
    });
  }

  it('a caller\'s own timeoutMS still lowers the server\'s deadline and is not passed on to the driver as a clock', async () => {
    let seen;
    await withinWriteBound(async () => callBounded('updateOne', [{}, {}, { timeoutMS: 1500 }], (a) => { seen = a; return Promise.resolve(1); }, targetOf(CLIENT_TIMEOUT_MS)));
    assert.equal(seen[2].maxTimeMS, 1500);
    assert.equal(seen[2].timeoutMS, 0);
  });

  it('a read keeps its own timeoutMS, the bound, whatever the client carries', async () => {
    const options = await calledWith('findOne', CLIENT_TIMEOUT_MS);
    assert.equal(options.timeoutMS, BOUND_MS);
    assert.equal('maxTimeMS' in options, false);
  });

  it('a write outside any scope is called as it came, whatever the client carries', () => {
    let seen;
    callBounded('insertOne', [{ a: 1 }, { w: 1 }], (a) => { seen = a; return 1; }, targetOf(CLIENT_TIMEOUT_MS));
    assert.deepEqual(seen, [{ a: 1 }, { w: 1 }]);
  });

  it('the timeout the driver reports with timeoutMS 0 (no code 50) is answered as StoreTimeout, the driver\'s error its cause', async () => {
    const driverError = Object.assign(new Error('Server reported a timeout error'), { name: 'MongoOperationTimeoutError' });
    const err = await withinWriteBound(async () => {
      try { await callBounded('updateOne', [{}, {}, {}], () => Promise.reject(driverError), targetOf(CLIENT_TIMEOUT_MS)); } catch (e) { return e; }
      return null;
    });
    assert.ok(err instanceof StoreTimeout, `answered ${err}`);
    assert.equal(err.cause, driverError);
  });
});

/**
 * Every bounded call carries the SERVER's deadline and a client backstop, and never the driver's client-side timeout
 * (`Q-372`, `Q-716`). The wire-level rule is held in `a-write-the-bound-ended-never-lands-db`; this is the same rule seen at the
 * arguments, with no database.
 *
 * ## Why
 *
 * The driver's client-side timeout (`timeoutMS`) ended an operation on a clock that starts before the operation has a connection,
 * so before the server's deadline; it desynchronised the connection pool after a timeout on drivers before 7.8.0, so one call could
 * read another's answer (CVE-2026-119179); and from 7.8.0 it does nothing. So every bounded call - a write, a read, a cursor read,
 * a statement of a transaction - carries `maxTimeMS` (the server's deadline) and a `signal` (the backstop that ends the driver call
 * and closes its connection), and none carries `timeoutMS`. Until `Q-716` a read kept `timeoutMS` and a write switched an inherited
 * one off with `timeoutMS: 0`; both are gone, and so is the client-level `timeoutMS` they were about, which the server now names
 * at boot as having no effect.
 *
 * ## The rule
 *
 * - every method of `BOUNDED_OPTIONS_ARGUMENT` (derived) is called with `maxTimeMS` = the bound and a `signal`, and no `timeoutMS`;
 * - a plain write (derived from `PLAIN_WRITE_METHODS`) carries the unique `comment` its backstop ends it by; a read does not;
 * - a caller's own lower `maxTimeMS` is kept;
 * - a statement of an open transaction is bounded the same way, without the write's `comment` (its transaction is sealed instead);
 * - outside any scope a call is made as it came;
 * - the server's answer to its own deadline (code 50) is `StoreTimeout`, the driver's error its cause;
 * - a `timeoutMS` in the connection string is said at boot once, and nothing is said for a string without one.
 *
 * Run: node --test testing/standalone/every-bounded-call-carries-the-server-deadline-and-no-client-timeout.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  callBounded, withinWriteBound, setWriteBoundForTest, PLAIN_WRITE_METHODS, BOUNDED_OPTIONS_ARGUMENT, RETURNS_CURSOR,
  warnIfClientTimeoutNamed,
} from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';
import { subscribeLogLines } from '../../server/dist/util/log.js';

const BOUND_MS = 4000;
const TARGET = { collection: 'sp_memories' };

/** What the driver is called with: the options of the one call, captured; answers `result` (a cursor stand-in for a cursor method). */
async function calledWith(method, { given = {}, result = { ok: true } } = {}) {
  let seen;
  const at = BOUNDED_OPTIONS_ARGUMENT[method];
  const args = Array.from({ length: at + 1 }, () => ({}));
  args[at] = given;
  await withinWriteBound(async () => {
    const returned = callBounded(method, args, (a) => { seen = a; return RETURNS_CURSOR.has(method) ? result : Promise.resolve(result); }, TARGET);
    assert.equal(await returned, result, `${method}: the driver's answer was not handed back`);
  });
  return seen[at];
}

describe('every bounded call carries the server\'s deadline and no client timeout', () => {
  before(() => setWriteBoundForTest({ writeTimeoutMs: BOUND_MS, holdDeadlineMs: BOUND_MS * 2 }));
  after(() => setWriteBoundForTest(null));

  const methods = Object.keys(BOUNDED_OPTIONS_ARGUMENT);
  it('the bounded and the plain write methods are derived and floored, so an empty set cannot pass', () => {
    assert.ok(methods.length >= 15, `only ${methods.length} bounded method(s) - the table is broken`);
    assert.ok(PLAIN_WRITE_METHODS.size >= 8, `only ${PLAIN_WRITE_METHODS.size} plain write method(s) - the set is broken`);
  });

  for (const method of methods) {
    it(`${method}: the server's deadline is the bound, a backstop signal is attached, and no timeoutMS`, async () => {
      const options = await calledWith(method);
      assert.equal(options.maxTimeMS, BOUND_MS, `${method}: the server's deadline is not the bound`);
      assert.ok(options.signal instanceof AbortSignal, `${method}: no backstop signal, so a store that does not answer is waited on for ever`);
      assert.equal('timeoutMS' in options, false, `${method}: the driver's client-side timeout was set (CVE-2026-119179; a no-op from 7.8.0)`);
      assert.equal(typeof options.comment === 'string' && options.comment.startsWith('ythril-write-bound:'), PLAIN_WRITE_METHODS.has(method),
        `${method}: only a plain write carries the comment its backstop ends it by`);
    });
  }

  it('a caller\'s own lower maxTimeMS is kept', async () => {
    const options = await calledWith('updateOne', { given: { maxTimeMS: 1500 } });
    assert.equal(options.maxTimeMS, 1500);
  });

  it('a statement of an open transaction is bounded the same way, without the write\'s comment', async () => {
    const session = { inTransaction: () => true };
    const options = await calledWith('updateOne', { given: { session } });
    assert.equal(options.maxTimeMS, BOUND_MS);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal('comment' in options, false, 'a transaction\'s statement carried a write comment: its backstop would kill one statement of a transaction the seal ends');
    assert.equal(options.session, session);
  });

  it('a call outside any scope is made as it came', () => {
    let seen;
    callBounded('insertOne', [{ a: 1 }, { w: 1 }], (a) => { seen = a; return 1; }, TARGET);
    assert.deepEqual(seen, [{ a: 1 }, { w: 1 }]);
  });

  it('the server\'s answer to its own deadline (code 50) is StoreTimeout, the driver\'s error its cause', async () => {
    const driverError = Object.assign(new Error('operation exceeded time limit'), { name: 'MongoServerError', code: 50, codeName: 'MaxTimeMSExpired' });
    const err = await withinWriteBound(async () => {
      try { await callBounded('updateOne', [{}, {}, {}], () => Promise.reject(driverError), TARGET); } catch (e) { return e; }
      return null;
    });
    assert.ok(err instanceof StoreTimeout, `answered ${err}`);
    assert.equal(err.cause, driverError);
  });
});

describe('a timeoutMS in the connection string is said at boot to have no effect', () => {
  const said = (uri) => {
    const lines = [];
    const stop = subscribeLogLines((l) => lines.push(l));
    try { return { told: warnIfClientTimeoutNamed(uri), lines: lines.filter(l => /timeoutMS has no effect/.test(l)) }; } finally { stop(); }
  };

  it('a string naming timeoutMS is told once, without quoting the string', () => {
    const { told, lines } = said('mongodb://user:secret-pw@db:27017/y?directConnection=true&timeoutMS=300');
    assert.equal(told, true);
    assert.equal(lines.length, 1, `said ${lines.length} times`);
    assert.ok(!lines[0].includes('secret-pw'), 'the line quoted the connection string, credentials included');
  });

  it('a string without one is told nothing, socketTimeoutMS and maxTimeMS-like names included', () => {
    for (const uri of ['mongodb://db:27017/y', 'mongodb://db:27017/y?socketTimeoutMS=900&wtimeoutMS=5&connectTimeoutMS=3']) {
      const { told, lines } = said(uri);
      assert.equal(told, false, `${uri}: told`);
      assert.equal(lines.length, 0);
    }
  });
});

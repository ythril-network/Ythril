/**
 * When the write bound's CLIENT BACKSTOP ends a write, the log says so — once, in words an operator can tell from a
 * timeout the server itself reported (`Q-372`, pre-ship finding O1).
 *
 * ## Why
 *
 * `callBounded` (`db/write-bound.ts`) answers `StoreTimeout` whichever clock ended a plain write, on purpose: a caller
 * never has to know which one won. But the two are different states for the operator. The server answering code 50
 * is an ordinary timeout. The backstop firing is "the server could not answer at all by its own deadline" — a write
 * blocked in a state `maxTimeMS` does not interrupt (an upsert behind another session's uncommitted insert) — and
 * until now it left no trace: a generic retryable 503, and for a door outside a hold nothing else.
 *
 * ## The rule
 *
 * - The backstop fires: ONE line, at warn level, saying the backstop ended the write, naming the method and the
 *   bound it was armed for. Not two (a retry, a second reader), not none.
 * - The server answers first (code 50): no such line. A line for every timeout would teach an operator to ignore it.
 * - A write that succeeds: no line.
 *
 * The driver call is a fake that never settles, or settles as the server would; no database is involved, so the
 * rule is held in the pure subset.
 *
 * Run: node --test testing/standalone/a-write-bound-backstop-says-so-once.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { logLinesDuring } from './_log-lines.mjs';
import { callBounded, withinWriteBound, setWriteBoundForTest, SERVER_FIRST_MARGIN_MS } from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';

/** The bound the cases run at: small, so the backstop (bound + the margin) is a fraction of a second away. */
const BOUND_MS = 40;
const BOUND = { writeTimeoutMs: BOUND_MS, holdDeadlineMs: 5000 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Run one bounded write through `withinWriteBound`, with `driver` as the driver call; what it settled with. */
async function bounded(method, driver) {
  return withinWriteBound(async () => {
    try { return { ok: true, value: await callBounded(method, [{ _id: 'x' }, {}], driver) }; } catch (error) { return { ok: false, error }; }
  });
}

/** The lines about the backstop: the ones that name it. */
const backstopLines = (lines) => lines.filter(l => /backstop/i.test(l));

describe('the write bound\'s backstop says so, once', () => {
  before(() => setWriteBoundForTest(BOUND));
  after(() => setWriteBoundForTest(null));

  it('the backstop firing is ONE warn line naming the method and the bound', async () => {
    const { lines, result } = await logLinesDuring(async () => {
      const r = await bounded('insertOne', () => new Promise(() => {}));
      await sleep(SERVER_FIRST_MARGIN_MS + 200); // a second line, from a late settle or a repeat, would arrive in this window
      return r;
    });
    assert.equal(result.ok, false, 'a driver call that never answers must be ended by the backstop');
    assert.ok(result.error instanceof StoreTimeout, `the caller is answered StoreTimeout, got ${result.error}`);
    const said = backstopLines(lines);
    assert.equal(said.length, 1, `expected the backstop to be logged exactly once, got ${said.length}: ${JSON.stringify(lines)}`);
    assert.match(said[0], /WARN/, 'the line is a warning');
    assert.match(said[0], /insertOne/, 'the line names the method that was ended');
    assert.ok(said[0].includes(String(BOUND_MS)), `the line names the bound (${BOUND_MS} ms) the write was armed for: ${said[0]}`);
  });

  it('every method the bound covers says so, not only the one that was tried first', async () => {
    for (const method of ['insertMany', 'bulkWrite', 'updateOne', 'replaceOne', 'findOneAndUpdate', 'deleteMany']) {
      const { lines } = await logLinesDuring(() => bounded(method, () => new Promise(() => {})));
      const said = backstopLines(lines);
      assert.equal(said.length, 1, `${method}: expected one backstop line, got ${said.length}`);
      assert.match(said[0], new RegExp(method), `${method}: the line does not name it`);
    }
  });

  it('the server answering first (code 50) is a timeout, and is NOT logged as the backstop', async () => {
    const { lines, result } = await logLinesDuring(async () => {
      const r = await bounded('updateOne', () => sleep(BOUND_MS).then(() => { throw Object.assign(new Error('operation exceeded time limit'), { code: 50, name: 'MongoServerError' }); }));
      await sleep(SERVER_FIRST_MARGIN_MS + 200);
      return r;
    });
    assert.ok(result.error instanceof StoreTimeout, 'the server\'s code 50 is still answered StoreTimeout');
    assert.deepEqual(backstopLines(lines), [], 'a timeout the server reported is not the backstop');
  });

  it('a write that succeeds logs nothing about the backstop', async () => {
    const { lines, result } = await logLinesDuring(async () => {
      const r = await bounded('insertOne', () => sleep(5).then(() => ({ acknowledged: true })));
      await sleep(SERVER_FIRST_MARGIN_MS + 200);
      return r;
    });
    assert.equal(result.ok, true);
    assert.deepEqual(backstopLines(lines), []);
  });
});

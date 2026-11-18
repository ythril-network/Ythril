/**
 * A stalled-read fixture reads a deadline-bound read three ways: CUT, BUSY (ask again) or NOT CUT (`Q-921`).
 *
 * ## The defect it closes
 *
 * `assertViewStalls` proves a stalled view can be ended by the server's `maxTimeMS`: it read the view once with a deadline a third
 * of the stall and demanded the server's code 50 (`MaxTimeMSExpired`). The stall is server-side JavaScript, and a server that is
 * busy ends such a read in a second way: code 11601 (`Interrupted`), "JavaScript execution interrupted". Measured on mongod 8.3.4
 * with no kill sent by anyone: 480 of 480 reads ended with code 50 one at a time, and 280 of 960 ended with 11601 beside 24 other
 * readers. So the guard failed a CI run of a change that touched no database code (Full run 44296813721, 273 ms, code 11601).
 *
 * The second answer is no proof either. Under the same load the server interrupts the JavaScript of the stall form `maxTimeMS`
 * cannot end (`$addFields` + `$function`) with the same code and words, and a `killOp` answers them too: a first fix that
 * accepted 11601 passed the non-interruptible form in 4 of 26 loaded runs.
 *
 * ## What is held
 *
 * `deadlineVerdict` answers `'cut'` only for code 50 before the stall was over; `'busy'` for the two ends that show nothing (the
 * JavaScript interrupt no sooner than the deadline, and code 50 only after the stall); `'not-cut'` for every other end, each
 * planted here. `readCutByItsDeadline` makes a `'busy'` read again and is what the guard and the fixture's own test ask, against a
 * real server (`_write-faults.mjs`, `the-stall-fixtures-stall-db.test.js`: the non-interruptible form must still be refused).
 *
 * Run: node --test testing/standalone/a-stalled-read-is-cut-by-its-deadline.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError } from 'mongodb';
import * as faults from './_write-faults.mjs';

/** How the server's answer ended in the measured runs, after the command and namespace it names first. */
const JS_INTERRUPT = 'on namespace: ythril_probe_b346.view_collapse :: caused by :: JavaScript execution interrupted';
const expired = () => new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'operation exceeded time limit' });
const interrupted = (errmsg = JS_INTERRUPT) => new MongoServerError({ code: 11601, codeName: 'Interrupted', errmsg });

/** A stall of 600 ms read with a deadline of 200 ms: the figures of the run that failed. */
const MS = 600;
const LIMIT = 200;

/** Each read's end, how long it took, and what the fixture must say of it. */
const ENDS = [
  ['code 50 before the stall is over', expired(), 208, 'cut'],
  ['code 50 one millisecond before the stall is over', expired(), MS - 1, 'cut'],
  ['the JavaScript interrupt after the deadline (the read of the failed CI run: 273 ms)', interrupted(), 273, 'busy'],
  ['the JavaScript interrupt exactly at the deadline', interrupted(), LIMIT, 'busy'],
  ['the JavaScript interrupt after the stall was over (a loaded run: 905 ms)', interrupted(), 905, 'busy'],
  ['code 50 only when the stall was over (a loaded run: 601 ms; the non-interruptible form every time)', expired(), MS + 1, 'busy'],
  ['code 50 exactly when the stall was over', expired(), MS, 'busy'],
  ['a read that completed', undefined, 150, 'not-cut'],
  ['a read that completed after the whole stall', undefined, 640, 'not-cut'],
  ['a failure that is not a deadline (the view\'s stage threw)', new MongoServerError({ code: 241, codeName: 'ConversionFailure', errmsg: 'Failed to parse number' }), 12, 'not-cut'],
  ['an interrupt sooner than the deadline: only a kill from outside ends a read there', interrupted(), LIMIT - 1, 'not-cut'],
  ['an interrupt of another wording (a killed session)', interrupted('operation was interrupted'), 273, 'not-cut'],
  ['a step-down\'s own code', new MongoServerError({ code: 11602, codeName: 'InterruptedDueToReplStateChange', errmsg: 'operation was interrupted' }), 273, 'not-cut'],
  ['an error that is not the server\'s', new Error('JavaScript execution interrupted'), 273, 'not-cut'],
];

describe('a deadline-bound read of a stalled view is cut, busy or not cut', () => {
  it('says which for every end of a read', () => {
    assert.equal(typeof faults.deadlineVerdict, 'function', 'deadlineVerdict is not exported by _write-faults.mjs');
    const wrong = ENDS
      .map(([label, error, tookMs, expected]) => [label, expected, faults.deadlineVerdict(error, { limit: LIMIT, tookMs, ms: MS })])
      .filter(([, expected, got]) => got !== expected)
      .map(([label, expected, got]) => `${label}: expected ${expected}, got ${got}`);
    assert.deepEqual(wrong, []);
  });

  it('refuses figures it cannot judge by, so a caller that drops one is not answered at all', () => {
    assert.equal(typeof faults.deadlineVerdict, 'function', 'deadlineVerdict is not exported by _write-faults.mjs');
    for (const figures of [{ tookMs: 273, ms: MS }, { limit: LIMIT, ms: MS }, { limit: LIMIT, tookMs: 273 }, { limit: Number.NaN, tookMs: 273, ms: MS }]) {
      assert.throws(() => faults.deadlineVerdict(interrupted(), figures), /limit, tookMs and ms/, `figures ${JSON.stringify(figures)} were accepted`);
    }
  });
});

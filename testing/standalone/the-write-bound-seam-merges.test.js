/**
 * `setWriteBoundForTest` merges over the CURRENT figures and refuses one that is not a usable number (`C7`, bundle-53 G5).
 *
 * ## What it prevents
 *
 * The seam copied exactly two fields of what it was given. When the bound gained a third figure (`housekeepingOpMs`), every
 * caller that passes the two it always passed (nine test files and the `_write-faults.mjs` wrapper) would have set the third
 * to `undefined`, and `Math.min(undefined, …)` is `NaN`: an operation bounded by `NaN` is bounded by nothing, and `timeoutMS: NaN`
 * is refused by the driver — a test of a bound that fails for a reason that is not the bound. The seam also took ANY object, so a
 * typo (`writeTimeoutM`) or a `0` (which the driver reads as "no bound") silently set nothing, or set the wrong thing.
 *
 * ## The rule
 *
 * - the figures given are merged over the current ones; one given leaves every other finite and unchanged;
 * - every figure given is a finite positive number: `0`, a negative, `NaN`, `Infinity`, a string and a boolean each THROW, and
 *   so does an object that names nothing (`{}`) or a name that is not a figure (a typo); a refusal changes NOTHING;
 * - `null` puts back the environment's figures, read at that moment.
 *
 * ## Seen red
 *
 * Mutation, by hand and put back by hand: the merge replaced by a field-by-field copy of two fields: the "one given leaves the
 * others finite" case reads `NaN` for `housekeepingOpMs`.
 *
 * Run: node --test testing/standalone/the-write-bound-seam-merges.test.js   (requires a prior build of server/)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wb from '../../server/dist/db/write-bound.js';

const FIGURES = {
  writeTimeoutMs: () => wb.writeTimeoutMs(),
  holdDeadlineMs: () => wb.holdDeadlineMs(),
  housekeepingOpMs: () => wb.housekeepingOpMs?.(),
};
const snapshot = () => Object.fromEntries(Object.entries(FIGURES).map(([k, read]) => [k, read()]));

describe('the write bound\'s test seam', () => {
  afterEach(() => wb.setWriteBoundForTest(null));

  it('the bound has three figures, each readable (floor)', () => {
    assert.equal(Object.keys(FIGURES).length, 3);
    for (const [name, read] of Object.entries(FIGURES)) assert.ok(Number.isFinite(read()), `${name} is not a finite number: ${read()}`);
  });

  for (const name of Object.keys(FIGURES)) {
    it(`setting ${name} alone leaves the other figures finite and unchanged`, () => {
      const before = snapshot();
      wb.setWriteBoundForTest({ [name]: 4321 });
      const after = snapshot();
      assert.equal(after[name], 4321);
      for (const other of Object.keys(FIGURES).filter(k => k !== name)) {
        assert.ok(Number.isFinite(after[other]), `${other} became ${after[other]} when only ${name} was set`);
        assert.equal(after[other], before[other], `${other} changed when only ${name} was set`);
      }
    });
  }

  it('a second partial set merges over the first, not over the environment', () => {
    wb.setWriteBoundForTest({ writeTimeoutMs: 1111 });
    wb.setWriteBoundForTest({ holdDeadlineMs: 2222 });
    assert.deepEqual([wb.writeTimeoutMs(), wb.holdDeadlineMs()], [1111, 2222]);
  });

  const UNUSABLE = [
    ['zero (the driver reads it as "no bound")', 0], ['a negative', -5], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['a numeric string', '3000'], ['a boolean', true], ['null as a figure', null], ['undefined as a figure', undefined],
  ];
  for (const name of Object.keys(FIGURES)) {
    for (const [what, value] of UNUSABLE) {
      it(`${name}: ${what} is refused, and changes nothing`, () => {
        wb.setWriteBoundForTest({ writeTimeoutMs: 900, holdDeadlineMs: 901 });
        const before = snapshot();
        assert.throws(() => wb.setWriteBoundForTest({ [name]: value }), (e) => e instanceof Error && e.message.includes(name),
          `${what} was accepted for ${name}, or refused without naming it`);
        assert.deepEqual(snapshot(), before, 'a refused set must change nothing');
      });
    }
  }

  it('an object that names no figure is refused, and so is a name that is not one', () => {
    const before = snapshot();
    assert.throws(() => wb.setWriteBoundForTest({}), /writeTimeoutMs|figure/i);
    assert.throws(() => wb.setWriteBoundForTest({ writeTimeoutM: 5 }), /writeTimeoutM/);
    assert.throws(() => wb.setWriteBoundForTest({ writeTimeoutMs: 5, holdDeadlineMS: 5 }), /holdDeadlineMS/);
    assert.deepEqual(snapshot(), before);
  });

  it('null puts back the environment\'s figures, read at that moment', () => {
    const saved = { ...process.env };
    try {
      wb.setWriteBoundForTest({ writeTimeoutMs: 1111, holdDeadlineMs: 2222, housekeepingOpMs: 3333 });
      process.env['YTHRIL_WRITE_TIMEOUT_MS'] = '5555';
      process.env['YTHRIL_HOLD_DEADLINE_MS'] = '6666';
      process.env['YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS'] = '7777';
      wb.setWriteBoundForTest(null);
      assert.deepEqual(snapshot(), { writeTimeoutMs: 5555, holdDeadlineMs: 6666, housekeepingOpMs: 7777 });
    } finally {
      for (const k of ['YTHRIL_WRITE_TIMEOUT_MS', 'YTHRIL_HOLD_DEADLINE_MS', 'YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});

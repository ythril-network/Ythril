/**
 * `api/brain/_shared.ts` — the helpers every brain write route runs through.
 *
 * Last of the QA tracker's "modules with no importing test" that is worth testing standalone. Three
 * things in here decide something consequential, and none of them was covered:
 *
 *  1. **TTL parsing decides when records get deleted.** `ttlDays` drives the F10 auto-expiry sweep. A
 *     value accepted that should not be, or a bound off by one, is silent data loss on a timer.
 *  2. **`applyValidation` is where `validationMode: 'strict'` actually blocks.** If strict stops
 *     blocking, every schema in every space becomes advisory and nothing says so.
 *
 * A third subject lived here — `buildFactFilter`, the facts list route's query-param filter. Both went in
 * 5.0: the route is `POST /api/filter`, and the `?entity=` clause it built read a link array that no
 * longer exists. What a caller asks now is `entityName`, and `attachedToEntityNamed` answers it from the
 * link records.
 *
 * Run: node --test testing/standalone/brain-shared-guards.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ttlDaysFromBody, ttlDaysError, applyValidation;

before(async () => {
  ({ ttlDaysFromBody, ttlDaysError, applyValidation } =
    await import('../../server/dist/api/brain/_shared.js'));
});

describe('ttlDays — parse and validate must agree', () => {
  it('accepts the documented range, including both ends', () => {
    for (const v of [0, 1, 365, 36_500]) {
      assert.equal(ttlDaysError({ ttlDays: v }), null, `${v} should be valid`);
      assert.equal(ttlDaysFromBody({ ttlDays: v }), v);
    }
  });

  it('0 is a real value, not a missing one', () => {
    // `Absent/0 = no expiry` per the Space type. A truthiness check would collapse 0 into "not supplied",
    // which reads the same but is a different instruction.
    assert.equal(ttlDaysFromBody({ ttlDays: 0 }), 0);
    assert.notEqual(ttlDaysFromBody({ ttlDays: 0 }), undefined);
  });

  it('null means CLEAR and is distinct from absent', () => {
    assert.equal(ttlDaysFromBody({ ttlDays: null }), null);
    assert.equal(ttlDaysFromBody({}), undefined);
    assert.equal(ttlDaysError({ ttlDays: null }), null);
    assert.equal(ttlDaysError({}), null);
  });

  it('rejects out-of-range, fractional and non-numeric values', () => {
    for (const v of [-1, 36_501, 1.5, '30', NaN, Infinity, true, [], {}]) {
      assert.match(ttlDaysError({ ttlDays: v }) ?? '', /must be an integer/, `${JSON.stringify(v)} should error`);
    }
  });

  it('the two functions never disagree — anything the validator rejects, the parser drops', () => {
    // The pair is the contract: a route calls the validator, then the parser. If the parser accepted a
    // value the validator rejected, an invalid TTL would reach a record. If it dropped one the validator
    // accepted, a valid TTL would be silently ignored. Neither may happen.
    const values = [undefined, null, 0, 1, 36_500, -1, 36_501, 1.5, '30', NaN, Infinity, true, [], {}];
    for (const v of values) {
      const absent = v === undefined;
      const body = absent ? {} : { ttlDays: v };
      const rejected = ttlDaysError(body) !== null;
      const parsed = ttlDaysFromBody(body);

      if (rejected) {
        // Rejected → must not survive parsing, or an invalid TTL reaches a record.
        assert.equal(parsed, undefined, `${JSON.stringify(v)}: rejected by the validator but parsed to ${String(parsed)}`);
      } else if (absent) {
        assert.equal(parsed, undefined, 'absent must parse to undefined (leave the TTL alone)');
      } else {
        // Accepted and present → must survive, or a valid TTL is silently ignored. `null` (clear) and
        // `0` (no expiry) are both legitimate here, so the check is "not dropped", not "truthy".
        assert.notEqual(parsed, undefined, `${JSON.stringify(v)}: accepted by the validator but dropped by the parser`);
      }
    }
  });

  it('a non-object body does not throw', () => {
    for (const b of [null, undefined, 'x', 7]) {
      assert.equal(ttlDaysError(b), null);
      assert.equal(ttlDaysFromBody(b), undefined);
    }
  });
});

describe('applyValidation — strict must actually block', () => {
  const violation = [{ field: 'type', value: 'x', reason: 'nope' }];

  it('strict blocks and reports', () => {
    const r = applyValidation({ validationMode: 'strict' }, violation);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.warnings, violation);
  });

  it('warn lets the write through but surfaces the violations', () => {
    const r = applyValidation({ validationMode: 'warn' }, violation);
    assert.equal(r.blocked, false);
    assert.deepEqual(r.warnings, violation);
  });

  it('off blocks nothing and reports nothing', () => {
    const r = applyValidation({ validationMode: 'off' }, violation);
    assert.equal(r.blocked, false);
    assert.deepEqual(r.warnings, []);
  });

  it('no meta, no mode, or no violations all mean "nothing to do"', () => {
    for (const meta of [undefined, {}, { validationMode: undefined }]) {
      assert.deepEqual(applyValidation(meta, violation), { blocked: false, warnings: [] });
    }
    assert.deepEqual(applyValidation({ validationMode: 'strict' }, []), { blocked: false, warnings: [] });
  });
});

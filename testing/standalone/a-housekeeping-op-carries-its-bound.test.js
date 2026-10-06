/**
 * Every database operation a housekeeping unit issues ends at a figure of its own, through the SAME scope and the SAME door
 * as the seq-hold bound (`Q-358`, bundle-53 G5).
 *
 * ## The defect
 *
 * A housekeeping walk (the TTL sweep, a claim walk, a drain) opens no `withinWriteBound`: it has no hold and must not end at a
 * hold's 45-second deadline across a whole unit of work. So nothing bounded ANY operation it issued: one `deleteMany` behind
 * another session's lock, or one read against a store that stopped answering, held the walk for as long as the driver waited
 * (the 40-50 s of an unbounded connection, or for ever), and the next tick found the previous one still running.
 *
 * ## The rule
 *
 * `withinHousekeepingBound(fn, { opMs? })` is the second constructor of the ONE scope type. Inside it:
 *
 * - **a read** carries `timeoutMS` = the figure (`housekeepingOpMs()`, or the scope's `opMs`); a numeric `maxTimeMS` the caller
 *   set keeps the lower and gets no `timeoutMS`;
 * - **a plain write** is ended by the SERVER at the figure (`maxTimeMS`, no `timeoutMS`) with the client backstop
 *   `SERVER_FIRST_MARGIN_MS` later, answered `StoreTimeout` — exactly the seq-hold path, so a housekeeping write the bound ended
 *   can never land afterwards (`Q-372`);
 * - **the claim scope** (`opMs: CLAIM_OP_MS`) carries its own, shorter figure;
 * - **there is NO deadline across the unit**: a walk that issues more operations than a hold's deadline would allow loses none
 *   of them. The bound is per operation, and the unit is bounded by its caller (a cycle's budget), not here;
 * - **an inner scope takes the smaller figure**: `min(own, enclosing active scope's)`, as the deadline already does. A hold's
 *   shorter bound inside a walk wins, and an operator who sets the housekeeping figure below a hold's sees it applied;
 * - a session's operation is untouched (the session bounds it), outside any scope the arguments are the caller's own, and a
 *   scope that has ended binds nothing.
 *
 * ## Seen red
 *
 * Mutations, by hand and put back by hand: `planBound` reading `writeTimeoutMs()` instead of `scope.perOpMs`; the housekeeping
 * scope given a deadline (`holdDeadlineMs()` from now).
 *
 * Run: node --test testing/standalone/a-housekeeping-op-carries-its-bound.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as wb from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';
import { sleep } from '../_shared/sleep.mjs';

const { callBounded, withinWriteBound, SERVER_FIRST_MARGIN_MS } = wb;

/** Where the calls go, and what the client inherits: stated at every call, as the module requires. */
const TARGET = { collection: 'sp_facts', inheritedTimeoutMs: undefined };
const NOT_SETTLING = () => new Promise(() => {});

/** The arguments a call's options position needs, so each method's own options argument is the one looked at. */
const argsFor = (method, options) => {
  const at = wb.BOUNDED_OPTIONS_ARGUMENT[method];
  const args = Array.from({ length: at + 1 }, () => ({}));
  args[at] = options;
  return { args, at };
};

/** What the driver is handed for `method` called inside `scope`, with `options` in its options position. */
async function handed(scope, method, options = {}) {
  const { args, at } = argsFor(method, options);
  let seen;
  await scope(async () => callBounded(method, args, (a) => { seen = a; return Promise.resolve({ ok: 1 }); }, TARGET));
  return seen[at];
}

/** A housekeeping scope at a fixed figure, whatever the environment says. */
const housekeeping = (opMs) => (fn) => wb.withinHousekeepingBound(fn, opMs === undefined ? undefined : { opMs });

describe('the housekeeping bound is a scope of the one bound', () => {
  // The backstop's timer is `unref`'d on purpose, and the driver calls below that never settle hold nothing else open: a ref'd
  // interval for the length of the file is the case's own handle (see a-write-bound-backstop-says-so-once).
  let holdTheLoop;
  before(() => { wb.setWriteBoundForTest({ writeTimeoutMs: 6000, holdDeadlineMs: 20_000, housekeepingOpMs: 7000 }); holdTheLoop = setInterval(() => {}, 60_000); });
  after(() => { wb.setWriteBoundForTest(null); clearInterval(holdTheLoop); });

  it('the module exports the scope, the figures and the claim constant', () => {
    assert.equal(typeof wb.withinHousekeepingBound, 'function', 'withinHousekeepingBound is not exported');
    assert.equal(typeof wb.housekeepingOpMs, 'function', 'housekeepingOpMs is not exported');
    assert.equal(wb.CLAIM_OP_MS, 10_000, 'the claim / reset bound is a constant of 10 000 ms');
    assert.equal(wb.housekeepingOpMs(), 7000, 'the seam did not set the figure the cases below are written against');
  });

  it('the default figure is 240 000 ms when the environment sets none', () => {
    const before = process.env['YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS'];
    delete process.env['YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS'];
    try {
      wb.setWriteBoundForTest(null);
      assert.equal(wb.housekeepingOpMs(), 240_000);
    } finally {
      if (before !== undefined) process.env['YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS'] = before;
      wb.setWriteBoundForTest({ writeTimeoutMs: 6000, holdDeadlineMs: 20_000, housekeepingOpMs: 7000 });
    }
  });

  describe('a read', () => {
    for (const method of ['find', 'findOne', 'aggregate', 'countDocuments']) {
      it(`${method} carries timeoutMS = the housekeeping figure`, async () => {
        const o = await handed(housekeeping(), method);
        assert.equal(o.timeoutMS, 7000);
        assert.equal('maxTimeMS' in o, false, 'a read carries one clock, not both');
      });
    }

    it('a numeric maxTimeMS the caller set keeps the lower, and gets no timeoutMS', async () => {
      const low = await handed(housekeeping(), 'find', { maxTimeMS: 150 });
      assert.equal(low.maxTimeMS, 150);
      assert.equal('timeoutMS' in low, false, 'maxTimeMS and timeoutMS together: the driver keeps timeoutMS and drops maxTimeMS');
      const high = await handed(housekeeping(), 'find', { maxTimeMS: 99_999 });
      assert.equal(high.maxTimeMS, 7000, 'a caller\'s maxTimeMS above the bound must be lowered to it');
    });

    it('a timeoutMS the caller set is lowered to the figure and never raised', async () => {
      assert.equal((await handed(housekeeping(), 'findOne', { timeoutMS: 100 })).timeoutMS, 100);
      assert.equal((await handed(housekeeping(), 'findOne', { timeoutMS: 99_999 })).timeoutMS, 7000);
    });
  });

  describe('a plain write', () => {
    for (const method of ['deleteMany', 'updateMany', 'findOneAndUpdate']) {
      it(`${method} is ended by the SERVER at the figure, with no driver clock`, async () => {
        const o = await handed(housekeeping(), method);
        assert.equal(o.maxTimeMS, 7000);
        assert.equal('timeoutMS' in o, false, 'a driver timeoutMS would fire before the server\'s deadline: the write could land after the answer');
      });
    }

    it('a client timeoutMS the database carries is switched off for it, as inside a hold', async () => {
      const { args, at } = argsFor('deleteMany', {});
      let seen;
      await wb.withinHousekeepingBound(async () => callBounded('deleteMany', args, (a) => { seen = a; return Promise.resolve(1); },
        { collection: 'sp_facts', inheritedTimeoutMs: 300 }));
      assert.equal(seen[at].timeoutMS, 0);
      assert.equal(seen[at].maxTimeMS, 7000);
    });

    it('a call that never settles is answered StoreTimeout at the figure plus the backstop margin, never sooner', async () => {
      const t0 = Date.now();
      const error = await wb.withinHousekeepingBound(
        () => Promise.resolve(callBounded('deleteMany', [{}, {}], NOT_SETTLING, TARGET)).then(() => null, (e) => e), { opMs: 60 });
      const ms = Date.now() - t0;
      assert.ok(error instanceof StoreTimeout, `answered ${error}, not StoreTimeout`);
      assert.ok(ms >= 60 + SERVER_FIRST_MARGIN_MS - 50, `answered after ${ms} ms: before the server's own deadline plus the margin, so the write could still land`);
    });

    it('the server answering code 50 at the figure is the same StoreTimeout, with the driver\'s error as the cause', async () => {
      const code50 = Object.assign(new Error('operation exceeded time limit'), { code: 50, name: 'MongoServerError' });
      const error = await wb.withinHousekeepingBound(
        () => Promise.resolve(callBounded('updateMany', [{}, {}, {}], () => Promise.reject(code50), TARGET)).then(() => null, (e) => e), { opMs: 60 });
      assert.ok(error instanceof StoreTimeout);
      assert.equal(error.cause, code50);
    });
  });

  describe('the scope', () => {
    it('the claim scope carries 10 000 ms, for a read and for a write alike', async () => {
      const scope = housekeeping(wb.CLAIM_OP_MS);
      assert.equal((await handed(scope, 'find')).timeoutMS, wb.CLAIM_OP_MS);
      assert.equal((await handed(scope, 'findOneAndUpdate')).maxTimeMS, wb.CLAIM_OP_MS);
    });

    it('has NO deadline across the unit: operations past a hold\'s deadline are all sent', async () => {
      wb.setWriteBoundForTest({ holdDeadlineMs: 30 });
      try {
        const sent = await wb.withinHousekeepingBound(async () => {
          await sleep(80); // longer than a hold's deadline would allow
          const out = [];
          for (let i = 0; i < 5; i++) out.push(await callBounded('find', [{}, {}], (a) => a[1], TARGET));
          return out;
        });
        assert.equal(sent.length, 5);
        for (const o of sent) assert.equal(o.timeoutMS, 7000);
        // The control: the same wait inside a hold refuses the operation unsent, so the comparison above is the scope's, not the clock's.
        const refused = await withinWriteBound(async () => { await sleep(80); try { callBounded('find', [{}, {}], (a) => a, TARGET); return null; } catch (e) { return e; } });
        assert.ok(refused instanceof StoreTimeout, 'a hold whose deadline passed must refuse the operation — the control for the case above');
      } finally {
        wb.setWriteBoundForTest({ holdDeadlineMs: 20_000 });
      }
    });

    it('boundTimeLeft is never Infinity: a scope with no deadline has no time-left to hand a caller', async () => {
      // `brain/held-transaction.ts` starts a session with `defaultTimeoutMS: boundTimeLeft() ?? writeTimeoutMs()`; an Infinity
      // there is a transaction with no bound at all. A deadline-less scope answers `undefined`, so the fallback is the finite one.
      assert.equal(await wb.withinHousekeepingBound(async () => wb.boundTimeLeft()), undefined);
      const inHold = await wb.withinHousekeepingBound(() => withinWriteBound(async () => wb.boundTimeLeft()));
      assert.ok(Number.isFinite(inHold) && inHold > 0, `a hold inside a walk is finite, got ${inHold}`);
    });

    it('a housekeeping scope inside a hold keeps the hold\'s deadline (the enclosing one, as ever)', async () => {
      wb.setWriteBoundForTest({ holdDeadlineMs: 40 });
      try {
        const refused = await withinWriteBound(() => wb.withinHousekeepingBound(async () => {
          await sleep(90);
          try { callBounded('find', [{}, {}], (a) => a, TARGET); return null; } catch (e) { return e; }
        }));
        assert.ok(refused instanceof StoreTimeout, 'an inner walk escaped the hold it ran inside');
      } finally {
        wb.setWriteBoundForTest({ holdDeadlineMs: 20_000 });
      }
    });

    it('an inner hold takes the SMALLER figure: min(own, enclosing)', async () => {
      // writeTimeoutMs is 6000 in this file; the walk's 2500 is the smaller, so it is what an inner hold's operation carries.
      const inner = await housekeeping(2500)(async () => {
        let seen;
        await withinWriteBound(async () => callBounded('deleteMany', [{}, {}], (a) => { seen = a; return Promise.resolve(1); }, TARGET));
        return seen[1];
      });
      assert.equal(inner.maxTimeMS, 2500, 'the walk\'s shorter figure did not apply inside a hold');
      // And the other way: the walk's 7000 is above the hold's 6000, so the hold's shorter bound wins inside it.
      const other = await housekeeping(7000)(async () => {
        let seen;
        await withinWriteBound(async () => callBounded('deleteMany', [{}, {}], (a) => { seen = a; return Promise.resolve(1); }, TARGET));
        return seen[1];
      });
      assert.equal(other.maxTimeMS, 6000, 'an inner hold\'s shorter bound did not win');
    });

    it('an inner housekeeping scope cannot raise the enclosing walk\'s figure', async () => {
      const o = await housekeeping(2500)(async () => handed(housekeeping(9000), 'find'));
      assert.equal(o.timeoutMS, 2500);
      const claim = await housekeeping(wb.housekeepingOpMs())(async () => handed(housekeeping(wb.CLAIM_OP_MS), 'find'));
      assert.equal(claim.timeoutMS, 7000, 'min(10 000, 7 000)');
    });

    it('a session\'s operation is untouched: the session bounds it', async () => {
      const session = { inTransaction: () => false };
      const o = await handed(housekeeping(), 'updateMany', { session });
      assert.deepEqual(Object.keys(o), ['session']);
      assert.equal(o.session, session);
    });

    it('outside any scope the caller\'s own arguments reach the driver, the same objects', () => {
      const args = [{ a: 1 }, { maxTimeMS: 5 }];
      let seen;
      callBounded('find', args, (a) => { seen = a; return null; }, TARGET);
      assert.equal(seen, args);
    });

    it('a scope that has ended binds nothing: work it left running is not bounded by it', async () => {
      let later;
      await wb.withinHousekeepingBound(async () => {
        later = (async () => { await sleep(30); const args = [{}, {}]; let seen; callBounded('find', args, (a) => { seen = a; return null; }, TARGET); return { args, seen }; })();
      });
      const { args, seen } = await later;
      assert.equal(seen, args, 'an ended scope still bounded an operation');
    });
  });
});

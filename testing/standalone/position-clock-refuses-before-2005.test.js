/**
 * The record-position clock refuses to stamp while the wall clock reads before 2005-09-05T05:58:26.843Z (bundle-81, plan rev 8 §1b and
 * §9 test 21; decision 24, testing S7). Pure: no database, no instance.
 *
 * ## The rule
 *
 * A position is `max(now() * 1000, last + 1)` in microseconds, and the legacy band (every carried 5.6 seq) tops out at `MAX_SYNC_SEQ`
 * (`2 ** 50`). The two bands must never meet: a clock position at or below `MAX_SYNC_SEQ` could sort below a carried mark that a peer
 * already holds, and the record would never be pulled. So a start whose `now() * 1000 <= MAX_SYNC_SEQ` REFUSES to stamp:
 *
 *  - the refusal's text NAMES the first usable instant, `2005-09-05T05:58:26.843Z` (the first millisecond whose microsecond count is above
 *    2^50), so an operator with a dead CMOS battery reads what to fix;
 *  - its code is `positions_clock_unusable` (the 503 every local write answers meanwhile);
 *  - the gauge `ythril_position_clock_unusable` is 1 while refused and 0 once the clock is right;
 *  - nothing is handed out and nothing is remembered: when the clock is right the very next stamp succeeds, at or above `now() * 1000`.
 *
 * ## The boundary instants (P22), derived here and not copied
 *
 * First millisecond above 2^50 µs: `floor(2^50 / 1000) + 1`. Last millisecond whose microsecond count is a safe integer: `floor((2^53 - 1) /
 * 1000)`. Both are computed from the constants and compared with the ISO strings the plan states, so a wrong string in the plan fails here.
 *
 * ## The assumption this file makes, in one place
 *
 * The plan names no factory for a stream. `streamAt` below is the ONE function that builds a stream with a settable wall clock from the
 * module's exports, assuming `util/position-clock.js` exports `createPositionStream({ name, unit, seed, now })` and `withPositionHeld(stream,
 * spaceId, write, holder)` (the hold and the stamp in one tick, as `files/tombstones.ts withPositionHeld` does today), and that a stamp REFUSED by
 * the clock rejects with an error carrying `code: 'positions_clock_unusable'`. An implementation that spells them otherwise changes `streamAt`
 * and `stampOne`, and nothing else in this file.
 *
 * Run: node --test testing/standalone/position-clock-refuses-before-2005.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MAX_SYNC_SEQ = 2 ** 50;
const FIRST_USABLE_MS = Math.floor(MAX_SYNC_SEQ / 1000) + 1;
const LAST_SAFE_MS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const FIRST_USABLE_ISO = '2005-09-05T05:58:26.843Z';
const LAST_SAFE_ISO = '2255-06-05T23:47:34.740Z';
const GAUGE = 'ythril_position_clock_unusable';

/** The module, or null when this build has none. */
async function loadClock() {
  try { return await import('../../server/dist/util/position-clock.js'); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

describe('the boundary instants of the clock band (P22)', () => {
  it('the first usable millisecond is 2005-09-05T05:58:26.843Z, and one before it is at or below 2^50 microseconds', () => {
    assert.equal(new Date(FIRST_USABLE_MS).toISOString(), FIRST_USABLE_ISO);
    assert.ok((FIRST_USABLE_MS - 1) * 1000 <= MAX_SYNC_SEQ, 'the millisecond before is still inside the legacy band');
    assert.ok(FIRST_USABLE_MS * 1000 > MAX_SYNC_SEQ, 'the first usable millisecond is above the legacy band');
  });

  it('the last millisecond whose microsecond count is a safe integer is 2255-06-05T23:47:34.740Z', () => {
    assert.equal(new Date(LAST_SAFE_MS).toISOString(), LAST_SAFE_ISO);
    assert.ok(Number.isSafeInteger(LAST_SAFE_MS * 1000));
    assert.ok(!Number.isSafeInteger((LAST_SAFE_MS + 1) * 1000));
  });
});

describe('the record-position clock refuses before 2005-09-05T05:58:26.843Z', () => {
  /** A stream whose wall clock is `clock.ms`, with a seed that finds nothing stored. ASSUMED API: see the file docblock. */
  function streamAt(mod, clock) {
    assert.equal(typeof mod.createPositionStream, 'function', 'util/position-clock.js exports no createPositionStream: the streams are built by the one clock module (rev 8 §1b)');
    return mod.createPositionStream({ name: 'b81c-test', unit: 'microseconds', seed: async () => 0, now: () => clock.ms });
  }
  /** One stamp, as a writer takes it: the position its write is handed. */
  async function stampOne(mod, stream, space = 'b81c') {
    assert.equal(typeof mod.withPositionHeld, 'function', 'util/position-clock.js exports no withPositionHeld(stream, spaceId, write, holder)');
    let handed;
    await mod.withPositionHeld(stream, space, async (pos) => { handed = pos; }, 'b81c.test');
    return handed;
  }
  const gauge = async () => {
    const { register } = await import('../../server/dist/metrics/registry.js');
    return register.getSingleMetric(GAUGE);
  };

  it('util/position-clock.js exists (the clock is extracted from files/tombstones.ts, rev 8 decision 9)', async () => {
    assert.ok(await loadClock(), 'server/dist/util/position-clock.js is missing');
  });

  it('a start one millisecond before the first usable instant refuses, naming the instant, with the 503 code, and runs no write', async () => {
    const mod = await loadClock();
    assert.ok(mod, 'server/dist/util/position-clock.js is missing');
    const clock = { ms: FIRST_USABLE_MS - 1 };
    const stream = streamAt(mod, clock);
    let ran = false;
    await assert.rejects(
      mod.withPositionHeld(stream, 'b81c', async () => { ran = true; }, 'b81c.test'),
      (err) => {
        assert.equal(err.code, 'positions_clock_unusable');
        assert.ok(String(err.message).includes(FIRST_USABLE_ISO), `the refusal does not name ${FIRST_USABLE_ISO}: ${err.message}`);
        return true;
      });
    assert.equal(ran, false, 'the write ran although the clock was refused');
  });

  it('the very first instant, and every one after up to the last safe one, stamps at now() * 1000 or above and above the legacy band', async () => {
    const mod = await loadClock();
    assert.ok(mod, 'server/dist/util/position-clock.js is missing');
    for (const ms of [FIRST_USABLE_MS, FIRST_USABLE_MS + 1, Date.now(), LAST_SAFE_MS]) {
      const stream = streamAt(mod, { ms });
      const pos = await stampOne(mod, stream);
      assert.ok(pos >= ms * 1000 && pos > MAX_SYNC_SEQ, `at ${new Date(ms).toISOString()} the stamp ${pos} is not at or above ${ms * 1000} and above 2^50`);
      assert.ok(Number.isSafeInteger(pos));
    }
  });

  it('the gauge is 1 while refused and 0 once the clock is right; the refusal is not remembered and no position was handed out', async () => {
    const mod = await loadClock();
    assert.ok(mod, 'server/dist/util/position-clock.js is missing');
    const g = await gauge();
    assert.ok(g, `no metric named ${GAUGE}: it is the observable of the refusal (rev 8 §1b, observability S6)`);
    const clock = { ms: FIRST_USABLE_MS - 1000 };
    const stream = streamAt(mod, clock);
    g.set(7); // an impossible value: only a write of the gauge by the step under test can change it (pitfall-gauge-reset-reads-zero)
    await assert.rejects(stampOne(mod, stream), (e) => e.code === 'positions_clock_unusable');
    assert.equal((await g.get()).values[0].value, 1, 'the gauge does not say the clock is unusable');
    clock.ms = FIRST_USABLE_MS + 5;
    g.set(7);
    const pos = await stampOne(mod, stream);
    assert.equal((await g.get()).values[0].value, 0, 'the gauge still says unusable after the clock was right');
    assert.ok(pos >= clock.ms * 1000, 'the first stamp after the refusal is below the clock');
    clock.ms = FIRST_USABLE_MS + 5; // a second stamp at the same instant is above the first: never equal, never lower
    assert.ok(await stampOne(mod, stream) > pos);
  });
});

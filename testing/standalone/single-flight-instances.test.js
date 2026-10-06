/**
 * `singleFlight(label)` — an instance with a lock of its own — and `runExclusive` as the process-global registry of them (`Q-317`, bundle-53 G9).
 *
 * ## What is pinned
 *
 * - **Two instances made with one label do not share a lock.** `runExclusive` keys on a label for the whole process, so a second
 *   copy of a module (a test's, a second watcher) either shared the first one's lock or had to invent a unique label by hand
 *   (`Search readiness #2`). An instance owns its lock, so the ownership is the object and not a string.
 * - **`runExclusive` is unchanged for its existing callers**: the same labels share one lock, a throw is contained and the label
 *   is released, it never rejects, `isRunning` / `runningForMs` answer by label. It is the registry of instances now, and an
 *   instance made directly is NOT in it.
 * - **The skip warning is throttled per instance** (`warnOnce({ every: 10 min })`), a stated behaviour change: it used to be said on
 *   EVERY skipped tick, which for a sweep slower than its schedule is one line per tick for as long as the pass runs.
 *
 * Run: node --test testing/standalone/single-flight-instances.test.js   (requires a prior build of server/)
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let singleFlight, runExclusive, isRunning, runningForMs, _resetSingleFlightForTests, SKIP_WARNING_WINDOW_MS;

before(async () => {
  ({ singleFlight, runExclusive, isRunning, runningForMs, _resetSingleFlightForTests, SKIP_WARNING_WINDOW_MS } =
    await import('../../server/dist/util/single-flight.js'));
});
beforeEach(() => { _resetSingleFlightForTests?.(); });

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

/** An instance with its own clock and capture, so the throttle is read in virtual time. */
function make(label = 'Sweep') {
  const clock = { t: 5_000_000 };
  const lines = { warn: [], error: [] };
  const flight = singleFlight(label, { now: () => clock.t, warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) });
  return { flight, clock, lines };
}

describe('singleFlight(label) is an instance with a lock of its own', () => {
  it('two instances made with the same label do not share a lock', async () => {
    const a = singleFlight('Same label');
    const b = singleFlight('Same label');
    const held = gate();
    const first = a.run(() => held.p);
    let ranOnB = false;
    assert.equal(await b.run(async () => { ranOnB = true; }), true, 'the other instance is not blocked by the first');
    assert.equal(ranOnB, true);
    assert.equal(a.isRunning(), true);
    assert.equal(b.isRunning(), false);
    held.release();
    await first;
  });

  it('an instance and runExclusive with the same label do not share a lock: the instance is not in the registry', async () => {
    const held = gate();
    const viaRegistry = runExclusive('Shared name', () => held.p);
    assert.equal(await singleFlight('Shared name').run(async () => {}), true);
    assert.equal(isRunning('Shared name'), true, 'the registry still sees its own pass');
    held.release();
    await viaRegistry;
  });

  it('run: true when it ran, false when it was skipped; the lock is released on completion and on a throw', async () => {
    const { flight } = make();
    const held = gate();
    const first = flight.run(() => held.p);
    assert.equal(flight.isRunning(), true);
    let secondRan = false;
    assert.equal(await flight.run(async () => { secondRan = true; }), false);
    assert.equal(secondRan, false);
    held.release();
    assert.equal(await first, true);
    assert.equal(flight.isRunning(), false);
    assert.equal(await flight.run(async () => { throw new Error('boom'); }), true, 'a throw means it ran');
    assert.equal(flight.isRunning(), false, 'and the lock is released, or the job is off for the lifetime of the process');
    assert.equal(await flight.run(async () => {}), true);
  });

  it('run never rejects, and a throw is said as "<label> failed:"', async () => {
    const { flight, lines } = make('Prune');
    await assert.doesNotReject(flight.run(async () => { throw new Error('boom'); }));
    await assert.doesNotReject(flight.run(async () => { throw 'a string'; }));
    assert.equal(lines.error.length, 2);
    assert.match(lines.error[0], /^Prune failed: .*boom/);
  });

  it('runningForMs reads the instance clock, and is null when nothing is running', async () => {
    const { flight, clock } = make();
    assert.equal(flight.runningForMs(), null);
    const held = gate();
    const first = flight.run(() => held.p);
    clock.t += 12_345;
    assert.equal(flight.runningForMs(), 12_345);
    assert.equal(flight.runningForMs(clock.t + 1_000), 13_345, 'a clock can be handed in');
    held.release();
    await first;
    assert.equal(flight.runningForMs(), null);
  });
});

describe('the skip warning is throttled per instance', () => {
  it('a pass that outlives twenty ticks says so once, with the elapsed time', async () => {
    const { flight, clock, lines } = make('Slow sweep');
    const held = gate();
    const first = flight.run(() => held.p);
    for (let i = 0; i < 20; i++) { clock.t += 1_000; assert.equal(await flight.run(async () => {}), false); }
    assert.equal(lines.warn.length, 1, `one line, not one per tick: ${JSON.stringify(lines.warn)}`);
    assert.match(lines.warn[0], /^Slow sweep: skipping this tick — the previous pass has been running for 1s\./);
    held.release();
    await first;
  });

  it('is said again once the window has passed, with the new figure', async () => {
    const { flight, clock, lines } = make('Slow sweep');
    const held = gate();
    const first = flight.run(() => held.p);
    clock.t += 1_000;
    await flight.run(async () => {});
    clock.t += SKIP_WARNING_WINDOW_MS - 1;
    await flight.run(async () => {});
    assert.equal(lines.warn.length, 1, 'still inside the window');
    clock.t += 2;
    await flight.run(async () => {});
    assert.equal(lines.warn.length, 2);
    assert.match(lines.warn[1], new RegExp(`running for ${Math.round((1_000 + SKIP_WARNING_WINDOW_MS + 1) / 1000)}s`));
    held.release();
    await first;
  });

  it('the window is ten minutes', () => {
    assert.equal(SKIP_WARNING_WINDOW_MS, 10 * 60_000);
  });

  it('each instance has its own throttle: one saying it does not silence another', async () => {
    const a = make('Job A');
    const b = make('Job A');   // the same label on purpose: the throttle is the instance's, not the label's
    const heldA = gate(); const heldB = gate();
    const pa = a.flight.run(() => heldA.p);
    const pb = b.flight.run(() => heldB.p);
    await a.flight.run(async () => {});
    await b.flight.run(async () => {});
    assert.equal(a.lines.warn.length, 1);
    assert.equal(b.lines.warn.length, 1);
    heldA.release(); heldB.release();
    await Promise.all([pa, pb]);
  });

  it('a new pass after the old one ended is not throttled by the old one\'s skips: the window is per instance, not per pass', async () => {
    const { flight, clock, lines } = make('Sweep');
    let held = gate();
    let pass = flight.run(() => held.p);
    await flight.run(async () => {});
    held.release(); await pass;
    held = gate();
    pass = flight.run(() => held.p);
    clock.t += 1_000;
    await flight.run(async () => {});
    assert.equal(lines.warn.length, 1, 'the instance said it a second ago and says nothing new');
    held.release(); await pass;
  });
});

describe('runExclusive is the process-global registry, its API unchanged', () => {
  it('one label is one lock for every caller, and a different label is another', async () => {
    const held = gate();
    const slow = runExclusive('Registry sweep', () => held.p);
    assert.equal(await runExclusive('Registry sweep', async () => {}), false);
    assert.equal(await runExclusive('Registry other', async () => {}), true);
    held.release();
    assert.equal(await slow, true);
    assert.equal(await runExclusive('Registry sweep', async () => {}), true);
  });

  it('isRunning and runningForMs answer by label; a throw is contained; it never rejects', async () => {
    const held = gate();
    const p = runExclusive('Registry watch', () => held.p);
    assert.equal(isRunning('Registry watch'), true);
    const ms = runningForMs('Registry watch');
    assert.ok(ms !== null && ms >= 0);
    assert.equal(runningForMs('Registry nothing'), null);
    assert.equal(runningForMs('Registry watch', Date.now() + 5_000) >= 5_000, true, 'a clock can be handed in');
    held.release();
    await p;
    assert.equal(isRunning('Registry watch'), false);
    assert.equal(runningForMs('Registry watch'), null);
    await assert.doesNotReject(runExclusive('Registry throws', async () => { throw new Error('boom'); }));
    assert.equal(isRunning('Registry throws'), false);
  });

  it('the reset releases every label (tests only)', async () => {
    const held = gate();
    void runExclusive('Registry stuck', () => held.p);
    assert.equal(isRunning('Registry stuck'), true);
    _resetSingleFlightForTests();
    assert.equal(isRunning('Registry stuck'), false);
    assert.equal(await runExclusive('Registry stuck', async () => {}), true);
    held.release();
  });
});

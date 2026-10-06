/**
 * What a failed space costs the operator to read: one line per condition per window, in the words the docs quote (`Q-274`,
 * bundle-53 G8).
 *
 * ## The defects it prevents
 *
 * Before the reporter, a failure in a per-space loop was either swallowed (`catch { continue; }`) or logged on every pass for
 * as long as it lasted. Both are wrong: a space nobody is told about stays broken, and a space reported every five minutes
 * buries the one line that matters. So: ONE line per (step, space, unit) per window, said again after the window, said again
 * after the step succeeded in between (a recover-then-fail is news), and bounded in memory (a peer-influenced key space).
 *
 * ## What it must never do
 *
 * **Throw.** `reportSpaceFailure` runs in a `catch` — the one place an exception of its own replaces the failure it exists to
 * say, and a caller outside a walk (`sweepAfterMetaWrite`) has nothing above it to catch it. Not when the log sink throws,
 * not when a listener of the counter signal throws, not for a value that cannot be rendered.
 *
 * Run: node --test testing/standalone/space-failure-reporter.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spaceFailureReporter, SPACE_FAILURE_WINDOW_MS, SPACE_FAILURE_MAX_KEYS, reportSpaceFailure, failureReason,
} from '../../server/dist/util/space-failure.js';
import { onHousekeepingSignal } from '../../server/dist/util/housekeeping-signals.js';
import { peerText } from '../../server/dist/util/log.js';

function harness(opts = {}) {
  const lines = [];
  const clock = { t: 1_000_000 };
  const reporter = spaceFailureReporter({ now: () => clock.t, warn: (m) => lines.push(m), ...opts });
  return { lines, clock, reporter };
}

const BOOM = new Error('boom');

describe('the three lines, word for word', () => {
  it('a space failure names the step, the space, the unit, the reason and when it is retried', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('TTL sweep: facts delete', 'ops', BOOM, { unit: 'facts', when: 'next cycle' });
    assert.deepEqual(lines, [`TTL sweep: facts delete failed for space 'ops' (facts): ${peerText(BOOM)} — retried next cycle`]);
  });

  it('a space failure without a unit has no parentheses', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('Legacy spill sweep', 'ops', BOOM, { when: 'next cycle' });
    assert.deepEqual(lines, [`Legacy spill sweep failed for space 'ops': ${peerText(BOOM)} — retried next cycle`]);
  });

  it('a quarantined space says when it is probed again', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('Embed claim', 'ops', BOOM, { when: 'next cycle', quarantineSec: 60 });
    assert.match(lines[0], /— retried after quarantine \(60s\)$/);
  });

  it('a count is in the line', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('TTL sweep: facts delete', 'ops', BOOM, { unit: 'facts', when: 'next cycle', count: 500 });
    assert.match(lines[0], /\(count: 500\)/);
  });

  it('a store that is not answering ends the step: said once, named, with the reason', () => {
    const { lines, reporter } = harness();
    reporter.storeDown('TTL sweep', new Error('connection 3 closed'));
    assert.deepEqual(lines, [`TTL sweep stopped: the store is not answering (${peerText(new Error('connection 3 closed'))}) — retried next cycle`]);
  });

  it('K spaces timing out in a row ends the step: said once, with K', () => {
    const { lines, reporter } = harness();
    reporter.storeStalled('TTL sweep', 3);
    assert.deepEqual(lines, ['TTL sweep stopped: 3 spaces timed out in a row; the store looks stalled — retried next cycle']);
  });

  it('is handed the kind: reportSpaceFailure says the store-down line for a store-down verdict and the timeout reason for a timeout', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('Embed claim', 'ops', BOOM, { when: 'next cycle', kind: 'store-down' });
    assert.match(lines[0], /^Embed claim stopped: the store is not answering/);
    reporter.spaceFailure('Embed claim', 'ops', BOOM, { when: 'next cycle', kind: 'space-timeout', bound: { ms: 240_000, env: 'YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS' } });
    assert.match(lines[1], /failed for space 'ops': .*240000 ms.*YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS.* — retried next cycle$/);
  });
});

describe('a timeout names the bound that fired and its setting', () => {
  it('the housekeeping bound names YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS', () => {
    const reason = failureReason('space-timeout', new Error('x'), { ms: 240_000, env: 'YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS' });
    assert.match(reason, /240000 ms/);
    assert.match(reason, /YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS/);
  });

  it('a fixed bound names its figure and no setting it does not have', () => {
    const reason = failureReason('space-timeout', new Error('x'), { ms: 10_000 });
    assert.match(reason, /10000 ms/);
    assert.doesNotMatch(reason, /YTHRIL_/);
  });

  it('an ordinary failure is the error\'s own text, rendered for a log', () => {
    assert.equal(failureReason('space-failure', BOOM), peerText(BOOM));
  });
});

describe('once per window', () => {
  it('the same (step, space, unit) is said once until the window passes, then again', () => {
    const { lines, clock, reporter } = harness();
    for (let i = 0; i < 5; i++) reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'next cycle' });
    assert.equal(lines.length, 1);
    clock.t += SPACE_FAILURE_WINDOW_MS - 1;
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'next cycle' });
    assert.equal(lines.length, 1, 'one ms inside the window');
    clock.t += 1;
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'next cycle' });
    assert.equal(lines.length, 2, 'the window passed');
  });

  it('another step, space or unit is its own condition', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'x' });
    reporter.spaceFailure('T', 'ops', BOOM, { unit: 'u', when: 'x' });
    reporter.spaceFailure('S', 'other', BOOM, { unit: 'u', when: 'x' });
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'v', when: 'x' });
    assert.equal(lines.length, 4);
  });

  it('entering a quarantine, and each doubling of it, is news', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' });
    reporter.spaceFailure('S', 'ops', BOOM, { when: 'x', quarantineSec: 60 });
    reporter.spaceFailure('S', 'ops', BOOM, { when: 'x', quarantineSec: 60 });
    reporter.spaceFailure('S', 'ops', BOOM, { when: 'x', quarantineSec: 120 });
    assert.equal(lines.length, 3, 'unquarantined, 60 s, 120 s: and the repeat of 60 s is not');
  });

  it('a step that succeeded in between is reported again when it fails again', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'x' });
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'v', when: 'x' });
    reporter.recovered('S', 'ops');
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'u', when: 'x' });
    reporter.spaceFailure('S', 'ops', BOOM, { unit: 'v', when: 'x' });
    assert.equal(lines.length, 4, 'both units forgotten by one recovery of the step and space');
  });

  it('a recovery of one space does not forget another\'s', () => {
    const { lines, reporter } = harness();
    reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' });
    reporter.spaceFailure('S', 'other', BOOM, { when: 'x' });
    reporter.recovered('S', 'ops');
    reporter.spaceFailure('S', 'other', BOOM, { when: 'x' });
    assert.equal(lines.length, 2);
  });

  it('the store lines are once per window per step too', () => {
    const { lines, clock, reporter } = harness();
    reporter.storeDown('S', BOOM); reporter.storeDown('S', BOOM); reporter.storeStalled('S', 3); reporter.storeStalled('S', 3);
    assert.equal(lines.length, 2, 'one down line, one stalled line');
    clock.t += SPACE_FAILURE_WINDOW_MS;
    reporter.storeDown('S', BOOM);
    assert.equal(lines.length, 3);
  });

  it('remembers at most `max` conditions, and a forgotten one is said again (the safe direction)', () => {
    const { lines, reporter } = harness({ max: 3 });
    for (const id of ['a', 'b', 'c', 'd']) reporter.spaceFailure('S', id, BOOM, { when: 'x' });
    assert.ok(reporter.size <= 3, `holds ${reporter.size} conditions with max 3`);
    reporter.spaceFailure('S', 'a', BOOM, { when: 'x' });
    assert.equal(lines.length, 5, 'a was evicted and is news again');
  });

  it('the default bound and window are the constants the docs cite', () => {
    assert.equal(SPACE_FAILURE_MAX_KEYS, 20_000);
    assert.ok(Number.isInteger(SPACE_FAILURE_WINDOW_MS) && SPACE_FAILURE_WINDOW_MS >= 60_000, 'a window of minutes');
  });
});

describe('never throws', () => {
  it('not when the sink throws', () => {
    const { reporter } = harness({ warn: () => { throw new Error('the log is gone'); } });
    assert.doesNotThrow(() => reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' }));
    assert.doesNotThrow(() => reporter.storeDown('S', BOOM));
    assert.doesNotThrow(() => reporter.storeStalled('S', 3));
  });

  it('not when a listener of the counter signal throws', () => {
    const off = onHousekeepingSignal(() => { throw new Error('the registry is gone'); });
    try {
      const { lines, reporter } = harness();
      assert.doesNotThrow(() => reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' }));
      assert.equal(lines.length, 1, 'and the line was still said');
    } finally { off(); }
  });

  it('not for a value that cannot be rendered, or for an id that is not a string', () => {
    const { reporter } = harness();
    const hostile = { get message() { throw new Error('getter'); }, toString() { throw new Error('toString'); } };
    assert.doesNotThrow(() => reporter.spaceFailure('S', 'ops', hostile, { when: 'x' }));
    assert.doesNotThrow(() => reporter.spaceFailure('S', undefined, undefined, { when: 'x' }));
    assert.doesNotThrow(() => reporter.spaceFailure('S', 'ops', null, undefined));
  });

  it('the module\'s own reportSpaceFailure is synchronous and returns nothing a caller could await', () => {
    const out = reportSpaceFailure('Module default', 'ops-default-instance', BOOM, { when: 'next cycle' });
    assert.ok(!(out instanceof Promise), 'a Promise here would be a verdict nobody awaits');
  });
});

describe('a counter signal per kind, on every call, said or not', () => {
  it('failure, timeout, store_down, stalled; and a throttled line still counts', () => {
    const events = [];
    const off = onHousekeepingSignal((e) => { if (e.type === 'space-failure') events.push([e.step, e.kind]); });
    try {
      const { lines, reporter } = harness();
      reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' });
      reporter.spaceFailure('S', 'ops', BOOM, { when: 'x' });
      reporter.spaceFailure('S', 'ops', BOOM, { when: 'x', kind: 'space-timeout' });
      reporter.storeDown('S', BOOM);
      reporter.storeStalled('S', 3);
      assert.deepEqual(events, [['S', 'failure'], ['S', 'failure'], ['S', 'timeout'], ['S', 'store_down'], ['S', 'stalled']]);
      assert.ok(lines.length < events.length, 'the second failure was throttled and still counted');
    } finally { off(); }
  });
});

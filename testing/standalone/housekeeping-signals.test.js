/**
 * The one way a housekeeping module says "something countable happened" without importing the metrics registry (`Q-274`,
 * bundle-53 G8).
 *
 * ## Why a registry of listeners and not an import
 *
 * `metrics/registry.ts` imports `util/seq.ts` (a value import); `util/seq.ts` becomes an `intervalJob` client; an
 * `intervalJob` that imported the registry for its counter would close registry -> seq -> interval-job -> registry, which
 * `no-runtime-import-cycles` refuses. The precedent is `onRecordCollectionWrite` in `db/mongo.ts`: the lower layer exposes a
 * subscription, the higher layer subscribes. This module is that subscription, and it imports NOTHING.
 *
 * ## What it must never do
 *
 * **Throw into the code that signalled.** The signal is emitted from a `catch` and from a timer callback; a listener's
 * failure (the registry mid-reset, a test double) must not become the caller's.
 *
 * Run: node --test testing/standalone/housekeeping-signals.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  signalHousekeeping, onHousekeepingSignal, declareStep, declaredSteps,
} from '../../server/dist/util/housekeeping-signals.js';

describe('signals', () => {
  it('reach every listener, in order, and stop reaching one that unsubscribed', () => {
    const a = []; const b = [];
    const offA = onHousekeepingSignal((e) => a.push(e));
    const offB = onHousekeepingSignal((e) => b.push(e));
    signalHousekeeping({ type: 'tick-skipped', job: 'x' });
    offA();
    signalHousekeeping({ type: 'tick-skipped', job: 'y' });
    offB();
    signalHousekeeping({ type: 'tick-skipped', job: 'z' });
    assert.deepEqual(a.map(e => e.job), ['x']);
    assert.deepEqual(b.map(e => e.job), ['x', 'y']);
  });

  it('a listener that throws neither stops the others nor reaches the caller', () => {
    const seen = [];
    const off1 = onHousekeepingSignal(() => { throw new Error('listener 1'); });
    const off2 = onHousekeepingSignal((e) => seen.push(e.type));
    try {
      assert.doesNotThrow(() => signalHousekeeping({ type: 'quarantined-spaces', count: 2 }));
      assert.deepEqual(seen, ['quarantined-spaces']);
    } finally { off1(); off2(); }
  });

  it('a listener that unsubscribes itself while being called does not skip the next one', () => {
    const seen = [];
    let off1;
    off1 = onHousekeepingSignal(() => { seen.push('one'); off1(); });
    const off2 = onHousekeepingSignal(() => seen.push('two'));
    try {
      signalHousekeeping({ type: 'tick-skipped', job: 'x' });
      assert.deepEqual(seen, ['one', 'two']);
    } finally { off1(); off2(); }
  });
});

describe('declareStep: every step names itself once, at load, so its series can start at 0', () => {
  it('is remembered, once, in the order declared, and answered with the name for inline use', () => {
    const before = declaredSteps().length;
    assert.equal(declareStep('Signals test step A'), 'Signals test step A');
    declareStep('Signals test step B');
    declareStep('Signals test step A');
    const all = declaredSteps();
    assert.equal(all.length, before + 2, 'a repeat is not a second step');
    assert.deepEqual(all.slice(-2), ['Signals test step A', 'Signals test step B']);
  });

  it('tells a subscriber that is already listening, so a step declared late still gets its series', () => {
    const seen = [];
    const off = onHousekeepingSignal((e) => { if (e.type === 'step-declared') seen.push(e.step); });
    try {
      declareStep('Signals test step C');
      declareStep('Signals test step C');
      assert.deepEqual(seen, ['Signals test step C']);
    } finally { off(); }
  });

  it('refuses a name that is not a non-empty string: a series cannot be labelled with it', () => {
    for (const bad of ['', '   ', undefined, null, 7, {}]) assert.throws(() => declareStep(bad), /step/, String(bad));
  });

  it('what it hands out is a copy: a caller cannot edit the declared list', () => {
    const list = declaredSteps();
    list.push('forged');
    assert.ok(!declaredSteps().includes('forged'));
  });
});

describe('the module imports nothing', () => {
  it('has no import of its own: it is the bottom of the layer, so no cycle can pass through it', () => {
    const src = readFileSync(new URL('../../server/src/util/housekeeping-signals.ts', import.meta.url), 'utf8');
    const imports = src.split('\n').filter(l => /^\s*(import|export)\s.*\sfrom\s/.test(l) && !/^\s*import type/.test(l));
    assert.deepEqual(imports, [], 'a value import here is the cycle the module exists to avoid');
  });
});

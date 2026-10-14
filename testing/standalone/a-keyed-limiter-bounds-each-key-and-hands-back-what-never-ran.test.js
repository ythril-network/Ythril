/**
 * `keyedLimiter` (`util/keyed-limiter.ts`) bounds work that ARRIVES, per key: at most `concurrency` of one key running, a queue behind
 * them, a refusal at `bound`, and a `close` that hands back what never started (bundle-113, Q-469 — the webhook dispatcher's
 * first deliveries are its only caller).
 *
 * Pinned: a key at its slots queues; a key at its bound is refused and nothing is dropped silently; a held key does not hold another key;
 * a rejected run reaches `onError` and frees its slot, and so does a reporter that throws; an idle key leaves nothing behind (a refused
 * item after the queue drained is taken again); `close` returns the queued items oldest first and refuses from then on, leaving running
 * items alone; the options are refused when they cannot work.
 *
 * Run: node --test testing/standalone/a-keyed-limiter-bounds-each-key-and-hands-back-what-never-ran.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { keyedLimiter } = await import('../../server/dist/util/keyed-limiter.js');

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const tick = () => new Promise(r => setImmediate(r));

function rig({ concurrency = 2, bound = 4, hold = new Set(), fail = new Set(), throwingReporter = false } = {}) {
  const gates = new Map();
  const ran = [];
  const errors = [];
  const running = new Map();
  const limiter = keyedLimiter({
    concurrency, bound,
    run: async (key, item) => {
      ran.push(`${key}:${item}`);
      running.set(key, (running.get(key) ?? 0) + 1);
      try {
        if (hold.has(key)) { const g = gate(); gates.set(`${key}:${item}`, g); await g.p; }
        if (fail.has(item)) throw new Error(`boom ${item}`);
      } finally { running.set(key, running.get(key) - 1); }
    },
    onError: (key, err) => { errors.push(`${key}:${err.message}`); if (throwingReporter) throw new Error('reporter'); },
  });
  return { limiter, ran, errors, running, gates };
}

describe('keyedLimiter', () => {
  it('starts up to the concurrency, queues up to the bound, refuses past it', async () => {
    const r = rig({ hold: new Set(['a']) });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(i => r.limiter.submit('a', i)), ['started', 'started', 'queued', 'queued', 'refused', 'refused']);
    assert.equal(r.running.get('a'), 2);
    assert.deepEqual(r.ran, ['a:1', 'a:2']);
  });

  it('a held key does not hold another key', async () => {
    const r = rig({ hold: new Set(['a']) });
    for (let i = 0; i < 6; i++) r.limiter.submit('a', i);
    assert.equal(r.limiter.submit('b', 'x'), 'started');
    await tick();
    assert.ok(r.ran.includes('b:x'));
    assert.equal(r.running.get('b'), 0);
  });

  it('a freed slot starts the next queued item, in order', async () => {
    const r = rig({ hold: new Set(['a']) });
    for (const i of [1, 2, 3, 4]) r.limiter.submit('a', i);
    r.gates.get('a:1').release();
    await tick();
    assert.deepEqual(r.ran, ['a:1', 'a:2', 'a:3']);
    r.gates.get('a:2').release();
    await tick();
    assert.deepEqual(r.ran, ['a:1', 'a:2', 'a:3', 'a:4']);
  });

  it('a rejected run reaches onError and frees its slot, even when the reporter throws', async () => {
    const r = rig({ concurrency: 1, bound: 3, fail: new Set([1, 2]), throwingReporter: true });
    for (const i of [1, 2, 3]) r.limiter.submit('a', i);
    await tick();
    assert.deepEqual(r.errors, ['a:boom 1', 'a:boom 2']);
    assert.deepEqual(r.ran, ['a:1', 'a:2', 'a:3']);
    assert.equal(r.limiter.submit('a', 4), 'started', 'a failed item kept its slot');
  });

  it('an idle key is forgotten, so what was refused at the bound is taken once the key drains', async () => {
    const r = rig({ concurrency: 1, bound: 1 });
    assert.equal(r.limiter.submit('a', 1), 'started');
    assert.equal(r.limiter.submit('a', 2), 'refused');
    await tick();
    assert.equal(r.limiter.submit('a', 2), 'started');
  });

  it('close hands back the queued items, oldest first, refuses afterwards, and leaves the running ones alone', async () => {
    const r = rig({ hold: new Set(['a', 'b']) });
    for (const i of [1, 2, 3, 4]) r.limiter.submit('a', i);
    r.limiter.submit('b', 9);
    assert.deepEqual(r.limiter.close(), [3, 4]);
    assert.equal(r.limiter.closed, true);
    assert.equal(r.limiter.submit('b', 10), 'refused');
    assert.equal(r.running.get('a'), 2, 'close touched a running item');
    r.gates.get('a:1').release();
    await tick();
    assert.deepEqual(r.ran.filter(x => x.startsWith('a:')), ['a:1', 'a:2'], 'a queued item the limiter handed back also ran');
  });

  it('refuses options that cannot work', () => {
    const o = { run: async () => {}, onError: () => {} };
    assert.throws(() => keyedLimiter({ ...o, concurrency: 0, bound: 1 }), /concurrency/);
    assert.throws(() => keyedLimiter({ ...o, concurrency: 2, bound: 1 }), /bound/);
    assert.throws(() => keyedLimiter({ ...o, concurrency: 1.5, bound: 4 }), /concurrency/);
  });
});

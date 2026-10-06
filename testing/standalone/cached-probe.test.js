/**
 * "Is that thing up?", asked of a probe that is cached, never throws, and is not stampeded (`Q-274`, bundle-53 G8).
 *
 * ## Why it is a module
 *
 * `util/sidecar-health.ts` held the answer for the sidecars' `/health`; the walks' "does the store answer a ping" is the second
 * site. Two copies would each have to remember the three things a copy drops:
 *
 * - **the cache** — without it a caller that routes per document probes per document, and a store that has stopped answering is
 *   asked once per failed record, each ask costing the probe's whole timeout;
 * - **that it never throws** — an unreachable thing is `false`, which IS the answer, not an error, and a probe that threw out of
 *   the failure path of a walk would replace the failure it was asked about;
 * - **one probe in flight per key** — a hundred callers arriving while the first probe waits are one probe, not a hundred.
 *
 * Run: node --test testing/standalone/cached-probe.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeCache, cachedProbe, forgetCachedProbes } from '../../server/dist/util/cached-probe.js';

function harness() {
  const clock = { t: 0 };
  const cache = createProbeCache({ now: () => clock.t });
  const probe = (result) => { const p = { calls: 0, fn: async () => { p.calls++; if (result === 'throws') throw new Error('down'); return result; } }; return p; };
  return { clock, cache, probe };
}

describe('a cached probe', () => {
  it('answers the probe, and answers again from the cache until the TTL passes', async () => {
    const { clock, cache, probe } = harness();
    const p = probe(true);
    assert.equal(await cache.probe('k', 10_000, p.fn), true);
    clock.t = 9_999;
    assert.equal(await cache.probe('k', 10_000, p.fn), true);
    assert.equal(p.calls, 1, 'inside the TTL the probe is not repeated');
    clock.t = 10_000;
    await cache.probe('k', 10_000, p.fn);
    assert.equal(p.calls, 2, 'at the TTL it is');
  });

  it('a false answer is cached too: the store that does not answer is not asked again for every failed record', async () => {
    const { clock, cache, probe } = harness();
    const p = probe(false);
    for (let i = 0; i < 20; i++) assert.equal(await cache.probe('k', 10_000, p.fn), false);
    assert.equal(p.calls, 1);
    clock.t = 10_000;
    await cache.probe('k', 10_000, p.fn);
    assert.equal(p.calls, 2);
  });

  it('a probe that throws is false, never an exception, and is cached like any answer', async () => {
    const { cache, probe } = harness();
    const p = probe('throws');
    assert.equal(await cache.probe('k', 10_000, p.fn), false);
    assert.equal(await cache.probe('k', 10_000, p.fn), false);
    assert.equal(p.calls, 1, 'the throw is an answer and is remembered');
  });

  it('a probe that throws SYNCHRONOUSLY is false too', async () => {
    const { cache } = harness();
    assert.equal(await cache.probe('k', 1000, () => { throw new Error('sync'); }), false);
  });

  it('a probe that returns something other than true is false: only an explicit yes is a yes', async () => {
    const { cache } = harness();
    assert.equal(await cache.probe('a', 1000, async () => 'yes'), false);
    assert.equal(await cache.probe('b', 1000, async () => 1), false);
    assert.equal(await cache.probe('c', 1000, async () => undefined), false);
  });

  it('keys are independent', async () => {
    const { cache, probe } = harness();
    const up = probe(true); const down = probe(false);
    assert.equal(await cache.probe('up', 1000, up.fn), true);
    assert.equal(await cache.probe('down', 1000, down.fn), false);
    assert.equal(up.calls + down.calls, 2);
  });

  it('callers that arrive while the probe is in flight share it: one probe, one answer', async () => {
    const { cache } = harness();
    let release; let calls = 0;
    const fn = () => { calls++; return new Promise((r) => { release = r; }); };
    const all = Promise.all(Array.from({ length: 10 }, () => cache.probe('k', 1000, fn)));
    await new Promise((r) => setImmediate(r));
    release(true);
    assert.deepEqual(await all, Array(10).fill(true));
    assert.equal(calls, 1);
  });

  it('the TTL runs from the answer, not from the ask: a slow probe is not stale the moment it returns', async () => {
    const { clock, cache } = harness();
    let calls = 0;
    const slow = async () => { calls++; clock.t += 3_000; return true; };
    await cache.probe('k', 10_000, slow);
    clock.t += 9_000;
    await cache.probe('k', 10_000, slow);
    assert.equal(calls, 1, '9 s after it answered is inside the 10 s');
  });

  it('forget empties one prefix or everything, and the next ask probes', async () => {
    const { cache, probe } = harness();
    const a = probe(true); const b = probe(true);
    await cache.probe('sidecar:x', 10_000, a.fn);
    await cache.probe('store', 10_000, b.fn);
    cache.forget('sidecar:');
    await cache.probe('sidecar:x', 10_000, a.fn);
    await cache.probe('store', 10_000, b.fn);
    assert.deepEqual([a.calls, b.calls], [2, 1], 'only the prefix was forgotten');
    cache.forget();
    await cache.probe('store', 10_000, b.fn);
    assert.equal(b.calls, 2);
  });

  it('is bounded: a key space a caller influences cannot grow it for ever', async () => {
    const { cache } = harness();
    for (let i = 0; i < 5_000; i++) await cache.probe(`k${i}`, 1000, async () => true);
    assert.ok(cache.size <= 1_000, `holds ${cache.size} keys`);
  });

  it('the bound is a parameter: a cache sized for more keys holds them', async () => {
    const clock = { t: 0 };
    const cache = createProbeCache({ now: () => clock.t, maxKeys: 3 });
    for (let i = 0; i < 10; i++) await cache.probe(`k${i}`, 1000, async () => true);
    assert.equal(cache.size, 3);
  });
});

describe('a TTL per kind of answer', () => {
  const ttl = { yesMs: 10_000, noMs: 100, failedMs: 0 };

  it('a yes lives yesMs and a no lives noMs', async () => {
    const { clock, cache, probe } = harness();
    const yes = probe(true); const no = probe(false);
    await cache.probe('y', ttl, yes.fn); await cache.probe('n', ttl, no.fn);
    clock.t = 99;
    await cache.probe('y', ttl, yes.fn); await cache.probe('n', ttl, no.fn);
    assert.deepEqual([yes.calls, no.calls], [1, 1], 'both inside their TTL');
    clock.t = 100;
    await cache.probe('y', ttl, yes.fn); await cache.probe('n', ttl, no.fn);
    assert.deepEqual([yes.calls, no.calls], [1, 2], 'the no is asked again at noMs, the yes is not');
    clock.t = 10_000;
    await cache.probe('y', ttl, yes.fn);
    assert.equal(yes.calls, 2, 'the yes is asked again at yesMs');
  });

  it('a probe that FAILED is false and is not remembered when failedMs is 0', async () => {
    const { cache, probe } = harness();
    const p = probe('throws');
    assert.equal(await cache.probe('k', ttl, p.fn), false);
    assert.equal(await cache.probe('k', ttl, p.fn), false);
    assert.equal(p.calls, 2, 'the store that did not answer is asked again, not believed');
  });

  it('a failure defaults to the no TTL, so a bare object behaves like a number for it', async () => {
    const { cache, probe } = harness();
    const p = probe('throws');
    await cache.probe('k', { yesMs: 10_000, noMs: 5_000 }, p.fn);
    await cache.probe('k', { yesMs: 10_000, noMs: 5_000 }, p.fn);
    assert.equal(p.calls, 1);
  });

  it('callers that arrive while a failing probe is in flight still share it', async () => {
    const { cache } = harness();
    let calls = 0; let fail;
    const fn = () => { calls++; return new Promise((_, rej) => { fail = rej; }); };
    const all = Promise.all(Array.from({ length: 5 }, () => cache.probe('k', ttl, fn)));
    await new Promise((r) => setImmediate(r));
    fail(new Error('down'));
    assert.deepEqual(await all, Array(5).fill(false));
    assert.equal(calls, 1);
  });

  it('prime records an answer the caller already holds, with that answer\'s TTL', async () => {
    const { clock, cache, probe } = harness();
    const p = probe(false);
    cache.prime('k', true);
    assert.equal(await cache.probe('k', ttl, p.fn), true);
    assert.equal(p.calls, 0, 'a primed answer is not probed');
    clock.t = 10_000;
    assert.equal(await cache.probe('k', ttl, p.fn), false);
    assert.equal(p.calls, 1, 'and it expires like a probed one');
    cache.prime('k', false);
    clock.t = 10_099;
    assert.equal(await cache.probe('k', ttl, p.fn), false);
    assert.equal(p.calls, 1);
    cache.forget('k');
    await cache.probe('k', ttl, p.fn);
    assert.equal(p.calls, 2, 'a primed key is forgotten like any other');
  });
});

describe('the module-level cachedProbe', () => {
  it('is the same question on the real clock, and forgetCachedProbes clears it', async () => {
    let calls = 0;
    const fn = async () => { calls++; return true; };
    forgetCachedProbes('cached-probe-test:');
    assert.equal(await cachedProbe('cached-probe-test:a', 60_000, fn), true);
    assert.equal(await cachedProbe('cached-probe-test:a', 60_000, fn), true);
    assert.equal(calls, 1);
    forgetCachedProbes('cached-probe-test:');
    await cachedProbe('cached-probe-test:a', 60_000, fn);
    assert.equal(calls, 2);
  });
});

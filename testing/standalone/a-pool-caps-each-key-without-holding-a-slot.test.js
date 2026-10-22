/**
 * `mapLimitPerKey` is `mapLimit` with a second bound: at most `perKey` calls in flight for any one key, and an item whose key is full
 * NEVER holds one of the pool's slots while it waits (bundle-169, Q-483).
 *
 * ## What it is for
 *
 * The webhook retry poll delivers a tick's due retries four at a time (`mapLimit`). One subscription whose sink hangs holds all four slots for the
 * delivery timeout, and every other subscription's retry waits behind it. The cap per subscription (2 of 4) fixes that, and the shape of the
 * fix is the part that is easy to get wrong: a waiting item that HOLDS a slot is the same head-of-line block with a different name, and a pool
 * that lets a fire-and-forget limiter in front of it (`keyedLimiter`) returns before its work ends, so the next tick re-reads rows that are still
 * being delivered. This pool is awaited: it resolves when every item has finished, so the overlap skip and the remove-before-deliver rule hold.
 *
 * ## What is pinned
 *
 * - at most `perKey` in flight for a key, however many items share it, and at most `limit` overall;
 * - an item of a full key does not hold a slot: with the key's items held, the items of other keys still start, up to `limit`;
 * - the pick is O(1) per item (a pool that rescans the list for the next item whose key has room is quadratic on one key's backlog: counted
 *   in `keyOf` calls, so no clock is read);
 * - the result keeps the input order, `fn` gets `(item, index)`, a rejection from `fn` rejects the whole map (as `mapLimit`'s does), an empty
 *   list resolves empty;
 * - `perKey = limit` is `mapLimit`: the same start order and the same results under one release schedule; and `mapLimit`'s own behaviour is
 *   held here as well (green before the new export exists: it is what must not move).
 *
 * ## Red at base
 *
 * `mapLimitPerKey` is not exported at base, so every case of the first four describes fails with "mapLimitPerKey is not a function": red by the
 * missing export, not by the rule. Once the export exists the assertions that prove the rule are: `peak per key <= perKey` and `the others
 * started while the full key's items were held` (cap and no held slot), `keyOf calls <= 3n` (the pick), and `same start order as mapLimit`.
 * The `mapLimit is unchanged` describe is green at base and guards the 18 callers.
 *
 * No timer fires: each item waits on a gate the test opens, and "nothing more started" is read after `settle()`.
 *
 * Run: node --test testing/standalone/a-pool-caps-each-key-without-holding-a-slot.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './_virtual-time.mjs';

let mapLimit, mapLimitPerKey;

before(async () => {
  ({ mapLimit, mapLimitPerKey } = await import('../../server/dist/util/map-limit.js'));
});

const gate = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

/** A pool whose items wait on gates the test opens; `started` is the order the pool began them in, `peak` the most in flight per key. */
function held(items, keyOf) {
  const gates = new Map(items.map(it => [it, gate()]));
  const started = [];
  const inFlight = new Map();
  const peak = new Map();
  let total = 0; let peakTotal = 0;
  const fn = async (item, i) => {
    started.push(item);
    const k = keyOf(item);
    inFlight.set(k, (inFlight.get(k) ?? 0) + 1);
    peak.set(k, Math.max(peak.get(k) ?? 0, inFlight.get(k)));
    total++; peakTotal = Math.max(peakTotal, total);
    try { await gates.get(item).p; return `${item}:${i}`; } finally { inFlight.set(k, inFlight.get(k) - 1); total--; }
  };
  return {
    fn, started, gates, peak, peakTotal: () => peakTotal, inFlight: (k) => inFlight.get(k) ?? 0,
    open: (...which) => { for (const it of which) gates.get(it).release(); },
    openAll: () => { for (const g of gates.values()) g.release(); },
  };
}
const keyOf = (item) => item[0];

describe('mapLimitPerKey caps each key', () => {
  it('eight items of one key, limit 4, perKey 2: two start, never more than two at once, and every item is delivered in the end', async () => {
    const items = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
    const h = held(items, keyOf);
    const done = mapLimitPerKey(items, 4, keyOf, 2, h.fn);
    await settle();
    assert.deepEqual(h.started, ['a1', 'a2'], `a key with a cap of 2 had ${h.started.length} items started: ${h.started.join(' ')}`);
    h.open('a1');
    await settle();
    assert.equal(h.inFlight('a'), 2, 'a finished item was not replaced by the next of its key');
    h.openAll();
    const results = await done;
    assert.equal(h.peak.get('a'), 2, `the key had ${h.peak.get('a')} items in flight at once`);
    assert.deepEqual(results, items.map((it, i) => `${it}:${i}`), 'the results are not in the input order');
  });

  it('three keys, perKey 2, limit 4: no key ever has more than two in flight, and the pool never has more than four', async () => {
    const items = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'c1', 'c2', 'c3', 'c4'];
    const h = held(items, keyOf);
    const done = mapLimitPerKey(items, 4, keyOf, 2, h.fn);
    await settle();
    for (const it of items) { h.open(it); await settle(); }
    await done;
    for (const k of ['a', 'b', 'c']) assert.ok(h.peak.get(k) <= 2, `key ${k} had ${h.peak.get(k)} in flight at once`);
    assert.ok(h.peakTotal() <= 4, `${h.peakTotal()} items were in flight at once`);
    assert.equal(h.peakTotal(), 4, 'the pool did not use its four slots');
  });

  it('perKey 1 runs a key one at a time', async () => {
    const items = ['a1', 'a2', 'a3', 'b1'];
    const h = held(items, keyOf);
    const done = mapLimitPerKey(items, 4, keyOf, 1, h.fn);
    await settle();
    assert.deepEqual([...h.started].sort(), ['a1', 'b1'], `started: ${h.started.join(' ')}`);
    h.openAll();
    await done;
    assert.equal(h.peak.get('a'), 1);
  });
});

describe('an item whose key is full never holds a slot', () => {
  it('a1..a6 held (cap 2) and b1, c1, d1 behind them: b1 and c1 take the two other slots at once, d1 waits for a slot, not for a key', async () => {
    const items = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'c1', 'd1'];
    const h = held(items, keyOf);
    const done = mapLimitPerKey(items, 4, keyOf, 2, h.fn);
    await settle();
    assert.deepEqual([...h.started].sort(), ['a1', 'a2', 'b1', 'c1'],
      `with a's two held, the other two slots were not used by other keys: started ${h.started.join(' ')}`);
    h.open('b1');
    await settle();
    assert.ok(h.started.includes('d1'), 'a free slot was not taken by the next item of another key while a\'s third item waited');
    assert.equal(h.inFlight('a'), 2, 'a held key lost or gained a slot');
    h.openAll();
    await done;
    assert.equal(h.peak.get('a'), 2);
  });

  it('a slot freed by a held key\'s item is used at once: the pool is full again, and the key is still at its cap', async () => {
    const items = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'];
    const h = held(items, keyOf);
    const done = mapLimitPerKey(items, 4, keyOf, 2, h.fn);
    await settle();
    assert.deepEqual([...h.started].sort(), ['a1', 'a2', 'b1', 'b2'], 'c1 waits for a slot, a3 for its key');
    h.open('a1');
    await settle();
    assert.equal(h.started.length, 5, 'the slot a finished item freed was left empty while items waited');
    assert.ok(h.inFlight('a') <= 2, `a had ${h.inFlight('a')} in flight`);
    h.openAll();
    await done;
    assert.equal(h.started.length, 6);
  });
});

describe('mapLimitPerKey keeps mapLimit\'s pick and its reject-all semantics', () => {
  it('the pick is O(1): 6 000 items of ONE key at perKey 2 read keyOf a few times each, not once per item scanned', async () => {
    const n = 6000;
    const items = Array.from({ length: n }, (_, i) => `a${i}`);
    let calls = 0;
    const counted = (item) => { calls++; return item[0]; };
    const results = await mapLimitPerKey(items, 4, counted, 2, async (item, i) => { await Promise.resolve(); return i; });
    assert.equal(results.length, n);
    assert.ok(calls <= 3 * n, `keyOf was called ${calls} times for ${n} items: the pool rescans the list for every pick`);
  });

  it('a rejection from fn rejects the whole map with that error', async () => {
    const boom = new Error('delivery blew up');
    await assert.rejects(
      () => mapLimitPerKey(['a1', 'b1', 'a2', 'c1'], 4, keyOf, 2, async (item) => { if (item === 'a2') throw boom; await settle(); return item; }),
      (err) => err === boom,
    );
  });

  it('an empty list resolves to an empty list and fn is never called', async () => {
    let called = 0;
    assert.deepEqual(await mapLimitPerKey([], 4, keyOf, 2, async () => { called++; }), []);
    assert.equal(called, 0);
  });

  it('fn is given the item and its index in the input', async () => {
    const seen = [];
    await mapLimitPerKey(['a1', 'b1', 'a2'], 4, keyOf, 2, async (item, i) => { seen.push([item, i]); });
    assert.deepEqual(seen.sort(), [['a1', 0], ['a2', 2], ['b1', 1]]);
  });
});

describe('perKey = limit is mapLimit', () => {
  /** The same ten items, one release schedule (open them in reverse order, one per turn): what each pool started and returned. */
  async function run(pool) {
    const items = Array.from({ length: 10 }, (_, i) => `k${i % 3}-${i}`);
    const h = held(items, keyOf);
    const done = pool(items, h.fn);
    await settle();
    for (const it of [...items].reverse()) { h.open(it); await settle(); }
    return { started: h.started, results: await done, peak: h.peakTotal() };
  }
  it('the same start order, results and peak as mapLimit(items, 3, fn)', async () => {
    const a = await run((items, fn) => mapLimit(items, 3, fn));
    const b = await run((items, fn) => mapLimitPerKey(items, 3, keyOf, 3, fn));
    assert.deepEqual(b.started, a.started, 'perKey = limit did not start items in mapLimit\'s order');
    assert.deepEqual(b.results, a.results);
    assert.equal(b.peak, a.peak);
    assert.equal(a.peak, 3);
  });
});

/** Green at base: what `mapLimit`'s 18 callers rely on, so a pool shared with the new one cannot move it. */
describe('mapLimit is unchanged', () => {
  it('never more than `limit` in flight, results in input order, index passed', async () => {
    const items = Array.from({ length: 9 }, (_, i) => `x${i}`);
    const h = held(items, () => 'k');
    const done = mapLimit(items, 3, h.fn);
    await settle();
    assert.deepEqual(h.started, ['x0', 'x1', 'x2']);
    h.openAll();
    assert.deepEqual(await done, items.map((it, i) => `${it}:${i}`));
    assert.equal(h.peakTotal(), 3);
  });
  it('a limit above the list length, or below one, still runs every item', async () => {
    assert.deepEqual(await mapLimit([1, 2], 50, async (n) => n * 2), [2, 4]);
    assert.deepEqual(await mapLimit([1, 2, 3], 0, async (n) => n * 2), [2, 4, 6]);
    assert.deepEqual(await mapLimit([], 4, async (n) => n), []);
  });
  it('a rejection from fn rejects the whole map', async () => {
    const boom = new Error('x');
    await assert.rejects(() => mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw boom; return n; }), (e) => e === boom);
  });
});

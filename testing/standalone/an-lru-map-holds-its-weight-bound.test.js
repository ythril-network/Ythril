/**
 * An `LruMap` given a weight bound holds it, as it holds its count bound — on every insert, for every way an entry's
 * weight changes (`util/lru-map.ts`, Q-336).
 *
 * ## Why
 *
 * The Merkle leaf cache (`brain/merkle.ts`) was bounded by a COUNT of spaces, so its size was sixteen spaces of any
 * size: one space of millions of records is one entry. The weight is a parameter of the same question ("what does this
 * cache keep"), not a second cache, so the count bound and the weight bound are asked on the one insert.
 *
 * ## What is asserted
 *
 * - the least recently used entries go while the total weight is over the bound, not only while the count is;
 * - an entry that is set again is weighed again (the Merkle entry is mutated after it is stored, and stored again to
 *   say so), and a delete or a clear takes its weight off the total;
 * - an entry heavier than the whole bound is dropped by its own `set`, and says so through `onEvict`;
 * - a cache given no weight behaves as before, and a weight bound that is not a positive integer is refused.
 *
 * Run: node --test testing/standalone/an-lru-map-holds-its-weight-bound.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { LruMap } = await import('../../server/dist/util/lru-map.js');

const weighed = (max, maxWeight, onEvict) => new LruMap(max, onEvict, { weigh: (v) => v.weight, maxWeight });

describe('an LruMap holds its weight bound', () => {
  it('drops the least recently used entries while the total weight is over the bound', () => {
    const m = weighed(100, 10);
    m.set('a', { weight: 4 });
    m.set('b', { weight: 4 });
    m.get('a');
    m.set('c', { weight: 4 });
    assert.equal(m.peek('b'), undefined, 'the least recently used entry was kept past the weight bound');
    assert.ok(m.peek('a') && m.peek('c'), 'an entry that fits was dropped');
    assert.equal(m.totalWeight, 8);
  });

  it('weighs an entry again when it is set again, so a grown entry pushes others out', () => {
    const m = weighed(100, 10);
    const a = { weight: 2 };
    m.set('a', a);
    m.set('b', { weight: 5 });
    a.weight = 6;
    m.set('a', a);
    assert.equal(m.peek('b'), undefined, 'an entry grown after it was stored was never re-weighed');
    assert.equal(m.totalWeight, 6);
  });

  it('takes a deleted or cleared entry off the total', () => {
    const m = weighed(100, 10);
    m.set('a', { weight: 4 });
    m.set('b', { weight: 4 });
    m.delete('a');
    assert.equal(m.totalWeight, 4);
    m.set('c', { weight: 6 });
    assert.ok(m.peek('b') && m.peek('c'), 'a deleted entry\'s weight still counted against the bound');
    m.clear();
    assert.equal(m.totalWeight, 0);
  });

  it('drops an entry heavier than the whole bound on its own set, and says so', () => {
    const dropped = [];
    const m = weighed(100, 10, (k) => dropped.push(k));
    m.set('small', { weight: 3 });
    m.set('huge', { weight: 11 });
    assert.equal(m.peek('huge'), undefined, 'an entry over the whole budget was kept');
    assert.equal(m.totalWeight, 0, 'the small entry was dropped to make room for one that could never fit');
    assert.deepEqual(dropped, ['small', 'huge']);
  });

  it('still holds its count bound beside the weight', () => {
    const m = weighed(2, 1000);
    for (const k of ['a', 'b', 'c']) m.set(k, { weight: 1 });
    assert.equal(m.size, 2);
    assert.equal(m.totalWeight, 2);
  });

  it('an unweighted map has no weight and behaves as it did', () => {
    const m = new LruMap(2);
    m.set('a', { weight: 1e9 });
    assert.equal(m.totalWeight, 0);
    assert.equal(m.size, 1);
  });

  it('refuses a weight bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      assert.throws(() => new LruMap(1, undefined, { weigh: () => 1, maxWeight: bad }), /positive integer/);
    }
  });
});

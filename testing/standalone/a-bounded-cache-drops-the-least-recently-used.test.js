/**
 * A bounded cache drops the LEAST RECENTLY USED entry, on every insert — and every bounded cache in the server is
 * one (`util/lru-map.ts`).
 *
 * ## Why
 *
 * The same few lines — `delete` + `set` to move an entry to the end, `keys().next()` to drop the first — were written
 * five times (the tool validators, warn-once's reported keys, the Merkle leaves, the audit-total cache, the master-key
 * derivations), and the copies had already drifted: two of them dropped the oldest INSERTED entry, so the one key
 * read on every call was the one thrown away. The module holds the two halves a copy drops: the touch on use, and the
 * bound on every insert.
 *
 * Asserted as behaviour, then as a sweep: no file but the module spells the eviction by hand.
 *
 * Run: node --test testing/standalone/a-bounded-cache-drops-the-least-recently-used.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { LruMap } = await import('../../server/dist/util/lru-map.js');
const MODULE = 'server/src/util/lru-map.ts';

describe('a bounded cache drops the least recently used', () => {
  it('a read makes an entry the most recently used, so it outlives entries inserted after it', () => {
    const m = new LruMap(2);
    m.set('a', 1);
    m.set('b', 2);
    assert.equal(m.get('a'), 1);
    m.set('c', 3);
    assert.equal(m.peek('a'), 1, 'the entry just read was dropped — the cache evicts the oldest INSERTED, not the least recently used');
    assert.equal(m.peek('b'), undefined, 'the least recently used entry was kept past the bound');
    assert.equal(m.size, 2);
  });

  it('peek does not touch, and replacing a value still holds the bound', () => {
    const m = new LruMap(2);
    m.set('a', 1);
    m.set('b', 2);
    assert.equal(m.peek('a'), 1);
    m.set('c', 3);
    assert.equal(m.peek('a'), undefined, 'peek moved the entry, so a caller that only looks changes what is kept');
    m.set('c', 4);
    m.set('d', 5);
    assert.equal(m.size, 2, 'an insert past the bound kept more than max entries');
  });

  it('says what it dropped, for a caller that counts the bound\'s cost', () => {
    const dropped = [];
    const m = new LruMap(1, (k, v) => dropped.push([k, v]));
    m.set('a', 1);
    m.set('b', 2);
    assert.deepEqual(dropped, [['a', 1]]);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => new LruMap(bad), /positive integer/);
  });

  it('no source but the module drops a Map\'s first key by hand', () => {
    const sources = readTrackedSources('server/src', { untracked: true, floor: 300 });
    const byHand = sources
      .filter(({ file }) => file !== MODULE)
      .filter(({ text }) => /\.keys\(\)\.next\(\)/.test(stripComments(text)))
      .map(({ file }) => file);
    assert.deepEqual(byHand, [],
      'a bounded cache spelled by hand — move it onto util/lru-map.ts, whose touch-on-use and bound-on-insert a copy drops');
  });
});

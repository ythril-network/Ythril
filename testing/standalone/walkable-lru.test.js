/**
 * A bounded cache whose keys can be walked keeps its key list in step with its entries, and a walk never changes what is recent (bundle-378,
 * Q-976, fix round A: L1.3).
 *
 * ## The rule
 *
 * `WalkableLru` is the one spelling of "a bounded cache that can forget by a rule" (`util/walkable-lru.ts`): the probe cache's prefix forget,
 * the query vector cache's expiry and the planning counts' space forget all walk it. What each caller relies on:
 *
 *  1. an entry the bound drops leaves the key list, so a later walk never meets a key with no entry, and `forgetWhere` counts what it drops;
 *  2. an entry replaced by `set` is one key, not two;
 *  3. `forgetWhere` reads without touching: the order of the entries it keeps is the order they were in, so the next eviction still takes the
 *     least recently used.
 *
 * ## Seen red
 *
 * New module: on f91569511 there is no `server/dist/util/walkable-lru.js`, so each case fails at the import.
 *
 * Run: npm run build:server, then node --test testing/standalone/walkable-lru.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../../server/dist/util/walkable-lru.js';

describe('a walkable bounded cache', () => {
  it('the bound drops an entry from the key list too, and a replaced entry is one key', async () => {
    const { WalkableLru } = await import(MODULE);
    const cache = new WalkableLru(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('b', 22);
    assert.deepEqual(cache.heldKeys().sort(), ['a', 'b'], 'a replaced entry was listed twice or dropped');
    cache.set('c', 3);
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.heldKeys().sort(), ['b', 'c'], 'the entry the bound dropped is still listed, or the wrong one went');
    assert.equal(cache.forgetWhere(() => true), 2, 'a walk counted a key that had no entry');
    assert.deepEqual(cache.heldKeys(), []);
  });

  it('a walk drops what the rule names, counts it, and leaves the order of the rest', async () => {
    const { WalkableLru } = await import(MODULE);
    const cache = new WalkableLru(3);
    cache.set('x:1', 1);
    cache.set('y:1', 2);
    cache.set('x:2', 3);
    assert.equal(cache.forgetWhere(key => key.startsWith('x:')), 2);
    assert.deepEqual(cache.heldKeys(), ['y:1']);
    assert.equal(cache.get('x:1'), undefined, 'a forgotten entry was still answered');
    // The walk looked at `y:1` and did not touch it: of two kept entries the older one is still the next to go.
    cache.set('p', 4);
    cache.forgetWhere(() => false);
    cache.set('q', 5);
    cache.set('r', 6);
    assert.equal(cache.get('y:1'), undefined, 'the walk made the oldest entry recent, so a newer one went first');
    assert.equal(cache.get('r'), 6);
  });
});

/**
 * "Has this been reported already?" is answered in one module, and what it remembers is bounded (Q-361 item 7: the pull
 * names a kept-local divergence once per window, per id — and an id is a peer's text).
 *
 * ## What is asserted
 *
 * - `warnOnce` runs the report for a key it has not seen, and not again — until its version changes (a condition that
 *   changed is news) or, given a window, until the window has passed.
 * - **It forgets.** Past `max` keys the least recently REPORTED one is dropped, so a peer that sends a stream of distinct
 *   ids cannot grow the map without limit; a forgotten key that comes back is reported again, the safe direction for a
 *   warning. `forget` re-arms one key.
 * - `LruMap` — what it keeps — drops the least recently USED entry, touches on `get` and not on `peek`, and refuses a bound
 *   that is not a positive integer.
 *
 * Seen red by hand, each restored by hand: `seen.peek` changed to `seen.get` in `warnOnce` (the least-recently-REPORTED
 * case fails: "a sighting that reported nothing kept its key alive past the bound"); the re-insert in `LruMap.get`
 * removed (the LruMap case fails: "the entry read last was thrown away instead of the one never read"); and, recorded
 * when the bound case was written, the eviction loop of `LruMap.set` removed (the map grows to the number of keys sent).
 *
 * Run: node --test testing/standalone/a-warning-said-once-forgets-its-oldest-key.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let warnOnce, LruMap;
before(async () => {
  ({ warnOnce } = await import('../../server/dist/util/warn-once.js'));
  ({ LruMap } = await import('../../server/dist/util/lru-map.js'));
});

describe('warnOnce reports a key once and forgets its oldest', () => {
  it('runs the report once per key, again for a new version, and not for the same one', () => {
    const once = warnOnce();
    const said = [];
    assert.equal(once('a', () => said.push('a1')), true);
    assert.equal(once('a', () => said.push('a2')), false, 'the same key was reported twice');
    assert.equal(once('a', () => said.push('a3'), 'v2'), true, 'a changed version is news');
    assert.equal(once('a', () => said.push('a4'), 'v2'), false);
    assert.deepEqual(said, ['a1', 'a3']);
  });

  it('with a window, a key is reported again once the window has passed', () => {
    let t = 0;
    const once = warnOnce({ every: 1_000, now: () => t });
    const said = [];
    once('id', () => said.push(t));
    t = 999; once('id', () => said.push(t));
    t = 1_000; once('id', () => said.push(t));
    assert.deepEqual(said, [0, 1_000]);
  });

  it('is bounded: past max keys the least recently reported is forgotten, and reported again if it returns', () => {
    const once = warnOnce({ max: 3 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) once(k, () => {});
    assert.equal(once.size, 3, `the map holds ${once.size} keys past its bound of 3`);
    assert.equal(once('e', () => {}), false, 'the newest key was forgotten');
    assert.equal(once('a', () => {}), true, 'a forgotten key that came back was not reported again');
  });

  it('a key seen again but not reported stays the oldest: the forgotten one is the least recently REPORTED', () => {
    const once = warnOnce({ max: 3 });
    for (const k of ['a', 'b', 'c']) once(k, () => {});
    // `a` is met again and suppressed. Were a sighting a use, `a` would now be the newest and `b` the oldest.
    assert.equal(once('a', () => {}), false, 'a repeated key was reported again');
    once('d', () => {});
    assert.equal(once('c', () => {}), false, 'a key reported after the oldest was forgotten');
    assert.equal(once('d', () => {}), false, 'the newest key was forgotten');
    assert.equal(once('a', () => {}), true, 'a sighting that reported nothing kept its key alive past the bound');
  });

  it('forget re-arms one key', () => {
    const once = warnOnce();
    once('k', () => {});
    once.forget('k');
    assert.equal(once('k', () => {}), true);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const max of [0, -1, 1.5, NaN]) assert.throws(() => warnOnce({ max }), /max must be a positive integer/);
  });
});

describe('LruMap drops the least recently USED entry', () => {
  it('get touches, peek does not, and the bound holds on every set', () => {
    const evicted = [];
    const m = new LruMap(2, (k) => evicted.push(k));
    m.set('a', 1); m.set('b', 2);
    m.get('a');
    m.set('c', 3);
    assert.deepEqual(evicted, ['b'], 'the entry read last was thrown away instead of the one never read');
    m.peek('a');
    m.set('d', 4);
    assert.deepEqual(evicted, ['b', 'a'], 'peek counted as a use');
    m.set('d', 5);
    assert.equal(m.size, 2);
    assert.throws(() => new LruMap(0), /max must be a positive integer/);
  });
});

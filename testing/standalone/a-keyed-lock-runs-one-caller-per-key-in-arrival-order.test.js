/**
 * `keyedLock` (`server/src/util/keyed-lock.ts`) does what its docblock promises: one caller per key at a time, in the order
 * they asked; different keys never wait on each other; a callback that throws releases its key and poisons nobody behind it; a
 * key whose last holder has gone leaves the lock's map.
 *
 * ## Why it is pinned by behaviour
 *
 * Three callers wait on this module for their correctness (a path's writers, a collection's index reconciles, a tombstone's
 * publish), and `no-hand-written-promise-chain-is-a-lock` holds that nobody writes the chain again — which is only as good as the
 * module they are sent to. What the module puts inside, so no caller can drop it, is the release in a `finally` and the tidy-up;
 * those are the two a rewrite would lose without any caller's test noticing, until a failed writer failed every writer behind it.
 *
 * This is a characterization test: it holds what the module already does, and is green on it.
 *
 * ## How the tidy-up is seen
 *
 * The module exposes `idle(key)`, which returns the key's chain tail while the key is held and a fresh resolved promise when it is
 * not. Two calls that return the SAME promise therefore mean the key is still in the map; two different promises mean it is gone.
 *
 * Run: node --test testing/standalone/a-keyed-lock-runs-one-caller-per-key-in-arrival-order.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyedLock } from '../../server/dist/util/keyed-lock.js';

/** A promise settled from outside, so a test decides when a callback ends. */
function gate() {
  let open;
  const opened = new Promise(r => { open = r; });
  return { opened, open };
}

/** Let every already-queued microtask run, so "has not started" is read after it had every chance to. */
const settle = () => new Promise(r => setImmediate(r));

const isHeld = (lock, key) => lock.idle(key) === lock.idle(key);

describe('keyedLock', () => {
  it('callers of one key run one at a time, in the order they asked', async () => {
    const lock = keyedLock();
    const log = [];
    let running = 0;
    let most = 0;
    const gates = [gate(), gate(), gate()];
    const calls = gates.map((g, i) => lock.run('k', async () => {
      running++;
      most = Math.max(most, running);
      log.push(`start ${i}`);
      await g.opened;
      log.push(`end ${i}`);
      running--;
      return i;
    }));
    await settle();
    assert.deepEqual(log, ['start 0'], 'the second and third wait while the first holds the key');
    gates[0].open();
    await settle();
    assert.deepEqual(log, ['start 0', 'end 0', 'start 1']);
    gates[2].open();   // released out of order: the third must still wait for the second
    gates[1].open();
    assert.deepEqual(await Promise.all(calls), [0, 1, 2], 'each caller gets its own callback\'s result');
    assert.deepEqual(log, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    assert.equal(most, 1, 'never two at once for one key');
  });

  it('a caller that waits runs after the one before it, with what that one left behind', async () => {
    const lock = keyedLock();
    let value = 0;
    const read = async () => { const seen = value; await settle(); value = seen + 1; return seen; };
    const seen = await Promise.all([lock.run('k', read), lock.run('k', read), lock.run('k', read)]);
    assert.deepEqual(seen, [0, 1, 2], 'a read-decide-write over one key loses no update');
    assert.equal(value, 3);
  });

  it('different keys do not wait on each other', async () => {
    const lock = keyedLock();
    const a = gate();
    const log = [];
    const slow = lock.run('a', async () => { log.push('a start'); await a.opened; log.push('a end'); });
    const fast = lock.run('b', async () => { log.push('b'); return 'b done'; });
    assert.equal(await fast, 'b done', 'key b ran while key a was held');
    assert.deepEqual(log, ['a start', 'b']);
    a.open();
    await slow;
    assert.deepEqual(log, ['a start', 'b', 'a end']);
  });

  it('a callback that throws releases its key, and the next caller runs and is not poisoned by it', async () => {
    const lock = keyedLock();
    const boom = new Error('writer failed');
    const first = lock.run('k', async () => { throw boom; });
    const second = lock.run('k', async () => 'second ran');
    const third = lock.run('k', async () => { throw new Error('third failed'); });
    const fourth = lock.run('k', async () => 'fourth ran');
    const settled = await Promise.allSettled([first, second, third, fourth]);
    assert.equal(settled[0].status, 'rejected');
    assert.equal(settled[0].reason, boom, 'the failure is the caller\'s to see');
    assert.deepEqual(settled[1], { status: 'fulfilled', value: 'second ran' }, 'a failure ahead of it does not fail the caller after it');
    assert.equal(settled[2].status, 'rejected');
    assert.match(settled[2].reason.message, /third failed/);
    assert.deepEqual(settled[3], { status: 'fulfilled', value: 'fourth ran' });
    assert.equal(await lock.run('k', async () => 'after'), 'after', 'the key is usable after a failure');
  });

  it('a callback that throws SYNCHRONOUSLY is a failure of its caller alone', async () => {
    const lock = keyedLock();
    const first = lock.run('k', () => { throw new Error('sync boom'); });
    const second = lock.run('k', async () => 'ok');
    const [a, b] = await Promise.allSettled([first, second]);
    assert.equal(a.status, 'rejected');
    assert.match(a.reason.message, /sync boom/);
    assert.deepEqual(b, { status: 'fulfilled', value: 'ok' });
  });

  it('the key leaves the map when its last holder ends — and not before', async () => {
    const lock = keyedLock();
    assert.equal(isHeld(lock, 'k'), false, 'a key nobody asked for is not held');
    const g1 = gate();
    const g2 = gate();
    const one = lock.run('k', () => g1.opened);
    const two = lock.run('k', () => g2.opened);
    await settle();
    assert.equal(isHeld(lock, 'k'), true);
    g1.open();
    await one;
    assert.equal(isHeld(lock, 'k'), true, 'a waiter is still behind it, so the key stays');
    g2.open();
    await two;
    assert.equal(isHeld(lock, 'k'), false, 'the last holder gone, the key is gone: a key space a peer influences does not grow');
  });

  it('a key whose holder failed leaves the map too', async () => {
    const lock = keyedLock();
    await assert.rejects(lock.run('k', async () => { throw new Error('x'); }), /x/);
    assert.equal(isHeld(lock, 'k'), false);
  });

  it('idle resolves at once for a key nobody holds, and when every run asked so far has finished for one that is held', async () => {
    const lock = keyedLock();
    await lock.idle('never');
    const g = gate();
    let ended = false;
    const run = lock.run('k', async () => { await g.opened; ended = true; });
    let idled = false;
    const idle = lock.idle('k').then(() => { idled = true; });
    await settle();
    assert.equal(idled, false, 'idle waits for the running callback');
    g.open();
    await idle;
    assert.equal(ended, true);
    await run;
  });

  it('two locks do not share keys', async () => {
    const one = keyedLock();
    const two = keyedLock();
    const g = gate();
    const held = one.run('k', () => g.opened);
    assert.equal(await two.run('k', async () => 'ran'), 'ran', 'the same key on another lock is a different key');
    g.open();
    await held;
  });
});

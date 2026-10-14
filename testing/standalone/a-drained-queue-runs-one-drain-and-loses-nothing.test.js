/**
 * A queue that one drain at a time empties (`drainedQueue`, `util/drained-queue.ts`) — the single-flight drain the webhook dispatcher's
 * emitted events and overflow rows both use (bundle-113).
 *
 * ## What it holds
 *
 *  - **One drain at a time, in arrival order**, one item per call with `batchSize: 1` and everything queued per call by default.
 *  - **An item pushed while the last batch runs is handled** by the same drain, and one pushed after it ended starts a new one: nothing
 *    waits for a push that never comes.
 *  - **A throw in the handler goes to `onError` and the drain goes on**: the items behind it are still handled, and no rejection escapes.
 *  - **`settled()` resolves when everything queued, including what was pushed meanwhile, has been handled** — the thing a shutdown awaits.
 *  - **The dispatcher uses it for both queues** and keeps no `Promise | null` drain flag of its own.
 *
 * Mutations seen red (restored by hand): clear the drain flag before the loop's last check; let a handler failure escape the loop.
 *
 * Run: node --test testing/standalone/a-drained-queue-runs-one-drain-and-loses-nothing.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { drainedQueue } = await import('../../server/dist/util/drained-queue.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('drainedQueue', () => {
  it('handles items one per call, in arrival order, and never two drains at once', async () => {
    const seen = [];
    let running = 0;
    let maxRunning = 0;
    const q = drainedQueue(async ([item]) => {
      running++; maxRunning = Math.max(maxRunning, running);
      await tick();
      seen.push(item);
      running--;
    }, { batchSize: 1, onError: () => assert.fail('no failure was expected') });
    for (const n of [1, 2, 3]) q.push(n);
    await q.settled();
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(maxRunning, 1);
    assert.equal(q.size, 0);
  });

  it('takes everything queued per call by default, after the tick the caller yields', async () => {
    const batches = [];
    const q = drainedQueue(async (batch) => { batches.push(batch); }, { beforeFirstBatch: tick, onError: () => assert.fail('no failure') });
    q.push('a'); q.push('b');
    await tick();
    q.push('c');
    await q.settled();
    assert.deepEqual(batches.flat(), ['a', 'b', 'c']);
    assert.ok(batches.length <= 2, `a burst was written as ${batches.length} batches`);
  });

  it('an item pushed while the last batch runs is handled by the same drain, and one pushed after it ended starts a new one', async () => {
    const seen = [];
    let q;
    q = drainedQueue(async ([item]) => {
      seen.push(item);
      if (item === 1) { await tick(); q.push(2); }
    }, { batchSize: 1, onError: () => assert.fail('no failure') });
    q.push(1);
    await q.settled();
    assert.deepEqual(seen, [1, 2], 'an item pushed during the last batch was left waiting');
    q.push(3);
    await q.settled();
    assert.deepEqual(seen, [1, 2, 3], 'an item pushed after the drain ended was never handled');
  });

  it('a throw is reported and the items behind it are still handled; settled() does not reject', async () => {
    const seen = []; const failures = [];
    const q = drainedQueue(async ([item]) => { if (item === 2) throw new Error('boom'); seen.push(item); },
      { batchSize: 1, onError: err => failures.push(err.message) });
    for (const n of [1, 2, 3]) q.push(n);
    await q.settled();
    assert.deepEqual(seen, [1, 3]);
    assert.deepEqual(failures, ['boom']);
  });

  it('settled() on an idle queue resolves at once', async () => {
    const q = drainedQueue(async () => {}, { onError: () => {} });
    await q.settled();
  });
});

describe('the dispatcher\'s two queues', () => {
  const source = stripComments(readFileSync(new URL('../../server/src/webhooks/dispatcher.ts', import.meta.url), 'utf8'));
  it('are both drainedQueues, and the dispatcher keeps no drain flag of its own', () => {
    assert.equal((source.match(/drainedQueue</g) ?? []).length, 2, 'the emitted events and the overflow rows are each a drainedQueue');
    assert.doesNotMatch(source, /Promise<void> \| null\s*=\s*null/, 'a hand-written single-flight drain flag is back in the dispatcher');
    assert.doesNotMatch(source, /\?\?=\s*(?:drain|flush)\w*\(/, 'a hand-written `drain ??= run()` is back in the dispatcher');
  });
});

/**
 * The quiescence helper (`_quiescence.mjs`, design v5 section 6.1 X19, TS-6): it waits for all three queues, it holds idle for several turns, it
 * throws rather than returning when the instance never goes idle, and it never reads a queue it could not find as idle.
 *
 * ## Why the helper has a test of its own
 *
 * Every absence row of PR A (R-D40a, R-W19, R6-a, R6-c, R-W2c, R-X10a, R-X17b) is only as strong as the wait before it. A wait that returns early,
 * or that reads "no such export" as "nothing pending", makes each of those rows pass about a moment the work had not reached, and nothing else
 * would ever say so. The rows carry a positive twin each; THIS file is the twin of the wait: the same fake queues, one run where the work is
 * still coming (the absence reads true too early, and the wait is what stops it) and one where it is over.
 *
 * ## Written before the code (red on the base commit, 84f0b3cc)
 *
 * The pure half passes on the base (the helper is a test module). The last test asks the helper for the real server's queues and fails on the base
 * because `networks/notify-members.ts` and `syncCyclesInFlight` of `sync/engine.ts` do not exist yet: a missing queue must FAIL, naming its export.
 *
 * Run: node --test testing/standalone/a-quiescence-waits-for-every-queue-and-never-reads-a-missing-one-as-idle.test.js  (needs a prior server build only for the last test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { untilQuiescentOf, busyQueues, serverQueues, backgroundJobsInSource, COVERED_BY_QUEUES, UNAWAITED_BACKGROUND, QUEUE_NAMES } from './_quiescence.mjs';

/** A queue that holds `n` items and loses one per turn it is read after `start()` — the work that keeps sending after the call returned. */
function drainingQueue(n) {
  let left = n;
  return { read: () => (left > 0 ? left-- : 0), left: () => left };
}

describe('quiescence waits for every queue, then holds', () => {
  it('names the busy queues, and none when all answer zero', () => {
    assert.deepEqual(busyQueues({ notify: () => 0, cycles: () => 2, runner: () => 1 }), ['cycles', 'runner']);
    assert.deepEqual(busyQueues({ notify: () => 0, cycles: () => 0, runner: () => 0 }), []);
  });

  it('positive twin: with work still coming, an absence read BEFORE the wait is wrong, and the wait is what makes it right', async () => {
    const sent = [];
    let turns = 0;
    // A notify that is queued now and sent on turn 6: the request an absence assertion would have called "never sent".
    const queues = { notify: () => (turns < 6 ? 1 : 0), cycles: () => 0, runner: () => 0 };
    const stepper = (async () => { for (; turns < 6; turns++) await new Promise(r => setImmediate(r)); sent.push('notice'); })();
    assert.deepEqual(sent, [], 'before the wait, nothing has been sent yet (an absence assertion here would pass for the wrong reason)');
    await untilQuiescentOf(queues);
    assert.deepEqual(sent, ['notice'], 'after the wait the send has happened, so an absence assertion would be reading a finished world');
    await stepper;
  });

  it('holds idle: a queue that refills for one turn after its first idle reading is waited for', async () => {
    const reads = [1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    let i = 0;
    let stableAt = -1;
    await untilQuiescentOf({ notify: () => (i < reads.length ? reads[i++] : 0) }, { stable: 4 }).then(() => { stableAt = i; });
    assert.ok(stableAt >= 7, `it returned after ${stableAt} reading(s): the first idle reading was the gap between two stages`);
  });

  it('every queue counts: one idle queue does not stand for the others', async () => {
    const busy = drainingQueue(30);
    let ended = false;
    const waiting = untilQuiescentOf({ notify: () => 0, cycles: busy.read, runner: () => 0 }).then(() => { ended = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(ended, false, 'it returned while the sync-cycle queue was still busy');
    await waiting;
    assert.equal(busy.left(), 0, 'it returned before the busy queue drained');
  });

  it('throws, naming the queue, when the instance never goes idle — it does not return', async () => {
    await assert.rejects(untilQuiescentOf({ notify: () => 0, runner: () => 1 }, { maxTurns: 30 }), /never went quiescent[\s\S]*runner/);
  });
});

describe('every repeating background job is awaited by a queue or exempt with a reason (derived, never listed)', () => {
  const found = backgroundJobsInSource();

  it('derives the jobs (the floor): the interval jobs and the cron schedulers, not zero of either', () => {
    assert.ok(found.filter(k => !k.endsWith(':: cron')).length >= 10, `only ${found.filter(k => !k.endsWith(':: cron')).length} intervalJob site(s) derived: re-anchor the derivation`);
    assert.ok(found.filter(k => k.endsWith(':: cron')).length >= 3, 'fewer than 3 cron-scheduled files derived: re-anchor the derivation');
    assert.equal(new Set(found).size, found.length, 'two background jobs derive the same key: name them apart');
  });

  it('each one is read through the queues quiescent() waits for, or exempt with a reason — never both, never neither', () => {
    const covered = new Set(Object.keys(COVERED_BY_QUEUES));
    const exempt = new Set(Object.keys(UNAWAITED_BACKGROUND));
    const neither = found.filter(k => !covered.has(k) && !exempt.has(k));
    assert.deepEqual(neither, [],
      'a background job a test window can overlap that no queue waits for: an absence row would pass before its send. Add the queue it drains to quiescent() (_quiescence.mjs), or an exemption row with the reason it writes and sends nothing a test reads');
    assert.deepEqual(found.filter(k => covered.has(k) && exempt.has(k)), [], 'a job is both covered by a queue and exempt');
  });

  it('every covered row names real queues and every exemption has a reason', () => {
    for (const [key, queues] of Object.entries(COVERED_BY_QUEUES)) {
      assert.ok(queues.length >= 1 && queues.every(q => QUEUE_NAMES.includes(q)), `${key} is covered by [${queues.join(', ')}], which are not among the queues quiescent() reads (${QUEUE_NAMES.join(', ')})`);
    }
    for (const [key, why] of Object.entries(UNAWAITED_BACKGROUND)) assert.ok(why.trim().length >= 20, `the exemption of ${key} has no reason`);
  });

  it('no row is stale: every covered and exempt key still names a derived job', () => {
    const live = new Set(found);
    assert.deepEqual([...Object.keys(COVERED_BY_QUEUES), ...Object.keys(UNAWAITED_BACKGROUND)].filter(k => !live.has(k)), [],
      'these rows excuse or cover a job that is gone (or was renamed): delete or re-key them');
  });
});

describe('the server\'s own queues: a missing one fails the wait and is never read as idle', () => {
  it('the three queues exist on the server (notify-members, the sync engine, the runner)', async () => {
    const loader = { getConfig: () => ({ pendingSpaceActs: [] }) };
    const queues = await serverQueues(loader);
    assert.deepEqual(Object.keys(queues).sort(), [...QUEUE_NAMES].sort());
    for (const [name, read] of Object.entries(queues)) assert.equal(typeof read(), 'number', `the ${name} queue did not answer a count`);
  });
});

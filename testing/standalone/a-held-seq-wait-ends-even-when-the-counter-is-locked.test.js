/**
 * `heldSeqAllocated` (`_seq-hold-cases.mjs`) always ends: its failure message reads the space's counter, and that read waits for
 * every counter write already started — which never settles while a counter-row lock holds one (round W, V10).
 *
 * ## What it prevents
 *
 * The fixture's docblock keeps a counter-row lock out of its scope ("those cases keep reading the floor"), but nothing in the
 * code did. A case that waited on a stalled counter write anyway got a wait that ended at its own deadline — `waitFor` cuts
 * each probe off there — and then a DIAGNOSIS that awaited the same read with no bound, so the test ended only at the test
 * runner's own timeout, with a message about the runner and none about the wait. The diagnosis is bounded now and says what
 * it could not read, so a mistaken use is a failure naming the wait.
 *
 * Pure: the door is a stand-in with a `counter` that answers, or never does; no database is opened.
 *
 * Run: node --test testing/standalone/a-held-seq-wait-ends-even-when-the-counter-is-locked.test.js   (requires a prior build of server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heldSeqAllocated, SEEDED_COUNTER } from './_seq-hold-cases.mjs';

/** What `heldSeqAllocated` settles with, or the string `HUNG` when it had not settled after `limitMs`. */
async function outcomeWithin(door, limitMs, opts) {
  let timer;
  const hung = new Promise(resolve => { timer = setTimeout(() => resolve('HUNG'), limitMs); });
  try {
    return await Promise.race([heldSeqAllocated(door, 'a-space-with-no-hold', opts).then(seq => ({ seq }), error => ({ error })), hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe('heldSeqAllocated never hangs', () => {
  it('a counter write that never settles (a counter-row lock) ends the wait with its own error, not the runner\'s timeout', async () => {
    const door = { counter: () => new Promise(() => {}) };
    const outcome = await outcomeWithin(door, 10_000, { ms: 50 });
    assert.notEqual(outcome, 'HUNG', 'the wait was still running 10 s after its own 50 ms deadline: its diagnosis awaits a counter read that never settles');
    assert.ok(outcome.error, 'it resolved although no hold exists');
    assert.match(outcome.error.message, /timed out after 50ms/);
    assert.match(outcome.error.message, /diagnosis did not answer/i, 'the message does not say the diagnosis could not be read');
  });

  it('with a counter that answers, the message reads it as it did', async () => {
    const door = { counter: async () => SEEDED_COUNTER };
    const outcome = await outcomeWithin(door, 10_000, { ms: 50 });
    assert.notEqual(outcome, 'HUNG');
    assert.match(outcome.error.message, new RegExp(`counter ${SEEDED_COUNTER} \\(seeded at ${SEEDED_COUNTER}\\)`));
  });
});

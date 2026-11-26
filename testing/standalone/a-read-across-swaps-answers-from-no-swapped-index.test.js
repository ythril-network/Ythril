/**
 * A read across swaps of triple indexes never answers from a member read from an index that was swapped while it ran (bundle-273, Q-764,
 * review finding F4; design-r2 R5; contract row 2).
 *
 * ## The rule
 *
 * `readAcrossSwaps` runs a read over a quad source; when a member the source read from its index was swapped meanwhile, what that member
 * answered may mix two builds, so the read runs again over a source that reads those members from their records. The run it answers is one
 * whose index reads no swap touched: the second run reads from the records every member the first one pinned (not only the swapped one: a
 * member of the first run swapped during the second would answer from two builds, unchecked), and a run that reads a member from its index
 * is asked again whether it was swapped.
 *
 * The sources here are stubs of the one surface the function reads (`readPaths`, `indexesSwapped`): the swap is a scripted event, so no
 * timing decides the case.
 *
 * ## Seen red
 *
 * On d5192c4f6: case 1 fails at the second run's records (`['A']`, not `['A', 'B']`: B was read from its index in run 2).
 *
 * Run: npm run build:server, then
 *      node --test testing/standalone/a-read-across-swaps-answers-from-no-swapped-index.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { readAcrossSwaps } = await import('../../server/dist/rdf/read-across-swaps.js');

/**
 * A world of members `members`; `pins[n]` are the members run n decides to read from their index (when not told to read their records), and
 * `swaps[n]` the members swapped while run n runs. Answers `open`, and the runs it opened.
 */
function world(pins, swaps) {
  const runs = [];
  const open = (recordsFor) => {
    const run = { n: runs.length + 1, recordsFor: [...recordsFor].sort() };
    run.indexed = (pins[run.n] ?? []).filter(m => !recordsFor.includes(m)).sort();
    runs.push(run);
    return {
      n: run.n,
      readPaths: () => [...run.indexed.map(space => ({ space, path: 'index' })), ...run.recordsFor.map(space => ({ space, path: 'records' }))],
      indexesSwapped: async () => run.indexed.filter(m => (swaps[run.n] ?? []).includes(m)),
    };
  };
  return { open, runs };
}

describe('a read across swaps answers from no swapped index', () => {
  it('the second run reads from the records every member the first run pinned, so a swap during it touches none', async () => {
    const { open, runs } = world({ 1: ['A', 'B'], 2: ['A', 'B'] }, { 1: ['A'], 2: ['B'] });
    const answered = await readAcrossSwaps(open, async source => source.n);
    assert.deepEqual(runs[1].recordsFor, ['A', 'B'], 'run 2 reads A (swapped) and B (pinned, not yet swapped) from their records');
    const last = runs[answered - 1];
    assert.deepEqual(last.indexed.filter(m => (({ 1: ['A'], 2: ['B'] })[last.n] ?? []).includes(m)), [], 'the run answered read no member from an index swapped during it');
  });

  it('a member only the second run pinned, swapped during it, is read from its records by a run after', async () => {
    const { open, runs } = world({ 1: ['A'], 2: ['A', 'C'], 3: ['A', 'C'] }, { 1: ['A'], 2: ['C'] });
    const answered = await readAcrossSwaps(open, async source => source.n);
    const last = runs[answered - 1];
    assert.deepEqual(last.recordsFor, ['A', 'C'], 'the run answered reads both from their records');
    assert.ok(answered >= 3, `a third run was needed: ${answered}`);
  });

  it('a first run that threw with a member swapped is read again with that member from its records, and a throw with none swapped is thrown', async () => {
    const swapped = world({ 1: ['A'] }, { 1: ['A'] });
    let calls = 0;
    const again = await readAcrossSwaps(swapped.open, async () => { if (++calls === 1) throw new Error('met a renamed collection'); return 'answered'; });
    assert.equal(again, 'answered');
    assert.deepEqual(swapped.runs[1].recordsFor, ['A'], 'the second run reads the swapped member from its records');
    const steady = world({ 1: ['A'] }, {});
    await assert.rejects(readAcrossSwaps(steady.open, async () => { throw new Error('a real failure'); }), /a real failure/);
    assert.equal(steady.runs.length, 1, 'a throw no swap explains is not read again');
  });

  it('a read no swap touched is answered by its first run', async () => {
    const { open, runs } = world({ 1: ['A', 'B'] }, {});
    assert.equal(await readAcrossSwaps(open, async () => 'once'), 'once');
    assert.equal(runs.length, 1);
  });
});

/**
 * The backfill's `skippedSuppressed` is a difference taken within ONE read, never across two.
 *
 * ## The defect
 *
 * `reembedSpace` reported how many candidates the suppression filter removed, and computed it as:
 *
 * ```
 * countDocuments(vectorless) - countDocuments(vectorless AND allowed)
 * ```
 *
 * Both are live counts over a population the embed worker is actively DRAINING: every record it finishes
 * gains a vector and leaves `vectorless`. If the worker lands between the two reads the second count is
 * smaller for a reason that has nothing to do with suppression, and the difference goes POSITIVE with
 * nothing suppressed at all.
 *
 * What an operator is then told is the opposite of the truth: `skippedSuppressed` is the number that
 * exists to say *"the setting is still on"*.
 *
 * Measured as an intermittent `skippedSuppressed: 1` in a loaded `test:all:core` run of
 * `reembed-both-doors`, against a space whose suppression had just been turned off — and passing when
 * that file ran alone.
 *
 * ## Why this is a SOURCE gate and not a behaviour one
 *
 * Reproducing it needs the worker to finish a record inside a window of a few milliseconds. A test that
 * seeds records and sweeps them passes on the broken code every time, because nothing is draining the
 * collection — so a behaviour test here would be green about the bug. What can be checked exactly is the
 * SHAPE: the two numbers come from one pass, so no amount of concurrency can separate them.
 *
 * ## Why it reads TWO modules
 *
 * Q-99 part 2 moved the walk into `brain/queue-embed-sweep.ts`, shared by reindex and reembed, and left the
 * backfill's contract — the counts among it — in `brain/reembed.ts`. The counting code may sit on either side
 * of that line, and a gate that read one file would pass with the subtraction rebuilt in the other. So the
 * subject is `reembedSpace`'s body PLUS the whole walker, and both must be present for the gate to conclude
 * anything.
 *
 * `a-parity-assertion-over-a-moving-quantity` is the general form of the mistake.
 *
 * ## Seen red
 *
 * By mutation: restoring the two `countDocuments` calls makes the rule below name the files.
 *
 * Run: node --test testing/standalone/a-skipped-count-comes-from-one-snapshot.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/** `untracked: true`: the walker is a new module, on disk before it is committed. */
const BRAIN = readTrackedSources('server/src/brain', { floor: 10, untracked: true });

/** The code that reports this number: `reembedSpace`'s body and the walker it delegates to. */
function countingCode() {
  const reembed = BRAIN.find(s => s.file === 'server/src/brain/reembed.ts');
  const sweep = BRAIN.find(s => s.file === 'server/src/brain/queue-embed-sweep.ts');
  assert.ok(reembed, 'server/src/brain/reembed.ts is where the backfill lives — re-anchor this gate');
  assert.ok(sweep, 'server/src/brain/queue-embed-sweep.ts is where the shared walk lives — re-anchor this gate');
  const body = bodyOf(stripComments(reembed.text), 'reembedSpace');
  const walker = stripComments(sweep.text);
  return { body, walker, both: `${body}\n${walker}` };
}

describe('a skipped count comes from one snapshot', () => {
  it('the code is where this gate thinks it is', () => {
    // Floors everything below: a renamed export or a missing module would make each case assert against nothing.
    const { body, walker } = countingCode();
    assert.ok(body.length > 300, `reembedSpace body looks wrong (${body.length} chars) — re-anchor`);
    assert.ok(walker.length > 500, `queue-embed-sweep.ts looks wrong (${walker.length} chars) — re-anchor`);
    assert.match(body, /skippedSuppressed/, 'the counter this gate is about must be in the body it read');
  });

  it('the two counts it subtracts come from ONE aggregation', () => {
    assert.match(countingCode().both, /\$facet/,
      'the difference must be taken inside a single pass, or the embed worker can move the population '
      + 'between the two reads and the count reports suppression that does not exist');
  });

  it('and it does not read the collection twice to subtract', () => {
    /*
     * Counted rather than located, across BOTH files. ONE `countDocuments` is legitimate: the
     * `exclusion === 'all'` branch reports every candidate as skipped, and there is nothing to subtract
     * from it. Two or more means the subtraction has come back, on whichever side of the split.
     */
    const calls = (countingCode().both.match(/countDocuments\(/g) ?? []).length;
    assert.ok(calls <= 1,
      `the backfill calls countDocuments ${calls} times across reembed.ts and queue-embed-sweep.ts — a difference `
      + 'taken across separate reads of a collection the embed worker is draining reports suppression that is not '
      + 'there. The whole-space branch legitimately uses one; anything more is the defect returning.');
  });
});

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
 * that file ran alone, which is the signature the file itself documents twelve lines above the assertion
 * that failed.
 *
 * ## Why this is a SOURCE gate and not a behaviour one
 *
 * Reproducing it needs the worker to finish a record inside a window of a few milliseconds. A test that
 * seeds records and sweeps them passes on the broken code every time, because nothing is draining the
 * collection — so a behaviour test here would be green about the bug. What can be checked exactly is the
 * SHAPE: the two numbers come from one pass, so no amount of concurrency can separate them.
 *
 * `a-parity-assertion-over-a-moving-quantity` is the general form of the mistake.
 *
 * ## Seen red
 *
 * By mutation: restoring the two `countDocuments` calls makes the rule below name the file.
 *
 * Run: node --test testing/standalone/a-skipped-count-comes-from-one-snapshot.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/** The sweep, read from source — the one function that reports this number. */
function sweepBody() {
  const f = readTrackedSources('server/src/brain', { floor: 10 })
    .find(s => s.file.endsWith('reembed.ts'));
  assert.ok(f, 'server/src/brain/reembed.ts is where the sweep lives — re-anchor this gate');
  return bodyOf(stripComments(f.text), 'reembedSpace');
}

describe('a skipped count comes from one snapshot', () => {
  it('the sweep is where this gate thinks it is', () => {
    // Floors everything below: a renamed export would make each case assert against an empty string.
    const body = sweepBody();
    assert.ok(body.length > 500, `reembedSpace body looks wrong (${body.length} chars) — re-anchor`);
    assert.match(body, /skippedSuppressed/, 'the counter this gate is about must be in the body it read');
  });

  it('the two counts it subtracts come from ONE aggregation', () => {
    const body = sweepBody();
    assert.match(body, /\$facet/,
      'the difference must be taken inside a single pass, or the embed worker can move the population '
      + 'between the two reads and the count reports suppression that does not exist');
  });

  it('and it does not read the collection twice to subtract', () => {
    /*
     * Counted rather than located. ONE `countDocuments` is legitimate and load-bearing: the
     * `exclusion === 'all'` branch reports every candidate as skipped, and there is nothing to subtract
     * from it. Two or more means the subtraction has come back.
     */
    const calls = (sweepBody().match(/countDocuments\(/g) ?? []).length;
    assert.ok(calls <= 1,
      `the sweep calls countDocuments ${calls} times — a difference taken across separate reads of a `
      + 'collection the embed worker is draining reports suppression that is not there. The whole-space '
      + 'branch legitimately uses one; anything more is the defect returning.');
  });
});

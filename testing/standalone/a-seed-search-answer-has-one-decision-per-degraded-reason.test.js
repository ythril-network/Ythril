/**
 * What a background scan does with a neighbour search's `degraded` is decided ONCE, per reason, and every reason has a decision
 * (Q-697, b235 design v3 item 8; data-integrity S8).
 *
 * ## The defect
 *
 * The duplicate scanner held its position on `degraded?.includes('index_not_ready')`, written inline where it read the answer
 * (`dupe-scanner.ts`); the contradiction scanner, built on the same search, read no `degraded` at all. Two scanners, two spellings of
 * a decision that is one question: "this answer came from an index that did not answer - is the seed settled?". A reason added to
 * `DEGRADED_REASONS` later is then decided by whichever spelling a reader remembers, and the forgotten one defaults to "advance",
 * which marks the seed scanned and loses its pairs (the Q-326 defect the dupe hold was written for).
 *
 * ## The rule
 *
 * `seedSearchOutcome(degraded)` in `brain/scan-seed-runner.ts` answers `'hold'` or `'advance'` for the `degraded` of a `findSimilar`
 * answer, and:
 *
 *  - it has a decision for EVERY reason of `DEGRADED_REASONS`, derived from `brain/degraded-reasons.ts` here and never listed: a reason
 *    added there is a row added here by construction, and the table that decides it is typed `Record<DegradedReason, 'hold' | 'advance'>`
 *    so the compiler refuses a reason without a decision;
 *  - `index_not_ready` is the ONLY hold (an index being built over records it should serve: the next run, once it serves, reads the
 *    same records again). Every other reason ADVANCES, `index_unavailable` included: an index that needs an operator would otherwise
 *    stall the type for ever, with the scanner reading the same records every night (bundle-72 A-S8);
 *  - a hold anywhere in the answer holds it: the decision is the strictest of the reasons the answer carries, so a recall that was
 *    also `search_timeout` in another collection still holds the seed whose collection was not ready;
 *  - an answer with no `degraded` (the field is absent when nothing degraded) advances.
 *
 * "Seen red" on the base: `seedSearchOutcome` is not exported.
 *
 * Run: node --test testing/standalone/a-seed-search-answer-has-one-decision-per-degraded-reason.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const { DEGRADED_REASONS } = await import('../../server/dist/brain/degraded-reasons.js');
const runner = await import('../../server/dist/brain/scan-seed-runner.js');
const source = readFileSync(join(ROOT, 'server/src/brain/scan-seed-runner.ts'), 'utf8');

/** The one reason that holds. Named here once: the rule says it is the only one, so the row below that proves it needs the name. */
const HOLDS = 'index_not_ready';

describe('a scan\'s decision on a neighbour search\'s degraded reasons', () => {
  it('reads the vocabulary it decides over (the scan itself still works)', () => {
    // A floor, not a count: if the vocabulary moved or emptied, every row below would pass over nothing.
    assert.ok(DEGRADED_REASONS.length >= 7, `only ${DEGRADED_REASONS.length} reasons read from degraded-reasons.ts`);
    assert.ok(DEGRADED_REASONS.includes(HOLDS), `${HOLDS} is not a degraded reason any more: the rule below names a reason that does not exist`);
  });

  it('seedSearchOutcome is exported from scan-seed-runner', () => {
    assert.equal(typeof runner.seedSearchOutcome, 'function',
      'scan-seed-runner exports no seedSearchOutcome: each scanner decides what to do with `degraded` in its own words (the dupe scanner inline, the contradiction scanner not at all)');
  });

  for (const reason of DEGRADED_REASONS) {
    it(`${reason}: has a decision, and it is ${reason === HOLDS ? 'hold' : 'advance'}`, () => {
      assert.equal(typeof runner.seedSearchOutcome, 'function', 'seedSearchOutcome is not exported');
      const outcome = runner.seedSearchOutcome([reason]);
      assert.ok(outcome === 'hold' || outcome === 'advance', `${reason} is decided as ${JSON.stringify(outcome)}: a reason without a decision lets a scan guess`);
      assert.equal(outcome, reason === HOLDS ? 'hold' : 'advance',
        reason === HOLDS
          ? `${HOLDS} advanced: the seed is marked scanned over an index that was not asked`
          : `${reason} held: ${HOLDS} is the only reason a scan waits for, and waiting on any other stalls the type until an operator acts`);
    });

    if (reason !== HOLDS) {
      it(`${reason} beside ${HOLDS} still holds (the strictest reason of the answer decides)`, () => {
        assert.equal(typeof runner.seedSearchOutcome, 'function', 'seedSearchOutcome is not exported');
        assert.equal(runner.seedSearchOutcome([reason, HOLDS]), 'hold');
        assert.equal(runner.seedSearchOutcome([HOLDS, reason]), 'hold');
      });
    }
  }

  it('an answer that carries no degraded advances (the field is absent when nothing degraded)', () => {
    assert.equal(typeof runner.seedSearchOutcome, 'function', 'seedSearchOutcome is not exported');
    assert.equal(runner.seedSearchOutcome(undefined), 'advance');
    assert.equal(runner.seedSearchOutcome([]), 'advance');
  });

  it('the decisions are one table typed over the vocabulary, so a reason without a decision does not compile', () => {
    assert.match(source, /Record<\s*DegradedReason\s*,\s*['"]hold['"]\s*\|\s*['"]advance['"]\s*>/,
      'scan-seed-runner.ts has no `Record<DegradedReason, \'hold\' | \'advance\'>`: a reason added to DEGRADED_REASONS would be decided by a default nobody wrote');
  });
});

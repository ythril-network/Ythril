/**
 * A rank-1 score is only readable next to the highest score that question set can produce.
 *
 * ## The thing this makes impossible to miss
 *
 * On this dataset most questions cite ONE turn, but a fifth of them cite turns from two different sessions
 * of the conversation. A strategy whose answering record is a run of consecutive turns — every window rung
 * in the programme — cannot put both of those turns in one record, at any window size. So its rank-1 score
 * is capped by the layout of the evidence rather than by how good the retrieval is, and on the published
 * 199-question sample the cap is **84.9%**.
 *
 * That number was not known while the programme was being run, and its absence cost real work: window
 * shapes were swept for points that the shape could not produce, and a target was set above the ceiling.
 * Printing the ceiling beside the score is what makes "we are three points from the maximum" and "we are
 * thirty points from the target" distinguishable at a glance.
 *
 * ## Why this is the same defence as `top record chars`
 *
 * The report already prints how big the winning record was, because a rank-1 score means nothing without
 * it — a single record holding the whole transcript scores perfectly and retrieves nothing. This is the
 * other end of the same axis: a rank-1 score also means nothing without knowing what a perfect retriever
 * would have scored. Both columns exist so a number cannot be quoted alone and sound like more than it is.
 *
 * A high score reported next to a lower ceiling is arithmetically impossible, and the most likely cause is
 * that the metric changed — which is the thing the owner ruled out on 2026-09-06.
 *
 * ## What the ceiling does NOT bound
 *
 * Stated here because a gate that concludes about more than it checks is this repository's most repeated
 * mistake. Rank-1 credit reaches through a record's graph expansions, so a rung that LINKS turns across
 * sessions can carry a second session's turn into the first result and is not bound by this number. The
 * ceiling is for contiguous windows, it is named for that, and nothing here asserts a score is below it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evidenceShape, contiguousWindowCeiling } from '../../benchmarks/harness/evidence-shape.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A question shaped the way `loadQuestions` returns one, varying only the evidence. */
const q = (...evidence) => ({ conversationId: 'conv-1', question: 'q?', category: 1, evidence });

describe('the shape of the evidence is derived, not assumed', () => {
  test('counts single turns, within-session spreads and cross-session spreads apart', () => {
    const shape = evidenceShape([
      q('D1:3'),                    // one turn
      q('D1:5'),                    // one turn
      q('D2:1', 'D2:3'),            // one session, span 3
      q('D2:1', 'D2:2'),            // one session, span 2
      q('D1:4', 'D7:2'),            // two sessions — no window holds this
    ]);
    assert.equal(shape.n, 5);
    assert.equal(shape.singleTurn, 2);
    assert.equal(shape.withinSession, 4, 'the four that sit inside one session');
    assert.equal(shape.crossSession, 1);
    assert.deepEqual(shape.spans.slice().sort(), [1, 1, 2, 3], 'a cross-session question contributes no span');
  });

  test('a session number is part of the identity, so the same turn number in two sessions is a spread', () => {
    // The failure this catches is parsing `D3:7` for its turn and dropping the session: two questions that
    // are trivially different would then look identical, and the ceiling would come out too high.
    const shape = evidenceShape([q('D3:7', 'D9:7')]);
    assert.equal(shape.crossSession, 1, 'same turn number, different sessions — that is a spread');
    assert.equal(shape.withinSession, 0);
  });
});

describe('the ceiling a contiguous window cannot beat', () => {
  const shape = evidenceShape([
    q('D1:1'), q('D1:2'), q('D1:3'),   // three single turns
    q('D2:1', 'D2:4'),                 // span 4
    q('D1:9', 'D4:1'),                 // cross-session
  ]);

  test('a window of one turn can only answer the single-turn questions', () => {
    assert.equal(contiguousWindowCeiling(shape, 1), 3 / 5);
  });

  test('a window wide enough for the spread picks it up, and never the cross-session one', () => {
    assert.equal(contiguousWindowCeiling(shape, 3), 3 / 5, 'a span of 4 does not fit in 3');
    assert.equal(contiguousWindowCeiling(shape, 4), 4 / 5);
    assert.equal(contiguousWindowCeiling(shape, 10_000), 4 / 5,
      'no window reaches a second session, so the curve is flat above the widest span');
  });

  test('the ceiling never exceeds the share that sits inside one session', () => {
    for (const w of [1, 2, 3, 5, 9, 50, 1000]) {
      assert.ok(contiguousWindowCeiling(shape, w) <= shape.withinSession / shape.n,
        `a window of ${w} claimed more than the within-session share`);
    }
  });
});

describe('the floors, because a ceiling computed over nothing is a plausible number', () => {
  test('an empty question set throws rather than dividing by zero', () => {
    // An empty set is what a caller gets from a filter that stopped matching. `0/0` is NaN and `0 of 0`
    // formats as 0%, and both read as a real answer in a report.
    assert.throws(() => evidenceShape([]), /no questions/i);
  });

  test('a question with no evidence throws rather than being skipped', () => {
    // Skipping it would compute the ceiling over a smaller set than the one being measured and report it
    // as the whole — the denominator would be silently wrong.
    assert.throws(() => evidenceShape([q()]), /evidence/i);
  });

  test('an evidence id that does not parse throws rather than being dropped', () => {
    assert.throws(() => evidenceShape([q('session two, turn four')]), /D<session>:<turn>/);
  });
});

describe('every published rank headline states its ceiling', () => {
  /** Derived, never listed: a report added next year is covered without this file changing. */
  const reports = execFileSync('git', ['ls-files', 'benchmarks/results/**/REPORT.md'], {
    cwd: repoRoot, encoding: 'utf8',
  }).split('\n').map(s => s.trim()).filter(Boolean);

  test('there are published reports to check', () => {
    assert.ok(reports.length > 0, 'found no tracked Tier 0-R report — the derivation is broken, not the reports');
  });

  for (const rel of reports) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    // Only the rank-era reports make this claim; a coverage-era report predates the metric and is left alone.
    if (!/all at rank 1/i.test(text)) continue;

    test(`${rel} prints the ceiling beside the score`, () => {
      assert.match(text, /ceiling/i,
        'a rank-1 score with no ceiling beside it cannot be read as near or far from the maximum');
      assert.match(text, /cross-session/i,
        'the ceiling is only believable with the share of questions that produced it');
    });
  }
});

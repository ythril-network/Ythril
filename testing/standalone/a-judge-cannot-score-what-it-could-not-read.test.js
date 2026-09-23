/**
 * The grade step of the benchmark harness, and the two ways it refuses (`B-6`).
 *
 * ## The failure this file is about
 *
 * A judge call that fails has to be told apart from an answer the judge marked wrong. They are one
 * character apart in most harnesses — a `catch` that returns `false` — and the result is a run that
 * publishes a low score instead of reporting that it could not be scored. `retrieve.mjs` already makes
 * that distinction for the retrieval half (*"a failed call is not an empty result"*); this is the same
 * rule one step later, where it is worth more, because this is the number that gets published.
 *
 * So `gradeOne` never returns a verdict it did not receive, and `correctCount` REFUSES a list holding an
 * ungraded item rather than counting it as incorrect. The refusal is the point: a caller who wants a
 * partial figure has to say so and say how many were missing.
 *
 * ## And the judge may not be the answerer's own provider
 *
 * `B-2` requires the two from different hosted families so the judge is not marking its own phrasing.
 * That is a sentence in a tracker until something enforces it, and the run where it is skipped looks
 * exactly like the run where it is not — a plausible number, several points high.
 *
 * Checked on the PROVIDER rather than on the model name. A prefix table of families is a list that goes
 * stale the week a provider renames a model, and a stale list here fails open.
 *
 * Run: node --test testing/standalone/a-judge-cannot-score-what-it-could-not-read.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeOne, gradeAll, correctCount, assertIndependentJudge, deltaInputs, VERDICTS,
} from '../../benchmarks/harness/grade.mjs';
import { memoryDelta } from '../../benchmarks/harness/arms.mjs';

/** A judge that answers with whatever it is told to, without a model. */
const judgeSaying = (word, provider = 'provider-b') => ({
  provider, model: 'judge-1', ask: async () => word,
});
const judgeThatFails = (message, provider = 'provider-b') => ({
  provider, model: 'judge-1', ask: async () => { throw new Error(message); },
});

const ARM = { question: 'Who owns the dog?', memory: 'on', context: [] };
const ANSWER = 'Ravi owns the dog.';
const REFERENCE = 'Ravi';

describe('a verdict is only ever one the judge gave', () => {
  it('a clean "correct" is carried through', async () => {
    const r = await gradeOne({ judge: judgeSaying('correct'), arm: ARM, answer: ANSWER, reference: REFERENCE });
    assert.equal(r.verdict, 'correct');
    assert.equal(r.error, undefined);
  });

  it('a clean "incorrect" is carried through — a judged wrong answer IS a result', async () => {
    const r = await gradeOne({ judge: judgeSaying('incorrect'), arm: ARM, answer: ANSWER, reference: REFERENCE });
    assert.equal(r.verdict, 'incorrect');
    assert.equal(r.error, undefined);
  });

  it('a judge call that THREW has no verdict, and says why', async () => {
    const r = await gradeOne({ judge: judgeThatFails('429 rate limited'), arm: ARM, answer: ANSWER, reference: REFERENCE });
    assert.equal(r.verdict, null, 'a failed judge call must not become a verdict');
    assert.match(r.error, /429/);
  });

  it('a reply that is neither verdict is an ERROR, not an incorrect', async () => {
    const r = await gradeOne({ judge: judgeSaying('probably right?'), arm: ARM, answer: ANSWER, reference: REFERENCE });
    assert.equal(r.verdict, null);
    assert.match(r.error, /probably right\?/, 'the refusal quotes what came back, or nobody can fix the prompt');
  });

  it('there are exactly two verdicts, and "unknown" is not one of them', () => {
    assert.deepEqual([...VERDICTS].sort(), ['correct', 'incorrect']);
  });
});

describe('an ungraded item cannot be silently counted as wrong', () => {
  it('counts the correct ones when everything was graded', () => {
    const graded = [{ verdict: 'correct' }, { verdict: 'incorrect' }, { verdict: 'correct' }];
    assert.equal(correctCount(graded), 2);
  });

  it('REFUSES a list holding an ungraded item, and says how many', () => {
    const graded = [{ verdict: 'correct' }, { verdict: null, error: 'boom' }];
    assert.throws(() => correctCount(graded), /1 of 2/);
  });

  it('an empty list is undefined, not zero correct', () => {
    assert.throws(() => correctCount([]), /no questions/i);
  });

  it('a partial figure is possible, but only by asking for it out loud', () => {
    const graded = [{ verdict: 'correct' }, { verdict: null, error: 'boom' }];
    assert.equal(correctCount(graded, { allowUngraded: true }), 1);
  });
});

describe('the judge is not the answerer wearing a different name', () => {
  it('two providers is what it is for', () => {
    assert.doesNotThrow(() => assertIndependentJudge(
      { provider: 'provider-a', model: 'answer-1' }, { provider: 'provider-b', model: 'judge-1' },
    ));
  });

  it('one provider is refused, whatever the model names say', () => {
    assert.throws(() => assertIndependentJudge(
      { provider: 'provider-a', model: 'answer-1' }, { provider: 'provider-a', model: 'judge-9' },
    ), /provider/i);
  });

  it('a missing provider is refused rather than treated as different', () => {
    assert.throws(() => assertIndependentJudge(
      { model: 'answer-1' }, { provider: 'provider-b', model: 'judge-1' },
    ), /provider/i);
  });
});

describe('grading many keeps going, and keeps the failures', () => {
  it('one bad call does not lose the rest, and the run knows it is incomplete', async () => {
    let n = 0;
    const flaky = {
      provider: 'provider-b', model: 'judge-1',
      ask: async () => { n += 1; if (n === 2) throw new Error('timeout'); return 'correct'; },
    };
    const graded = await gradeAll({
      judge: flaky,
      items: [
        { arm: ARM, answer: 'a', reference: 'a' },
        { arm: ARM, answer: 'b', reference: 'b' },
        { arm: ARM, answer: 'c', reference: 'c' },
      ],
    });
    assert.equal(graded.length, 3);
    assert.deepEqual(graded.map(g => g.verdict), ['correct', null, 'correct']);
    assert.throws(() => correctCount(graded), /1 of 3/);
  });
});

describe('the subtraction cannot be handed a denominator by hand', () => {
  it('derives both counts and the denominator from the two graded lists', async () => {
    const mem = [{ verdict: 'correct' }, { verdict: 'correct' }, { verdict: 'incorrect' }];
    const base = [{ verdict: 'correct' }, { verdict: 'incorrect' }, { verdict: 'incorrect' }];
    assert.deepEqual(deltaInputs(mem, base), { memoryCorrect: 2, baselineCorrect: 1, asked: 3 });
  });

  it('refuses two lists of different lengths — that is not a subtraction', () => {
    assert.throws(
      () => deltaInputs([{ verdict: 'correct' }], [{ verdict: 'correct' }, { verdict: 'incorrect' }]),
      /same questions|1 .*2|different/i,
    );
  });

  it('refuses when either arm holds an ungraded answer', () => {
    const mem = [{ verdict: 'correct' }, { verdict: null, error: 'timeout' }];
    const base = [{ verdict: 'correct' }, { verdict: 'incorrect' }];
    assert.throws(() => deltaInputs(mem, base), /no verdict/i);
    assert.throws(() => deltaInputs(base, mem), /no verdict/i);
  });

  it('feeds memoryDelta directly, so the denominator is never typed twice', () => {
    const mem = [{ verdict: 'correct' }, { verdict: 'correct' }];
    const base = [{ verdict: 'correct' }, { verdict: 'incorrect' }];
    const d = memoryDelta(deltaInputs(mem, base));
    assert.equal(d.asked, 2);
    assert.equal(d.deltaPoints, 50);
  });
});

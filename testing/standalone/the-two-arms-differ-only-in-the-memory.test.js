/**
 * The memory arm and the no-memory baseline differ in the memory and in nothing else.
 *
 * ## Why the subtraction is the published number
 *
 * `B-2`: *"the number to publish is not the accuracy, it is the accuracy minus what the same answerer
 * scores with the whole history in its context. Same questions, same judge, same seeds, memory off.
 * Without that column a figure in the eighties says nothing about whether the memory did anything, and it
 * is the column every self-reported figure omits."*
 *
 * The evidence: Bench'd, running these systems themselves, puts the plain-context baseline at 50.4% on
 * LoCoMo with LlamaIndex at 54.8% and LangChain at 51.9% — **three points of memory**. Mem0 self-reports
 * 93.4% on LongMemEval and scores 32.4% when somebody else runs its open build.
 *
 * ## What these cases are really guarding
 *
 * A subtraction between two arms that differ in more than one thing is not a measurement of the memory,
 * and it looks exactly like one. The failure is silent by construction: both numbers are real, the
 * arithmetic is right, and the answer is about a configuration rather than about a product.
 *
 * So the important cases are not "the arms are built" but **"the arms cannot be built differently"** —
 * one config in, both out, and a checker that catches a pair somebody else assembled.
 *
 * Run: node --test testing/standalone/the-two-arms-differ-only-in-the-memory.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armsFor, armsDisagreeOn, wholeHistory, memoryDelta, MEMORY_ONLY } from '../../benchmarks/harness/arms.mjs';

const conversation = {
  id: 'conv-x',
  sessions: [
    { index: 1, startsAt: '2023-01-20T09:00:00Z', turns: [{ speaker: 'Gina', text: 'Hey Jon!' }, { speaker: 'Jon', text: 'Lost my job.' }] },
    { index: 2, startsAt: '2023-02-01T09:00:00Z', turns: [{ speaker: 'Jon', text: 'Starting a studio.' }] },
  ],
};
const hits = [{ id: 'id-1', kind: 'fact', text: 'Jon lost his job as a banker.', score: 0.9 }];
const config = { answererModel: 'model-a', judgeModel: 'model-b', seed: 7 };

describe('both arms come from one configuration', () => {
  it('the question, the answerer, the judge and the seed are identical', () => {
    const { memory, baseline } = armsFor({ conversation, question: 'where did Jon work', hits, config });
    for (const k of ['question', 'answererModel', 'judgeModel', 'seed']) {
      assert.equal(memory[k], baseline[k], `${k} differs between the arms, so the delta is not the memory`);
    }
  });

  it('and they differ in exactly the two fields that are allowed to', () => {
    const { memory, baseline } = armsFor({ conversation, question: 'q', hits, config });
    assert.deepEqual(armsDisagreeOn(memory, baseline), []);
    assert.equal(memory.memory, 'on');
    assert.equal(baseline.memory, 'off');
    assert.notDeepEqual(memory.context, baseline.context);
    assert.deepEqual(MEMORY_ONLY, ['memory', 'context']);
  });

  it('the checker CATCHES a pair somebody else assembled', () => {
    // The case that matters. A future caller building arms by hand is how the seeds come to differ, and
    // the report calls this on every pair rather than trusting they came from `armsFor`.
    const { memory, baseline } = armsFor({ conversation, question: 'q', hits, config });
    assert.deepEqual(armsDisagreeOn(memory, { ...baseline, seed: 9 }), ['seed']);
    assert.deepEqual(armsDisagreeOn(memory, { ...baseline, judgeModel: 'other' }), ['judgeModel']);
    assert.deepEqual(armsDisagreeOn(memory, { ...baseline, question: 'other' }), ['question']);
  });

  it('a new shared field reaches both arms without being added twice', () => {
    // The structural half: `shared` is spread into both, so this cannot drift. Asserted by checking that
    // nothing outside MEMORY_ONLY is arm-specific, over the real object rather than a list I maintain.
    const { memory, baseline } = armsFor({ conversation, question: 'q', hits, config });
    const armSpecific = Object.keys(memory).filter(k => !(k in baseline));
    assert.deepEqual(armSpecific, [], 'a field exists on one arm only');
  });
});

describe('the baseline context', () => {
  it('is the whole history, oldest first, as the extraction read it', () => {
    const text = wholeHistory(conversation);
    assert.ok(text.indexOf('Lost my job.') < text.indexOf('Starting a studio.'),
      'the baseline must read the conversation in the order the loader gives it');
    assert.match(text, /session 1 — 2023-01-20/);
    assert.match(text, /Gina: Hey Jon!/);
  });

  it('refuses an empty conversation rather than scoring the baseline zero', () => {
    // A baseline handed nothing answers nothing, and the memory then looks better by exactly that much —
    // a flattering result produced by a bug, which is the direction nobody checks.
    assert.throws(() => wholeHistory({ sessions: [] }), /would score zero for the baseline/);
  });

  it('refuses hits that are absent rather than empty', () => {
    // Different facts: no array is a question retrieval FAILED on, an empty one is a question it found
    // nothing for. Scoring them the same hides an outage as a bad result.
    assert.throws(() => armsFor({ conversation, question: 'q', hits: undefined, config }),
      /even when empty/);
  });
});

describe('the delta', () => {
  it('reports both accuracies beside the number to publish', () => {
    const d = memoryDelta({ memoryCorrect: 80, baselineCorrect: 50, asked: 100 });
    assert.equal(d.deltaPoints, 30);
    assert.equal(d.memoryAccuracy, 80);
    assert.equal(d.baselineAccuracy, 50);
  });

  it('a negative delta is a real result, not an error', () => {
    // "Most memory systems destroy information by summarising faster than they organise it" is the finding
    // this column exists to be able to report about ourselves.
    assert.equal(memoryDelta({ memoryCorrect: 40, baselineCorrect: 50, asked: 100 }).deltaPoints, -10);
  });

  it('refuses a delta over no questions', () => {
    assert.throws(() => memoryDelta({ memoryCorrect: 0, baselineCorrect: 0, asked: 0 }), /is not zero/);
  });
});

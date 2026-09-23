/**
 * A graded run is ONE loop that feeds both arms from one retrieval, across every seed (`B-6`).
 *
 * ## Why the loop is its own module, and tested without a model
 *
 * `retrieve.mjs`, `arms.mjs` and `grade.mjs` each hold one rule. What none of them can hold is the rule
 * BETWEEN them: that the memory arm is answered from the retrieval that was actually made, that both arms
 * are asked the same thing under the same seed, that a failed step makes a seed UNSCORED rather than low,
 * and that the published figure carries its spread across seeds. A runner written by hand around the three
 * modules is where each of those would be dropped, one at a time, and every one of them produces a
 * plausible number when dropped.
 *
 * The answerer and the judge are handed in, so every case here runs against fakes and no key is needed —
 * which is what makes the parked half of `B-6` a configuration change when the keys arrive.
 *
 * Run: node --test testing/standalone/a-graded-run-is-one-loop-over-both-arms.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runGraded } from '../../benchmarks/harness/run.mjs';

const conversation = {
  id: 'conv-x',
  sessions: [
    { index: 1, startsAt: '2023-01-20T09:00:00Z', turns: [{ speaker: 'Jon', text: 'Lost my job at the bank.' }] },
    { index: 2, startsAt: '2023-02-01T09:00:00Z', turns: [{ speaker: 'Jon', text: 'Starting a dance studio.' }] },
  ],
};
const questions = [
  { question: 'Where did Jon work?', reference: 'a bank' },
  { question: 'What is Jon starting?', reference: 'a dance studio' },
];

/** A recall client that records every call and answers with one hit per question. */
function fakeYthril({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async recall(req) {
      calls.push(req);
      if (failOn && req.query === failOn) throw new Error('recall exploded');
      return { results: [{ type: 'fact', score: 0.9, record: { _id: `hit-${calls.length}`, fact: `about: ${req.query}` } }] };
    },
  };
}

/** An answerer that records what each arm was handed. */
function fakeAnswerer({ provider = 'prov-a', failWhen } = {}) {
  const calls = [];
  return {
    provider, model: 'answerer-1', calls,
    async ask(input) {
      calls.push(input);
      if (failWhen?.(input)) throw new Error('answerer timed out');
      return `answer to ${input.question}`;
    },
  };
}

/** A judge whose verdict is decided by a function of the prompt, so a case can script the score. */
function fakeJudge({ provider = 'prov-b', verdict = () => 'correct' } = {}) {
  const calls = [];
  return {
    provider, model: 'judge-1', calls,
    async ask(prompt) { calls.push(prompt); return verdict(prompt, calls.length); },
  };
}

const base = () => ({ space: 'bench-conv-x', conversation, questions, seeds: [1, 2, 3], commit: 'abc123' });

describe('what is refused before anything is called', () => {
  it('a judge on the answerer\'s own provider — and nothing was asked of anyone', async () => {
    const ythril = fakeYthril();
    const answerer = fakeAnswerer({ provider: 'same' });
    const judge = fakeJudge({ provider: 'same' });
    await assert.rejects(runGraded({ ...base(), ythril, answerer, judge }), /provider/);
    // Refused BEFORE the run, or a key is spent on a run whose number cannot be published.
    assert.equal(ythril.calls.length, 0, 'retrieval ran before the independence check');
    assert.equal(answerer.calls.length, 0, 'the answerer ran before the independence check');
  });

  it('no seeds — a run over no seeds has no spread, and the protocol requires one', async () => {
    await assert.rejects(
      runGraded({ ...base(), seeds: [], ythril: fakeYthril(), answerer: fakeAnswerer(), judge: fakeJudge() }),
      /seed/);
  });

  it('no questions', async () => {
    await assert.rejects(
      runGraded({ ...base(), questions: [], ythril: fakeYthril(), answerer: fakeAnswerer(), judge: fakeJudge() }),
      /question/);
  });
});

describe('both arms are fed from one retrieval, under one seed', () => {
  it('the answerer is never told which arm it is answering', async () => {
    /*
     * The arms may differ in their CONTEXT and nothing else. An answerer handed a flag saying "this is the
     * baseline" could behave differently on it — and our own adapter is exactly the code that would one day
     * read it for a good-sounding reason. So the fakes below tell the arms apart by the context's shape,
     * which is the only difference that is allowed to exist.
     */
    const answerer = fakeAnswerer();
    await runGraded({ ...base(), seeds: [1], ythril: fakeYthril(), answerer, judge: fakeJudge() });
    for (const c of answerer.calls) {
      assert.deepEqual(Object.keys(c).sort(), ['context', 'question', 'seed'], JSON.stringify(Object.keys(c)));
    }
  });

  it('retrieval runs ONCE per question, however many seeds there are', async () => {
    /*
     * Recall has no seed. Re-running it per seed would make three retrievals that ought to be identical,
     * and the first time one of them differs the run is comparing three different memory arms.
     */
    const ythril = fakeYthril();
    await runGraded({ ...base(), ythril, answerer: fakeAnswerer(), judge: fakeJudge() });
    assert.equal(ythril.calls.length, questions.length);
  });

  it('the memory arm is handed exactly what retrieval returned; the baseline the whole history', async () => {
    const answerer = fakeAnswerer();
    await runGraded({ ...base(), seeds: [1], ythril: fakeYthril(), answerer, judge: fakeJudge() });
    const mem = answerer.calls.filter(c => Array.isArray(c.context));
    const off = answerer.calls.filter(c => typeof c.context === 'string');
    assert.equal(mem.length, questions.length);
    assert.equal(off.length, questions.length);
    assert.equal(mem[0].context[0].text, 'about: Where did Jon work?');
    assert.match(off[0].context, /Lost my job at the bank/);
    assert.match(off[0].context, /dance studio/, 'the baseline must see every session, not a slice');
  });

  it('both arms of a question get the same question text and the same seed', async () => {
    const answerer = fakeAnswerer();
    await runGraded({ ...base(), seeds: [7, 8], ythril: fakeYthril(), answerer, judge: fakeJudge() });
    for (const seed of [7, 8]) {
      for (const { question } of questions) {
        const pair = answerer.calls.filter(c => c.seed === seed && c.question === question);
        assert.deepEqual(pair.map(c => Array.isArray(c.context) ? 'on' : 'off').sort(), ['off', 'on'], `seed ${seed}, "${question}"`);
      }
    }
  });
});

describe('a failed step makes a seed UNSCORED, never low', () => {
  it('a failed answer is not handed to the judge, and that seed has no score', async () => {
    /*
     * The failure this whole harness is shaped against: an answer that did not arrive, graded as wrong.
     * Nine timeouts in a hundred questions and the run publishes a figure nine points low, and nothing in
     * it says so.
     */
    const answerer = fakeAnswerer({ failWhen: (i) => i.seed === 2 && Array.isArray(i.context) });
    const judge = fakeJudge();
    const report = await runGraded({ ...base(), ythril: fakeYthril(), answerer, judge });

    const s2 = report.seeds.find(s => s.seed === 2);
    assert.equal(s2.score, null, 'a seed with an unanswered question was scored');
    assert.match(s2.unscored, /no verdict|timed out|answer/i, `the reason must say why: ${s2.unscored}`);
    assert.ok(!judge.calls.some(p => p.includes('undefined')), 'the judge was handed a missing answer');

    // The other seeds still score, and the summary is over the scored seeds alone — and SAYS so.
    assert.equal(report.summary.scoredSeeds, 2);
    assert.deepEqual(report.summary.unscoredSeeds, [2]);
  });

  it('a failed retrieval leaves the memory arm unanswered rather than answered from nothing', async () => {
    /*
     * An empty context and a failed call are different questions. Answering the memory arm from `[]` after
     * recall threw would score the memory as useless on that question, when what happened is that nobody
     * asked it.
     */
    const answerer = fakeAnswerer();
    const report = await runGraded({
      ...base(), seeds: [1], ythril: fakeYthril({ failOn: 'Where did Jon work?' }), answerer, judge: fakeJudge(),
    });
    const memAsked = answerer.calls.filter(c => Array.isArray(c.context)).map(c => c.question);
    assert.ok(!memAsked.includes('Where did Jon work?'), 'the memory arm was answered after recall failed');
    assert.equal(report.seeds[0].score, null);
    assert.equal(report.retrieval.failed, 1);
  });
});

describe('the report is the figure plus everything needed to check it', () => {
  it('per seed: both accuracies and the delta, from the verdicts', async () => {
    // Memory arm always right, baseline right only on the first question → +50 points on every seed.
    const judge = fakeJudge({
      verdict: (prompt) => (prompt.includes('What is Jon starting?') && prompt.includes('ANSWER: base')
        ? 'incorrect' : 'correct'),
    });
    const answerer = {
      ...fakeAnswerer(),
      async ask(i) { return Array.isArray(i.context) ? `mem ${i.question}` : `base ${i.question}`; },
    };
    const report = await runGraded({ ...base(), ythril: fakeYthril(), answerer, judge });
    for (const s of report.seeds) {
      assert.equal(s.score.memoryAccuracy, 100);
      assert.equal(s.score.baselineAccuracy, 50);
      assert.equal(s.score.deltaPoints, 50);
    }
  });

  it('across seeds: the mean delta AND its spread, because a single figure hides the noise', async () => {
    // Seed 3's baseline gets both wrong, the others get both right — the spread must show it.
    const judge = fakeJudge({
      verdict: (prompt) => (prompt.includes('ANSWER: base') && prompt.includes('seed-3') ? 'incorrect' : 'correct'),
    });
    const answerer = {
      ...fakeAnswerer(),
      async ask(i) { return Array.isArray(i.context) ? 'mem' : `base seed-${i.seed}`; },
    };
    const report = await runGraded({ ...base(), ythril: fakeYthril(), answerer, judge });
    assert.equal(report.summary.deltaPoints.min, 0);
    assert.equal(report.summary.deltaPoints.max, 100);
    assert.ok(Math.abs(report.summary.deltaPoints.mean - 100 / 3) < 1e-9, JSON.stringify(report.summary));
  });

  it('names both models, both providers, every seed and the commit', async () => {
    const report = await runGraded({ ...base(), ythril: fakeYthril(), answerer: fakeAnswerer(), judge: fakeJudge() });
    assert.deepEqual(report.config, {
      space: 'bench-conv-x', conversationId: 'conv-x', topK: 10, traverse: 1,
      answerer: { provider: 'prov-a', model: 'answerer-1' },
      judge: { provider: 'prov-b', model: 'judge-1' },
      seeds: [1, 2, 3], commit: 'abc123',
    });
  });

  it('carries the exact retrieval requests, so the memory arm can be reproduced', async () => {
    const report = await runGraded({ ...base(), ythril: fakeYthril(), answerer: fakeAnswerer(), judge: fakeJudge() });
    assert.equal(report.retrieval.results.length, questions.length);
    assert.equal(report.retrieval.results[0].request.query, 'Where did Jon work?');
  });
});

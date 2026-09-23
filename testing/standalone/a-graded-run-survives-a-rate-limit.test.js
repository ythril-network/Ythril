/**
 * A graded run is a directory of files, so a rate limit costs one file and never the run (`B-6`).
 *
 * ## Why files, and why this shape
 *
 * Owner, 2026-09-23: the answerer is this assistant and the judge is a GPT model the owner drives by hand in
 * another vendor's chat, because the rule is two different hosted families. Neither side is a function the
 * harness can call, so every step hands over a FILE: the harness writes what the answerer needs, the answerer
 * writes answers, the harness writes what the judge needs, the owner pastes the judge's reply back.
 *
 * And the owner asked for it not to lose work to a rate limit — which has already happened here, twice, to
 * an extraction round. So every unit of work is its own file, written atomically, and `status` reads the
 * directory rather than anybody's memory of where they got to.
 *
 * ## What each case guards, because each is a way to publish a wrong number that looks right
 *
 *  - an input file that carries the reference answer, so the answerer can read the key
 *  - a half-written answer file that reads as done after a kill
 *  - an answer file made from a DIFFERENT input than the one on disk
 *  - a judge who can tell which arm an answer came from
 *  - a truncated judge reply read as "the rest were wrong"
 *
 * Run: node --test testing/standalone/a-graded-run-survives-a-rate-limit.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tokenF1, locomoF1 } from '../../benchmarks/harness/f1.mjs';
import {
  prepareConversation, answerStatus, writeAnswers, readAnswers,
  sampleForJudge, exportJudgeBatches, importJudgeReply, judgeStatus, SCORED_CATEGORIES,
} from '../../benchmarks/harness/file-run.mjs';

const conversation = {
  id: 'conv-x',
  sessions: [
    { index: 1, startsAt: '2023-01-20T09:00:00Z', turns: [{ speaker: 'Jon', text: 'Lost my job at the bank.' }] },
    { index: 2, startsAt: '2023-02-01T09:00:00Z', turns: [{ speaker: 'Jon', text: 'Starting a dance studio.' }] },
  ],
};
/** In release order, with a category-5 row in the middle so the ids are shown to survive filtering it out. */
const questions = [
  { conversationId: 'conv-x', question: 'Where did Jon work?', answer: 'REFKEY-bank', category: 4, evidence: ['D1:1'] },
  { conversationId: 'conv-x', question: 'What did Jon say about Mars?', adversarialAnswer: 'x', category: 5, evidence: [] },
  { conversationId: 'conv-x', question: 'What is Jon starting?', answer: 'REFKEY-studio', category: 1, evidence: ['D2:1'] },
];
const hitsFor = (q) => [{ id: `h-${q}`, kind: 'fact', text: `about ${q}`, score: 0.9 }];

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'b6-run-')); });

const prepare = () => prepareConversation({
  runDir: dir, conversation, questions, hitsFor, retrieval: { topK: 10, traverse: 1 },
});

describe('the F1 score is the one LoCoMo publishes, and deterministic', () => {
  it('case, punctuation and articles do not count', () => {
    assert.equal(tokenF1('The Bank!', 'bank'), 1);
  });
  it('extra words cost precision', () => {
    // pred {bank, in, paris} against {bank}: precision 1/3, recall 1 → 0.5
    assert.equal(tokenF1('a bank in Paris', 'bank'), 0.5);
  });
  it('an empty answer scores zero, not NaN', () => {
    assert.equal(tokenF1('', 'bank'), 0);
  });
  it('multi-hop (category 1) scores each comma-separated part and averages', () => {
    assert.equal(locomoF1('Paris, London', 'London, Paris', 1), 1);
    assert.equal(locomoF1('Paris', 'Paris, London', 1), 0.5);
  });
  it('open-domain (category 3) scores against the part before the semicolon', () => {
    assert.equal(locomoF1('yes', 'yes; because she said so', 3), 1);
  });
});

describe('the answerer cannot read the key', () => {
  it('no input file carries an answer, a reference, an adversarial answer or the evidence', () => {
    prepare();
    const files = readdirSync(join(dir, 'input'));
    assert.ok(files.length >= 2, `no input files written: ${files}`);
    for (const f of files) {
      const text = readFileSync(join(dir, 'input', f), 'utf8');
      for (const leak of ['REFKEY', '"answer"', 'adversarial', 'evidence', 'reference', 'D1:1']) {
        assert.ok(!text.includes(leak), `${f} carries ${leak} — the answerer would be reading the key`);
      }
    }
  });

  it('category 5 is left out, and ids are the release positions so they survive that', () => {
    const { ids } = prepare();
    assert.deepEqual(SCORED_CATEGORIES, [1, 2, 3, 4]);
    assert.deepEqual(ids, ['conv-x#0', 'conv-x#2']);
  });

  it('the baseline input is the whole history; the memory input is each question\'s own hits', () => {
    prepare();
    const base = JSON.parse(readFileSync(join(dir, 'input', 'conv-x.baseline.json'), 'utf8'));
    const mem = JSON.parse(readFileSync(join(dir, 'input', 'conv-x.memory.json'), 'utf8'));
    assert.match(base.context, /bank/);
    assert.match(base.context, /dance studio/);
    assert.equal(mem.questions[0].context[0].text, 'about Where did Jon work?');
    assert.equal(mem.questions.length, 2);
  });
});

describe('a rate limit costs one file, never the run', () => {
  it('status says exactly which files are still owed', () => {
    prepare();
    assert.deepEqual(answerStatus(dir, ['conv-x']), { 'conv-x': { memory: 'missing', baseline: 'missing' } });
    writeAnswers(dir, 'conv-x', 'memory', { 'conv-x#0': 'at a bank', 'conv-x#2': 'a studio' });
    assert.deepEqual(answerStatus(dir, ['conv-x']), { 'conv-x': { memory: 'done', baseline: 'missing' } });
  });

  it('prepare does not redo a conversation whose inputs are already written', () => {
    prepare();
    let asked = 0;
    const r = prepareConversation({
      runDir: dir, conversation, questions, hitsFor: (q) => { asked++; return hitsFor(q); },
      retrieval: { topK: 10, traverse: 1 },
    });
    assert.equal(asked, 0, 'retrieval ran again for a conversation that was already prepared');
    assert.equal(r.skipped, true);
  });

  it('an answer file missing a question is refused, not read as done', () => {
    prepare();
    writeAnswers(dir, 'conv-x', 'memory', { 'conv-x#0': 'at a bank' });
    assert.match(answerStatus(dir, ['conv-x'])['conv-x'].memory, /missing.*conv-x#2/);
    assert.throws(() => readAnswers(dir, 'conv-x', 'memory'), /conv-x#2/);
  });

  it('an answer file made from a DIFFERENT input is refused', () => {
    prepare();
    writeAnswers(dir, 'conv-x', 'memory', { 'conv-x#0': 'a', 'conv-x#2': 'b' });
    // The input changes under it — a re-prepare after the space was rewritten, say.
    const p = join(dir, 'input', 'conv-x.memory.json');
    const input = JSON.parse(readFileSync(p, 'utf8'));
    input.questions[0].context = [];
    writeFileSync(p, JSON.stringify(input));
    assert.match(answerStatus(dir, ['conv-x'])['conv-x'].memory, /different input/);
  });

  it('a half-written answer file cannot exist: the write is atomic', () => {
    prepare();
    writeAnswers(dir, 'conv-x', 'baseline', { 'conv-x#0': 'a', 'conv-x#2': 'b' });
    const leftovers = readdirSync(join(dir, 'answers')).filter(f => !f.endsWith('.json'));
    assert.deepEqual(leftovers, [], 'a temporary file was left behind');
  });
});

describe('the judge is blind to the arm and cannot shorten the run quietly', () => {
  const graded = () => {
    prepare();
    writeAnswers(dir, 'conv-x', 'memory', { 'conv-x#0': 'at a bank', 'conv-x#2': 'a dance studio' });
    writeAnswers(dir, 'conv-x', 'baseline', { 'conv-x#0': 'no idea', 'conv-x#2': 'a studio' });
    return exportJudgeBatches({ runDir: dir, conversations: ['conv-x'], questions, perCategory: 50, batchSize: 3 });
  };

  it('the sample is balanced per category and the same every time', () => {
    const pool = Array.from({ length: 300 }, (_, i) => ({ id: `c#${i}`, category: 1 + (i % 4) }));
    const a = sampleForJudge(pool, { perCategory: 50, seed: 'run-1' });
    const b = sampleForJudge(pool, { perCategory: 50, seed: 'run-1' });
    assert.deepEqual(a, b, 'the sample must be reproducible from its seed');
    for (const c of [1, 2, 3, 4]) assert.equal(a.filter(x => x.category === c).length, 50);
  });

  it('a batch names no arm, and no id reveals one', () => {
    const { batches } = graded();
    const text = batches.map(b => readFileSync(b, 'utf8')).join('\n');
    assert.ok(!/memory|baseline|conv-x#/i.test(text), 'the judge can see which arm or which question');
    assert.match(text, /J0001/);
  });

  it('batches are capped at the batch size', () => {
    const { batches, items } = graded();
    assert.equal(items, 4);
    assert.equal(batches.length, 2, 'four items at three per batch is two batches');
  });

  it('a truncated reply leaves the rest UNGRADED, never wrong', () => {
    const { batches } = graded();
    const ids = [...readFileSync(batches[0], 'utf8').matchAll(/^(J\d{4})/gm)].map(m => m[1]);
    const r = importJudgeReply(dir, 1, `${ids[0]} correct\n`);
    assert.deepEqual(r.graded, 1);
    assert.deepEqual(r.missing, ids.slice(1));
    assert.equal(judgeStatus(dir).ungraded, 3);
  });

  it('a word other than correct or incorrect is refused for that line, and so is an id from another batch', () => {
    const { batches } = graded();
    const ids = [...readFileSync(batches[0], 'utf8').matchAll(/^(J\d{4})/gm)].map(m => m[1]);
    const r = importJudgeReply(dir, 1, `${ids[0]} probably\n${ids[1]} correct\nJ0004 correct\n`);
    assert.equal(r.graded, 1);
    assert.ok(r.invalid.some(x => x.includes(ids[0])), JSON.stringify(r.invalid));
    assert.ok(r.invalid.some(x => x.includes('J0004')), 'an id belonging to another batch was accepted');
  });

  it('a reply wrapped in chat prose still parses, line by line', () => {
    const { batches } = graded();
    const ids = [...readFileSync(batches[0], 'utf8').matchAll(/^(J\d{4})/gm)].map(m => m[1]);
    const reply = `Here are the verdicts:\n\n${ids.map(i => `- **${i}**: Correct`).join('\n')}\n\nLet me know!`;
    assert.equal(importJudgeReply(dir, 1, reply).graded, ids.length);
  });

  it('an imported batch is on disk, so a second session sees it', () => {
    const { batches } = graded();
    const ids = [...readFileSync(batches[0], 'utf8').matchAll(/^(J\d{4})/gm)].map(m => m[1]);
    importJudgeReply(dir, 1, ids.map(i => `${i} incorrect`).join('\n'));
    assert.ok(existsSync(join(dir, 'verdicts', 'batch-1.json')));
    assert.equal(judgeStatus(dir).batches[0].state, 'done');
    assert.equal(judgeStatus(dir).batches[1].state, 'missing');
  });
});

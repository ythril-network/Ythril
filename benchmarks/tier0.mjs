#!/usr/bin/env node
/**
 * A graded Tier 0 run, as files: prepare → answer → score → judge → report (`B-6`).
 *
 * ## Why this is not a verb of `bench.mjs`
 *
 * `bench.mjs` is what extraction runs from, and `the-bench-cli-reads-the-corpus-through-the-loader.test.js`
 * forbids it from ever importing `loadQuestions` — the release holds the answers, and an extractor that can
 * reach them is not blind. A graded run has to read the questions. So it is a separate entry point, the ONE
 * place the question set is loaded, and what it hands the answerer is checked to carry no key.
 *
 * ## Usage
 *
 *   YTHRIL_URL=… YTHRIL_TOKEN=… node benchmarks/tier0.mjs prepare [runId]
 *   node benchmarks/tier0.mjs status [runId]
 *   node benchmarks/tier0.mjs record <conv> <memory|baseline> <answers.json> [runId]
 *   node benchmarks/tier0.mjs score [runId]
 *   node benchmarks/tier0.mjs judge-export [runId]
 *   node benchmarks/tier0.mjs judge-import <batch> <reply.txt> [runId]
 *   node benchmarks/tier0.mjs report [runId]
 *
 * Every step reads and writes `benchmarks/.cache/runs/<runId>/`, and every step can be run again: `prepare`
 * skips what is prepared, `status` says what is owed. A rate limit costs the file in progress.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConversations, loadQuestions } from './locomo/loader.mjs';
import { retrieveAll } from './harness/retrieve.mjs';
import {
  prepareConversation, isPrepared, isArmPrepared, answerStatus, writeAnswers, scoredQuestions,
  exportJudgeBatches, importJudgeReply, judgeStatus,
} from './harness/file-run.mjs';
import { f1Scores, judgeScores } from './harness/score.mjs';
import { makeYthril } from './writer/ythril-client.mjs';

const RETRIEVAL = { topK: 10, traverse: 1 };
const die = (msg) => { console.error(msg); process.exit(1); };

function corpus() {
  const pin = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8'));
  const path = pin.datasets.locomo.cachePath;
  return { conversations: loadConversations(path), questions: loadQuestions(path) };
}
const runDirOf = (runId = 'tier0-1') => join('benchmarks', '.cache', 'runs', runId);
/** The space each conversation was written into by `bench.mjs write`. One convention, stated once. */
const spaceOf = (conversationId) => `locomo-${conversationId}`;

async function prepare(runId) {
  const baseUrl = process.env.YTHRIL_URL;
  const token = process.env.YTHRIL_TOKEN;
  if (!baseUrl || !token) die('prepare needs YTHRIL_URL and YTHRIL_TOKEN');
  const client = makeYthril({ baseUrl, token });
  // retrieve.mjs takes one request object; the client takes the space apart from the parameters.
  const ythril = { recall: ({ space, ...params }) => client.recall(space, params) };
  const runDir = runDirOf(runId);
  const { conversations, questions } = corpus();
  for (const conversation of conversations) {
    if (isPrepared(runDir, conversation.id)) { console.log(`${conversation.id}: already prepared`); continue; }
    const scored = scoredQuestions(questions, conversation.id);
    // Only the baseline is owed: no retrieval, and the memory input — and every answer on it — stays as it is.
    if (isArmPrepared(runDir, conversation.id, 'memory')) {
      prepareConversation({ runDir, conversation, questions, hitsFor: () => { throw new Error('unreachable'); }, retrieval: RETRIEVAL });
      console.log(`${conversation.id}: baseline prepared`);
      continue;
    }
    /*
     * NOT BEFORE THE SPACE IS SEARCHABLE. An embed queue still draining reads exactly like a poor retriever,
     * and a run would publish it as one. `waitForEmbeddings` throws rather than proceeds; that is caught as a
     * conversation not prepared, so the next `prepare` tries it again.
     */
    try {
      await client.waitForEmbeddings(spaceOf(conversation.id));
    } catch (err) {
      console.log(`${conversation.id}: not searchable yet, NOT prepared — ${err.message.split('\n')[0]}`);
      continue;
    }
    const results = await retrieveAll({
      ythril, space: spaceOf(conversation.id), questions: scored.map(q => q.question), ...RETRIEVAL,
    });
    /*
     * A FAILED RETRIEVAL IS NOT AN EMPTY CONTEXT. Writing the input anyway would hand the answerer `[]` for
     * a question nobody could ask, and score the memory as useless on it. Nothing is written for this
     * conversation, and the next `prepare` tries it again.
     */
    const failed = results.filter(r => r.error);
    if (failed.length > 0) {
      console.log(`${conversation.id}: ${failed.length} retrieval(s) failed, NOT prepared — first: ${failed[0].error}`);
      continue;
    }
    const byQuestion = new Map(results.map(r => [r.request.query, r.hits]));
    const { ids } = prepareConversation({
      runDir, conversation, questions, hitsFor: (q) => byQuestion.get(q), retrieval: RETRIEVAL,
    });
    console.log(`${conversation.id}: prepared ${ids.length} questions`);
  }
}

function status(runId) {
  const runDir = runDirOf(runId);
  const { conversations } = corpus();
  const st = answerStatus(runDir, conversations.map(c => c.id));
  for (const [c, arms] of Object.entries(st)) console.log(`  ${c.padEnd(9)} memory: ${arms.memory}   baseline: ${arms.baseline}`);
  try {
    const j = judgeStatus(runDir);
    for (const b of j.batches) console.log(`  judge batch ${b.batch}: ${b.state} (${b.graded}/${b.of})`);
  } catch { console.log('  judge: not exported yet'); }
}

function record(conv, arm, file, runId) {
  if (!conv || !['memory', 'baseline'].includes(arm) || !file) die('record <conv> <memory|baseline> <answers.json>');
  const answers = JSON.parse(readFileSync(file, 'utf8'));
  writeAnswers(runDirOf(runId), conv, arm, answers, process.env.ANSWERED_BY ?? null);
  console.log(`${conv} ${arm}: ${answerStatus(runDirOf(runId), [conv])[conv][arm]}`);
}

function score(runId) {
  const { conversations, questions } = corpus();
  const s = f1Scores({ runDir: runDirOf(runId), conversations: conversations.map(c => c.id), questions });
  const pct = (x) => (x === null ? '—' : (100 * x).toFixed(1));
  console.log('F1 (all scored questions)      n     memory  baseline  delta');
  console.log(`  overall                   ${String(s.overall.n).padStart(5)}  ${pct(s.overall.memory).padStart(7)}  ${pct(s.overall.baseline).padStart(8)}  ${pct(s.overall.delta).padStart(5)}`);
  for (const [cat, v] of Object.entries(s.byCategory)) {
    console.log(`  category ${cat}                ${String(v.n).padStart(5)}  ${pct(v.memory).padStart(7)}  ${pct(v.baseline).padStart(8)}  ${pct(v.delta).padStart(5)}`);
  }
  return s;
}

function judgeExport(runId) {
  const { conversations, questions } = corpus();
  const r = exportJudgeBatches({ runDir: runDirOf(runId), conversations: conversations.map(c => c.id), questions });
  console.log(`prompt: ${r.prompt}`);
  for (const b of r.batches) console.log(`batch:  ${b}`);
  console.log(`${r.items} items`);
}

function judgeImport(batch, file, runId) {
  if (!batch || !file) die('judge-import <batch> <reply.txt>');
  const r = importJudgeReply(runDirOf(runId), Number(batch), readFileSync(file, 'utf8'));
  console.log(`batch ${batch}: ${r.graded} graded, ${r.missing.length} missing, ${r.invalid.length} refused`);
  for (const x of r.invalid.slice(0, 10)) console.log(`  refused ${x}`);
}

function report(runId) {
  const runDir = runDirOf(runId);
  const f1 = score(runId);
  const j = judgeScores({ runDir });
  const pct = (x) => (x === null ? '—' : (100 * x).toFixed(1));
  console.log(`\nJudge accuracy (paired sample, n=${j.n})  memory ${pct(j.memory)}  baseline ${pct(j.baseline)}  `
    + `delta ${pct(j.delta)}  95% CI ${j.ci95 ? `${pct(j.ci95[0])} to ${pct(j.ci95[1])}` : '—'}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({
    retrieval: RETRIEVAL, f1, judge: j,
    answerer: process.env.ANSWERED_BY ?? null, judgeModel: process.env.JUDGE_MODEL ?? null,
    f1Note: 'token F1 with LoCoMo normalisation and category rules, without the Porter stemmer',
  }, null, 2));
}

/**
 * A slice of one input, compact, for whoever is answering it.
 *
 * Reads `input/` and nothing else — the answerer's whole view of the run. A convenience that also printed a
 * reference "to check against" would be the leak this directory is laid out to prevent.
 */
function show(conv, arm, from = '0', count = '25', runId) {
  const input = JSON.parse(readFileSync(join(runDirOf(runId), 'input', `${conv}.${arm}.json`), 'utf8'));
  const qs = input.questions.slice(Number(from), Number(from) + Number(count));
  if (arm === 'baseline' && Number(from) === 0) console.log(`${input.context}\n\n=== QUESTIONS ===`);
  for (const q of qs) {
    console.log(`\n${q.id} :: ${q.question}`);
    for (const h of q.context ?? []) {
      console.log(`  - ${h.via === 'traverse' ? `(${h.relation}) ` : ''}${h.superseded ? '[superseded] ' : ''}${h.when ? `[${h.when}] ` : ''}${h.text}`);
    }
  }
  console.log(`\n(${qs.length} of ${input.questions.length}, from ${from})`);
}

const [verb, ...rest] = process.argv.slice(2);
const verbs = {
  show: () => show(rest[0], rest[1], rest[2], rest[3], rest[4]),
  prepare: () => prepare(rest[0]),
  status: () => status(rest[0]),
  record: () => record(rest[0], rest[1], rest[2], rest[3]),
  score: () => score(rest[0]),
  'judge-export': () => judgeExport(rest[0]),
  'judge-import': () => judgeImport(rest[0], rest[1], rest[2]),
  report: () => report(rest[0]),
};
if (!verbs[verb]) die(`usage: tier0.mjs ${Object.keys(verbs).join('|')}`);
await verbs[verb]();

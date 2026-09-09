/**
 * The reporter for Tier 0-R, which is a different measurement from the one `report.mjs` reports.
 *
 * ## Why this is a second file and not a flag on the first
 *
 * `report.mjs` refuses a row without a `prediction` and a `lexical.f1`, and it is right to: in a graded tier a
 * row without them is a score nobody can check. **A Tier 0-R row has neither, and that is not a deficiency —
 * it is the tier.** There is no answerer, so there is no prediction to grade; the question asked is only
 * whether the evidence came back.
 *
 * Bending the graded reporter to accept rows it was built to reject would weaken the refusals for every tier,
 * to serve a tier that needs different columns anyway. So the graded reporter stays strict about graded runs,
 * and this file reports the retrieval-only one.
 *
 * ## What this report may claim, and what it may not
 *
 * `PROTOCOL.md` Amendment 4 defines the metric and, more usefully, the four things it cannot say. Those are
 * reprinted into every report this file writes, in the report itself rather than in a footnote — a number
 * travels further than the document that qualifies it, so the qualification travels attached to the number.
 *
 * In short: **recall is not accuracy.** A retrieved turn does not mean a model would answer from it, an
 * unretrieved one may still be answerable from elsewhere in the transcript, and a configuration that retrieves
 * more of everything scores better here while being worse in use.
 */
import { ceilingSentence, evidenceShape } from './evidence-shape.mjs';
import { stratifiedSample } from './sample.mjs';
import { loadQuestions } from './dataset/locomo.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** LoCoMo's category numbers, as the release names them. */
const CATEGORY_NAMES = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

/** Mean of a numeric list, or null for an empty one — never 0, which would read as a measured zero. */
function mean(xs) {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Group rows and score each group.
 *
 * `all` is the strict metric: every cited evidence turn came back. `any` is the loose one. Both are reported
 * because they answer different questions and quoting only one is how a retrieval number gets oversold — `any`
 * flatters multi-evidence questions, `all` punishes them, and the gap between the two IS the multi-hop story.
 */
function score(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [key, rs] of groups) {
    /*
     * The reciprocal rank of the FIRST evidence hit, and a miss counts 0 rather than being dropped.
     *
     * Dropping it would average only over the questions that worked, so a rung that answered thirty
     * questions brilliantly and lost the other hundred and sixty would out-score one that answered all of
     * them adequately. That is the same flattery the coverage metric gives, arriving through the denominator.
     */
    const rr = rs.map(r => (r.firstHitRank ? 1 / r.firstHitRank : 0));
    const depths = rs.map(r => r.depth).filter(d => typeof d === 'number');
    const tops = rs.map(r => r.topChars).filter(c => typeof c === 'number');
    out.push({
      key,
      n: rs.length,
      allAt1: rs.filter(r => r.allAtRank1).length,
      /*
       * Everything the answer cites, inside the first three results.
       *
       * A middle ground with a real reader behind it: rank 1 is the strict question and `mean depth` is
       * skewed by the few questions that need the twentieth record, so neither says how often a caller gets
       * what they came for from a glance. Three is bounded tightly enough that it cannot be won by padding —
       * three records still fit in a screen, and `top record chars` catches the strategy of making them huge.
       */
      allWithin3: rs.filter(r => typeof r.depth === 'number' && r.depth <= 3).length,
      mrr: mean(rr),
      meanDepth: mean(depths),
      meanTopChars: mean(tops),
      all: rs.filter(r => r.allEvidence).length,
      any: rs.filter(r => r.anyEvidence).length,
      meanRecords: mean(rs.map(r => r.records ?? r.retrieved)),
      meanRetrieved: mean(rs.map(r => r.retrieved)),
      meanMs: mean(rs.map(r => r.ms)),
    });
  }
  return out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function table(header, rows) {
  const head = `| ${header.join(' | ')} |`;
  const rule = `|${header.map(() => '---').join('|')}|`;
  return [head, rule, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

export function tier0rMarkdown({ rows, meta }) {
  const rungs = [...new Set(rows.map(r => r.rung))];
  const lines = [];

  lines.push('# Tier 0-R — evidence recall, no model anywhere');
  lines.push('');
  lines.push(`**Run:** ${meta.date} · commit \`${meta.commit}\` · ${meta.image}`);
  lines.push(`**Dataset:** LoCoMo, sha256 \`${meta.datasetSha.slice(0, 16)}…\``);
  lines.push(`**Questions:** ${meta.sampled} sampled from ${meta.answerable} answerable`
    + `${meta.excluded ? ` (${meta.excluded} excluded: no evidence cited)` : ''}`);
  lines.push(`**Retrieval:** \`recall\` at the shipped default, \`topK: ${meta.topK}\`, no traverse, no threshold`);
  lines.push(`**Model calls:** 0`);
  lines.push(ceilingSentence(meta.shape));
  lines.push('');

  lines.push('## What this measures, and what it does not');
  lines.push('');
  lines.push('For each question, the turns the gold answer cites as evidence are known. The retrieval is run and');
  lines.push('the question asked is: **did those turns come back?** That is all. Specifically:');
  lines.push('');
  lines.push('- **Recall is not accuracy.** A retrieved turn does not mean a model would answer correctly from it.');
  lines.push('- **A miss is not necessarily a failure.** The same fact is often restated elsewhere in the');
  lines.push('  transcript, so an answer may be available from a turn the gold key does not cite.');
  lines.push('- **The headline is rank 1, because coverage can be brute-forced and rank cannot.** The owner ruled it');
  lines.push('  on 2026-09-06: *"first answer must be right - it must reflect reality, not brute force."*');
  lines.push('  Whether the evidence appeared *somewhere* in twenty results is a weak question — a strategy that');
  lines.push('  packs more of the conversation into every record wins it without ever having ranked the right');
  lines.push('  thing first, and a caller still has to read all twenty. `all at rank 1` asks whether the single');
  lines.push('  top result held everything the answer cites. There is only one first result, so nothing can be');
  lines.push('  padded into it.');
  lines.push('- **And `all at rank 1` has its own cheat, which the column beside it closes.** One record holding');
  lines.push('  the entire conversation would rank first and contain every evidence turn, scoring perfectly while');
  lines.push('  doing no retrieval at all. `top record chars` is how big that first result was: a high rank-1');
  lines.push('  score next to a large top record is a transcript being handed back, not a question being');
  lines.push('  answered. Read the two together or neither means anything.');
  lines.push('- **`mean depth` is what a caller actually pays.** How far down the list they had to read before');
  lines.push('  holding all the evidence. A strategy can raise `all evidence` from 66% to 90% while pushing this');
  lines.push('  from 4 to 18 — worse retrieval, sold as better.');
  lines.push('- **"Adversarial" does not mean unanswerable here.** Category 5 is named adversarial and it is easy to');
  lines.push('  assume that means the answer is absent from the transcript — it is not. In this release all 446 of');
  lines.push('  them cite evidence and carry a real answer, in a separate `adversarial_answer` field rather than');
  lines.push('  the usual one. They score like any other single-hop category and are read that way below.');
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  lines.push(table(
    ['rung', 'questions', 'all at rank 1', 'top record chars', 'all within 3', 'MRR', 'mean depth',
      'all evidence', 'any evidence', 'mean records', 'mean turns covered', 'mean ms'],
    score(rows, r => r.rung).map(g => [
      `\`${g.key}\``, g.n, `**${pct(g.allAt1, g.n)}**`, g.meanTopChars?.toFixed(0) ?? '—',
      pct(g.allWithin3, g.n), g.mrr?.toFixed(3) ?? '—', g.meanDepth?.toFixed(1) ?? '—',
      pct(g.all, g.n), pct(g.any, g.n),
      g.meanRecords?.toFixed(1) ?? '—', g.meanRetrieved?.toFixed(1) ?? '—', g.meanMs?.toFixed(0) ?? '—',
    ]),
  ));
  lines.push('');

  lines.push('## By question category');
  lines.push('');
  for (const rung of rungs) {
    lines.push(`**\`${rung}\`**`);
    lines.push('');
    lines.push(table(
      ['category', 'questions', 'all at rank 1', 'all within 3', 'MRR', 'all evidence', 'any evidence'],
      score(rows.filter(r => r.rung === rung), r => r.category).map(g => [
        `${g.key} — ${CATEGORY_NAMES[g.key] ?? '?'}`, g.n, `**${pct(g.allAt1, g.n)}**`,
        pct(g.allWithin3, g.n), g.mrr?.toFixed(3) ?? '—', pct(g.all, g.n), pct(g.any, g.n),
      ]),
    ));
    lines.push('');
  }

  lines.push('## By how much evidence the question needs');
  lines.push('');
  lines.push('The column that matters most. A question citing one turn needs one hit; a question citing four needs');
  lines.push('all four before `all evidence` counts it. If the strict score falls away as the evidence count rises,');
  lines.push('that is the multi-hop weakness the graph is supposed to address — and it is measurable here, before');
  lines.push('any model is involved.');
  lines.push('');
  for (const rung of rungs) {
    lines.push(`**\`${rung}\`**`);
    lines.push('');
    lines.push(table(
      ['evidence turns', 'questions', 'all at rank 1', 'mean depth', 'all evidence', 'any evidence'],
      score(rows.filter(r => r.rung === rung), r => Math.min(r.evidenceCount, 5)).map(g => [
        g.key === 5 ? '5 or more' : g.key, g.n, `**${pct(g.allAt1, g.n)}**`,
        g.meanDepth?.toFixed(1) ?? '—', pct(g.all, g.n), pct(g.any, g.n),
      ]),
    ));
    lines.push('');
  }

  lines.push('## Per conversation');
  lines.push('');
  lines.push('Included because a mean over ten conversations can hide one that failed completely, and a reader who');
  lines.push('cannot see the spread has to take the mean on trust.');
  lines.push('');
  for (const rung of rungs) {
    lines.push(`**\`${rung}\`**`);
    lines.push('');
    lines.push(table(
      ['conversation', 'questions', 'all evidence', 'any evidence'],
      score(rows.filter(r => r.rung === rung), r => r.conversationId).map(g => [
        g.key, g.n, pct(g.all, g.n), pct(g.any, g.n),
      ]),
    ));
    lines.push('');
  }

  return lines.join('\n');
}

/** CLI: node benchmarks/harness/report-tier0r.mjs <rows.json> <outDir> [--commit x] [--image y] [--sha z] */
// Run directly? Compare resolved URLs rather than matching path text: a substring compare needs a
// placeholder for the no-argv case, and that placeholder is how a raw NUL got into this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rowsPath, outDir] = process.argv.slice(2);
  if (!rowsPath || !outDir) {
    console.error('usage: report-tier0r.mjs <rows.json> <outDir> [--commit x] [--image y] [--sha z] [--date d] --data <dataset> [--questions n] [--seed n]');
    process.exit(2);
  }
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
  /*
   * The ceiling is derived from the DATASET, not from the rows, because the rows do not say which session
   * each cited turn came from — and that is the whole question. Regenerating a report therefore needs the
   * same pinned dataset and the same seeded sample the run used, and refuses without them rather than
   * printing a score with no maximum beside it.
   */
  const dataPath = arg('data', '');
  if (!dataPath) {
    console.error('report-tier0r.mjs: --data <pinned dataset> is required — the ceiling beside the score is '
      + 'computed from where the evidence sits, which only the dataset knows.');
    process.exit(2);
  }
  const answerableQuestions = (await loadQuestions(dataPath)).filter(q => (q.evidence ?? []).length > 0);
  const shape = evidenceShape(
    stratifiedSample(answerableQuestions, Number(arg('questions', '200')), Number(arg('seed', '1'))),
  );
  const md = tier0rMarkdown({
    rows,
    meta: {
      date: arg('date', 'unknown'),
      commit: arg('commit', 'unknown'),
      image: arg('image', 'unknown'),
      datasetSha: arg('sha', 'unknown'),
      sampled: Number(arg('sampled', String(new Set(rows.map(r => `${r.conversationId}#${r.category}#${r.evidenceCount}`)).size))),
      answerable: Number(arg('answerable', '0')),
      excluded: Number(arg('excluded', '0')),
      topK: Number(arg('topk', '20')),
      shape,
    },
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'REPORT.md'), md);
  console.log(`wrote ${join(outDir, 'REPORT.md')}`);
}

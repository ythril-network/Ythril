/**
 * The Tier 0-R headline must be a RANK, and the rank must be readable beside what it cost.
 *
 * ## What this gate is defending
 *
 * A retrieval score can be raised two ways. One is to rank the right thing first. The other is to return more
 * of the conversation per record, so the evidence gets swept up somewhere inside `topK` — and the second way
 * is much easier, produces a much bigger number, and is not retrieval. Owner's ruling, 2026-09-06: *"do not
 * cheat... first answer must be right - it must reflect reality, not brute force."*
 *
 * The failure is not that a coverage number is wrong. It is that a coverage number is TRUE and means almost
 * nothing, so it survives every review by being accurate. This gate exists because the honest metric had to be
 * added back after the dishonest one had already been quoted.
 *
 * ## The two cheats, and the two columns that close them
 *
 * 1. **Pack more into each record.** Beaten by asking about rank 1 — there is only one first result.
 * 2. **Make the first record enormous.** A single record holding the whole transcript ranks first, contains
 *    every evidence turn, and scores 100% while doing no retrieval at all. Beaten by printing how big that
 *    first record was, right next to the score it produced.
 *
 * Neither column is meaningful alone, which is why this asserts BOTH are present and both are in the headline
 * table rather than somewhere further down where a reader quoting the top line would miss them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evidenceShape } from '../../benchmarks/harness/evidence-shape.mjs';
import { tier0rMarkdown } from '../../benchmarks/harness/report-tier0r.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerSource = readFileSync(join(repoRoot, 'benchmarks', 'harness', 'run-tier0r.mjs'), 'utf8');

const META = {
  date: '2026-09-06',
  commit: 'test',
  image: 'test',
  datasetSha: '0'.repeat(64),
  sampled: 2,
  answerable: 2,
  excluded: 0,
  topK: 20,
  // The report refuses to render without one: a rank-1 score with no ceiling beside it cannot be read
  // as near or far from the maximum. Two questions, one of them cross-session, so the ceiling is 50%.
  shape: evidenceShape([{ evidence: ['D1:1'] }, { evidence: ['D1:2', 'D4:9'] }]),
};

/** A row shaped like the runner writes one, with only the fields this gate cares about varied. */
function row(over) {
  return {
    rung: 's0x',
    conversationId: 'conv-1',
    category: 4,
    evidenceCount: 1,
    allEvidence: true,
    anyEvidence: true,
    allAtRank1: false,
    anyAtRank1: false,
    depth: 20,
    firstHitRank: 20,
    topChars: 300,
    records: 20,
    retrieved: 20,
    chars: 20000,
    truncated: false,
    ms: 100,
    scores: [0.5],
    ...over,
  };
}

test('the runner records WHERE the evidence ranked, not only that it came back', () => {
  for (const field of ['allAtRank1', 'depth', 'firstHitRank', 'topChars']) {
    assert.ok(
      new RegExp(`\\b${field}\\b`).test(runnerSource),
      `run-tier0r.mjs no longer records \`${field}\`. Without it the tier can only report whether the `
      + 'evidence appeared somewhere in topK, which is the number a chunking strategy inflates for free.',
    );
  }
});

test('the headline table leads with rank 1 and shows the size of that first record', () => {
  const md = tier0rMarkdown({ rows: [row({})], meta: META });
  const header = md.split('\n').find(l => l.startsWith('| rung |'));
  assert.ok(header, 'the Overall table lost its header row');

  const columns = header.split('|').map(c => c.trim()).filter(Boolean);
  const rank1 = columns.indexOf('all at rank 1');
  const topChars = columns.indexOf('top record chars');
  const coverage = columns.indexOf('all evidence');

  // `coverage` is checked for presence before it is compared, or `rank1 < coverage` passes vacuously the
  // moment the column is renamed: `indexOf` answers -1, and -1 is less than nothing.
  assert.ok(coverage > -1, 'the Overall table has no `all evidence` column, so the ordering assertion '
    + 'below would pass against a -1 and prove nothing');
  assert.ok(rank1 > -1, 'the Overall table has no `all at rank 1` column — the headline is coverage again');
  assert.ok(topChars > -1, 'the Overall table has no `top record chars` column, so a rank-1 score of 100% '
    + 'from one record holding the whole transcript would read as perfect retrieval');
  assert.ok(rank1 < coverage, 'coverage is printed before rank, so it is what a reader quotes');
  assert.equal(topChars, rank1 + 1, 'the cost of the first record must sit beside the score it earned; '
    + 'separated, the score gets quoted alone');
});

test('coverage cannot stand in for rank — two runs that differ only in rank report differently', () => {
  const deep = tier0rMarkdown({ rows: [row({}), row({})], meta: META });
  const shallow = tier0rMarkdown({
    rows: [row({ allAtRank1: true, anyAtRank1: true, depth: 1, firstHitRank: 1 }),
      row({ allAtRank1: true, anyAtRank1: true, depth: 1, firstHitRank: 1 })],
    meta: META,
  });

  // Identical on the old metric: both found all the evidence, on every question. Read by COLUMN NAME rather
  // than by counting `100.0%` in the line, because the rank columns are percentages too — a count would
  // differ for exactly the reason this assertion is trying to hold constant.
  const cellsOf = md => {
    const lines = md.split('\n');
    const header = lines.find(l => l.startsWith('| rung |')).split('|').map(c => c.trim());
    const values = lines.find(l => l.startsWith('| `s0x` |')).split('|').map(c => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, values[i]]));
  };
  const [deepCells, shallowCells] = [cellsOf(deep), cellsOf(shallow)];
  for (const column of ['all evidence', 'any evidence']) {
    assert.equal(deepCells[column], shallowCells[column],
      `the two fixtures were built to be indistinguishable on \`${column}\`; if they are not, this gate `
      + 'is no longer testing what it claims');
  }

  // ...and they must not be identical on the report, or the rank work is invisible.
  assert.notEqual(
    deep.split('\n').find(l => l.startsWith('| `s0x` |')),
    shallow.split('\n').find(l => l.startsWith('| `s0x` |')),
    'a run whose evidence arrived at rank 20 reports the same headline as one where it arrived first',
  );
});

test('a question whose evidence never came back does not average in as a good rank', () => {
  /*
   * The trap this catches is a `?? 0` on a miss. A missed question has no rank at all, and the reciprocal of
   * a missing rank is 0 — but the DEPTH of a miss is not 0, it is undefined, and averaging a 0 in there would
   * make a rung that lost half its questions look shallower than one that answered all of them.
   */
  const md = tier0rMarkdown({
    rows: [
      row({ allAtRank1: true, depth: 1, firstHitRank: 1 }),
      row({ allEvidence: false, anyEvidence: false, depth: null, firstHitRank: null }),
    ],
    meta: META,
  });
  // By column NAME. Read by position, this assertion silently moved to a different column the first time
  // one was inserted before it, and went on passing against whatever landed there.
  const lines = md.split('\n');
  const header = lines.find(l => l.startsWith('| rung |')).split('|').map(c => c.trim());
  const values = lines.find(l => l.startsWith('| `s0x` |')).split('|').map(c => c.trim());
  const depth = values[header.indexOf('mean depth')];
  assert.equal(depth, '1.0', `mean depth read \`${depth}\`; a miss must be excluded from the mean, not `
    + 'counted as a depth of zero');
});

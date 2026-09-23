/**
 * A ranked recall has ONE order for one corpus, and every ranking sort goes through the same comparator.
 *
 * ## What it is for
 *
 * `Array.prototype.sort` is stable, so a comparator returning 0 for two results leaves them in the order the
 * INPUT had — and that input is whatever the database returned. ELEVEN hand-written comparators — seven in
 * `recall.ts`, two in `recall-shape.ts`, and one member-space merge on each door — meant two identical recalls
 * over an unchanged corpus could come back in different orders, with nothing anywhere saying which.
 *
 * That was survivable while an answer was always whole. `skip` ended it: a caller continues from `returned`, so
 * a permutation between two pages repeats some matches and drops others, silently. Caught by the paging E2E on
 * 28 near-identically-scored records, where page two turned out to be entirely contained in page one.
 *
 * ## Both halves, because either alone is weak
 *
 * The comparator is exercised — a deliberately tied fixture, shuffled, must sort to one answer. And the SOURCE
 * is gated, because the defect was eleven copies of a rule rather than a wrong rule: a twelfth would be added by
 * someone who never saw this file, and it would look exactly like the eleven.
 *
 * Run: node --test testing/standalone/ranked-order-is-deterministic.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { byIdAsc, byRankThenId, rankOf } = await import('../../server/dist/brain/recall-shape.js');

describe('the comparator orders a tie the same way every time', () => {
  /** Twelve results, ALL on the same score — the case the old comparator left to the database. */
  const tied = () => Array.from({ length: 12 }, (_, i) => ({
    _id: `id-${String(i).padStart(2, '0')}`, type: 'entity', score: 0.5,
  }));

  it('a tie is broken by _id, ascending', () => {
    const sorted = [...tied()].reverse().sort(byRankThenId).map(r => r._id);
    assert.deepEqual(sorted, tied().map(r => r._id),
      'a fully tied set must sort to one order regardless of the order it arrived in');
  });

  it('and any input permutation lands on that same order', () => {
    // The property the feature needs is not "sorted" — it is "the SAME sorted". Several distinct input
    // permutations, one expected output.
    const want = [...tied()].sort(byRankThenId).map(r => r._id);
    const rotate = (arr, n) => [...arr.slice(n), ...arr.slice(0, n)];
    for (const n of [1, 3, 5, 7, 11]) {
      const got = rotate(tied(), n).sort(byRankThenId).map(r => r._id);
      assert.deepEqual(got, want, `rotation by ${n} produced a different order`);
    }
    const swapped = tied();
    [swapped[0], swapped[11]] = [swapped[11], swapped[0]];
    assert.deepEqual(swapped.sort(byRankThenId).map(r => r._id), want, 'a single swap changed the answer');
  });

  it('score still wins over the tie-break', () => {
    // The tie-break must be a tie-BREAK. If it ever outranked the score the ranking would be alphabetical,
    // which would pass every determinism assertion above while destroying the feature.
    const rows = [
      { _id: 'zzz', type: 'entity', score: 0.9 },
      { _id: 'aaa', type: 'entity', score: 0.1 },
    ];
    assert.deepEqual(rows.sort(byRankThenId).map(r => r._id), ['zzz', 'aaa'],
      'the higher score must come first even when its id sorts later');
  });

  it('and the RANK is the effective one, not `score`', () => {
    // `rerankScore > fusedScore > score` is the precedence, so a comparator reading `score` would order by a
    // number that did not rank the results — the defect 3.2.0 fixed by making the stage scores unconditional.
    const rows = [
      { _id: 'a', type: 'entity', score: 0.9, rerankScore: 0.1 },
      { _id: 'b', type: 'entity', score: 0.1, rerankScore: 0.9 },
    ];
    assert.equal(rankOf(rows[1]), 0.9, 'rankOf must prefer the rerank score');
    assert.deepEqual(rows.sort(byRankThenId).map(r => r._id), ['b', 'a'],
      'the reranked order must win, or the last ranking stage is discarded at the sort');
  });

  it('byIdAsc is a total order — no pair returns 0 unless the ids are equal', () => {
    // A tie-break that can itself tie is not one. This is why it is `_id` and not `seq` or `createdAt`.
    assert.equal(byIdAsc({ _id: 'a' }, { _id: 'b' }), -1);
    assert.equal(byIdAsc({ _id: 'b' }, { _id: 'a' }), 1);
    assert.equal(byIdAsc({ _id: 'a' }, { _id: 'a' }), 0);
  });
});

describe('no ranking sort is written by hand', () => {
  /*
   * BOTH DOORS TOO, and they are the ones that matter most.
   *
   * `all.sort(...)` in each route/tool is the member-space merge — the LAST sort before the response, so a tie
   * left to the database order there is precisely what a paging caller sees as a repeated record. A sweep
   * scoped to `brain/` would have said the ranking was deterministic while the final sort was not, which is
   * the reported-place-only mistake this repo keeps paying for.
   */
  const FILES = [
    'server/src/brain/recall.ts', 'server/src/brain/recall-shape.ts',
    'server/src/api/brain/search.ts', 'server/src/mcp/tools/search.ts',
  ];

  it('the bare comparators are gone from every recall path', () => {
    /*
     * A TENTH COPY IS THE REGRESSION, not a wrong tenth copy.
     *
     * Every one of the eleven was locally correct and read as obviously right. The gate has to be on the SHAPE
     * — a comparator that ends at the score — because that is what the next person will write, and it is
     * indistinguishable from the eleven that were here.
     *
     * Comments are stripped first: `byRankThenId`'s own doc block quotes the banned expression to explain what
     * it replaced, and a source gate that fires on the explanation of the fix is a gate that punishes writing
     * one down.
     */
    for (const f of FILES) {
      const code = stripComments(readFileSync(f, 'utf8'));
      // The bare rank comparator, with nothing after it.
      assert.doesNotMatch(code, /rankOf\(b\) - rankOf\(a\)\s*\)/,
        `${f} sorts by rank with no tie-break — use byRankThenId, or two identical recalls can differ`);
      assert.doesNotMatch(code, /\(b\.score \?\? 0\) - \(a\.score \?\? 0\)\s*\)/,
        `${f} sorts by score with no tie-break — use byRankThenId`);
      assert.doesNotMatch(code, /b\.score - a\.score\s*\)/,
        `${f} sorts by score with no tie-break`);
    }
  });

  it('and the comparator is actually used, wherever a ranking is still assembled', () => {
    /*
     * The mirror of the check above: satisfying it by deleting the sorts would be worse than the defect.
     *
     * Scoped to the files that still RANK, rather than to all four by name. `api/brain/search.ts` stopped
     * ranking anything when `POST /api/brain/recall` collapsed onto `callTool` — it has no results to
     * merge, so it references no comparator and correctly should not. Demanding the name there is
     * demanding the deleted duplicate back, and that is a gate arguing against its own subject.
     *
     * A file is "still ranking" if it sorts or merges results at all. A file that does neither has nothing
     * to be non-deterministic about, and the check above already refuses it a bare comparator if it grows
     * one.
     */
    const ranks = code => /\.sort\(|mergeRecallResults/.test(code);
    const ranking = FILES.filter(f => ranks(stripComments(readFileSync(f, 'utf8'))));
    assert.ok(ranking.length >= 2,
      `only ${ranking.length} of the recall files still assemble a ranking — the scan is broken, not the code`);
    for (const f of ranking) {
      const code = stripComments(readFileSync(f, 'utf8'));
      assert.match(code, /byRankThenId/,
        `${f} no longer references the shared comparator — satisfying the check above by deleting the sort `
        + 'would be worse than the defect');
    }
  });

  it('every remaining comparator in the recall paths ends in a tie-break', () => {
    /*
     * Scoped from the SHAPE rather than from a list of names.
     *
     * Two of the sorts rank things that are not `RecallResult` — a lexical hit by `lexicalScore`, an id list by
     * a looked-up score — so they cannot take `byRankThenId` and had `|| byIdAsc(...)` appended instead. A gate
     * that only banned the three known expressions would say nothing about those, and they are exactly where
     * a future tie-break gets forgotten, because they each look like a one-off.
     */
    for (const f of FILES) {
      const code = stripComments(readFileSync(f, 'utf8'));
      const inline = [...code.matchAll(/\.sort\(\((?:a, b|a,b)\) => ([^\n]*)\)/g)];
      for (const m of inline) {
        const body = m[1];
        assert.match(body, /\|\|/,
          `${f}: an inline ranking comparator with no tie-break — \`${body.trim().slice(0, 90)}\`. Every sort `
          + 'that decides the order a caller sees must end in one, or `skip` can repeat a record.');
      }
      // Counted rather than listed, the same way `hybrid-retrieval.test.js` counts its raw-score sorts: a NEW
      // inline comparator has to come here and justify itself. Five survive in `recall.ts`, and the candidate
      // cap (5 below) moved to `rerank-pool.ts` with the rerank step (`P-35`). Each has a reason it cannot
      // take the shared one —
      //   1-3. the pre-fusion sort, the vector channel handed to RRF, and `findSimilar`, all of which must
      //        order by RAW score rather than by `rankOf` (see `hybrid-retrieval.test.js`, which counts them);
      //     4. the lexical channel, ordered by `lexicalScore`;
      //     5. the candidate cap in `rerank-pool.ts`, which sorts a list of ID STRINGS through a lookup, so
      //        there is no object to hand a comparator;
      //     6. the duplicate-match map, whose `score` is non-optional and not a `RecallResult`.
      // Everything that CAN take `byRankThenId` does, which is why the other three files have none.
      const expected = f.endsWith('brain/recall.ts') ? 5 : 0;
      assert.equal(inline.length, expected,
        `${f} has ${inline.length} inline comparators, expected ${expected} — a new one needs a reason it `
        + 'cannot use byRankThenId, written down here');
    }
  });

  it('the rerank candidate cap still ends in a tie-break, in its own module', () => {
    // Comparator 5 above, moved out of `recall.ts` with the rerank step (`P-35`). It sorts ids, not results,
    // so it cannot take `byRankThenId` — which is why it is checked here and not in FILES, where every file
    // must reference the shared comparator.
    const code = stripComments(readFileSync('server/src/brain/rerank-pool.ts', 'utf8'));
    const inline = [...code.matchAll(/\.sort\(\((?:a, b|a,b)\) => ([^\n]*)\)/g)];
    assert.equal(inline.length, 1, `rerank-pool.ts has ${inline.length} inline comparators, expected 1`);
    assert.match(inline[0][1], /\|\|/, 'the cap sort must end in a tie-break, or two calls can rerank different sets');
  });
});

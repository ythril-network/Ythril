/**
 * A record's lexical rank is its rank among records of its OWN type (`Q-159`).
 *
 * Owner, 2026-09-29: *"fused score seems wrong somehow, whats the math and is it correct? research"*. The math is
 * reciprocal rank fusion, `1/(60 + vector rank) + 1/(60 + lexical rank)`, and it discards magnitude on purpose: a
 * cosine and a MongoDB text score are on unrelated scales. But the lexical channel searched each type's collection
 * and then sorted every hit together by raw text score, which depends on each collection's field lengths and is
 * unbounded — the cross-scale comparison the fusion exists to avoid. A fact could outrank an entity lexically only
 * because facts are longer.
 *
 * Now each type's lexical ranking is its own channel: a record appears in one of them, so its lexical term is
 * `1/(60 + its rank within its type)`.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-lexical-rank-is-its-own-types-rank.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stampFusion, RRF_K } from '../../server/dist/brain/lexical-search.js';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const rrf = rank => 1 / (RRF_K + rank);

describe('a lexical rank is its own type\'s rank', () => {
  it('the best match of a type with low raw text scores still ranks first in its channel', () => {
    // Vector order: a1, a2, a3, b1. Lexically, type A's three hits all out-score type B's only hit on raw score.
    const pool = [{ _id: 'a1', score: 0.9 }, { _id: 'a2', score: 0.8 }, { _id: 'a3', score: 0.7 }, { _id: 'b1', score: 0.6 }];
    assert.equal(stampFusion(pool, [], [['a1', 'a2', 'a3'], ['b1']]), true);
    const b1 = pool.find(r => r._id === 'b1');
    assert.equal(b1.fusedScore, rrf(4) + rrf(1), 'b1 is fourth by meaning and FIRST among its own type by text');
    const a3 = pool.find(r => r._id === 'a3');
    assert.equal(a3.fusedScore, rrf(3) + rrf(3));
    assert.ok(b1.fusedScore > a3.fusedScore, 'the order no longer follows the other collection\'s scale');
  });

  it('every fused result carries the two ranks its fused score came from', () => {
    // A fused score alone cannot be checked by a reader; the ranks it was computed from can (`Q-159`).
    const pool = [{ _id: 'a1', score: 0.9 }, { _id: 'a2', score: 0.8 }, { _id: 'b1', score: 0.6 }];
    const floors = [{ _id: 'a2', score: 0.8 }];
    stampFusion(pool, floors, [['a2'], ['b1']]);
    for (const r of [...pool, ...floors]) {
      const lexical = r.lexicalRank === undefined ? 0 : rrf(r.lexicalRank);
      assert.equal(r.fusedScore, rrf(r.vectorRank) + lexical, `${r._id}: fusedScore is its two ranks, and nothing else`);
    }
    assert.deepEqual(pool.map(r => [r._id, r.vectorRank, r.lexicalRank]), [['a1', 1, undefined], ['a2', 2, 1], ['b1', 3, 1]]);
    assert.equal(floors[0].lexicalRank, 1, 'a floor copy carries the same ranks as its pool copy');
  });

  it('both doors carry the ranks beside the scores, surviving any projection', async () => {
    // Ranking fields sit beside `record` on both doors, so no projection of the record can reach them.
    const { RECALL_RANKING_DIAGNOSTICS } = await import('../../server/dist/brain/recall-shape.js');
    for (const k of ['vectorRank', 'lexicalRank']) {
      assert.ok(RECALL_RANKING_DIAGNOSTICS.includes(k), `${k} is a ranking field`);
    }
  });

  it('no lexical hit in any type fuses nothing', () => {
    const pool = [{ _id: 'a1', score: 0.9 }];
    assert.equal(stampFusion(pool, [], [[], []]), false);
    assert.equal(pool[0].fusedScore, undefined);
  });

  it('recall no longer merges the per-type lexical hits by raw score', () => {
    const src = stripComments(readFileSync('server/src/brain/recall.ts', 'utf8'));
    const fn = bodyOf(src, 'applyLexicalFusion');
    assert.doesNotMatch(fn, /\.flat\(\)\.sort\(\(a, b\) => b\.lexicalScore - a\.lexicalScore/,
      'the per-type lexical hits are still sorted together by raw text score');
  });
});

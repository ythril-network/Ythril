/**
 * The panel names the score that DECIDED a result's place, not the one it happens to know about.
 *
 * ## What this is for (`Q-17`)
 *
 * Precedence is `rerankScore` → `fusedScore` → `score`, and the integration guide states the consequence:
 * on an instance with a cross-encoder configured, `score` — plain vector similarity — is **not** the number
 * that ordered the answer. The panel showed `score` and labelled it "Score", so on exactly those instances
 * it displayed a figure that decided nothing, beside results in an order it did not explain.
 *
 * The cases below are the truth table of that precedence, plus the one that is easy to get wrong: an ABSENT
 * stage means the stage did not run, and must not be rendered as zero.
 */
import { describe, it, expect } from 'vitest';
import { orderingOf } from './recall-grouping';

describe('which score ordered this result', () => {
  it('the reranker wins when it ran, whatever the others say', () => {
    const o = orderingOf({ score: 0.9, fusedScore: 0.8, rerankScore: 0.2 });
    expect(o?.by, 'a configured cross-encoder decides the order — the guide says so outright').toBe('rerankScore');
    expect(o?.value).toBe(0.2);
  });

  it('the fused score wins when there is no reranker', () => {
    const o = orderingOf({ score: 0.9, fusedScore: 0.4 });
    expect(o?.by).toBe('fusedScore');
    expect(o?.value).toBe(0.4);
  });

  it('and plain similarity only when it is the only stage that ran', () => {
    const o = orderingOf({ score: 0.7 });
    expect(o?.by).toBe('score');
    expect(o?.value).toBe(0.7);
  });

  it('a fused score comes with the two ranks it was computed from (Q-159)', () => {
    expect(orderingOf({ score: 0.9, fusedScore: 0.0325, vectorRank: 1, lexicalRank: 2 })?.ranks).toEqual({ vector: 1, lexical: 2 });
    // Not found by text: the lexical rank is absent, and must not read as a rank of zero.
    expect(orderingOf({ score: 0.9, fusedScore: 0.0164, vectorRank: 1 })?.ranks).toEqual({ vector: 1 });
    expect(orderingOf({ score: 0.9 })?.ranks, 'no fusion, no ranks to show').toBeUndefined();
  });

  it('a result with no score at all is not an ordering', () => {
    // A traversed neighbour has none: it did not answer the question, so there is nothing to explain.
    expect(orderingOf({ _id: 'x' })).toBeNull();
  });

  it('lists every stage that ran, deciding one first', () => {
    const o = orderingOf({ score: 0.9, fusedScore: 0.8, rerankScore: 0.2, lexicalScore: 0.5 });
    expect(o?.stages.map(s => s.name)).toEqual(['rerankScore', 'fusedScore', 'score', 'lexicalScore']);
  });

  it('leaves an absent stage OUT rather than showing it as zero', () => {
    /*
     * The distinction the whole helper turns on. Absent means the stage did not RUN — no reranker
     * configured, no lexical channel for that query — and a zero would read as "the reranker scored this
     * nothing", which is the opposite claim.
     */
    const o = orderingOf({ score: 0.7 });
    expect(o?.stages.map(s => s.name)).toEqual(['score']);
    expect(o?.stages.some(s => s.value === 0 && s.name !== 'score')).toBe(false);
  });

  it('a real zero from a stage that DID run is kept', () => {
    // The other half of the same distinction: 0 is a score, and `typeof` is what tells it from absent.
    const o = orderingOf({ score: 0.7, lexicalScore: 0 });
    expect(o?.stages.find(s => s.name === 'lexicalScore')?.value).toBe(0);
  });

  it('ignores a non-numeric value rather than rendering it', () => {
    // These arrive from the network. A string where a float belongs is not a score, and `toFixed` on one
    // throws inside a template, which takes the whole panel down rather than one row.
    expect(orderingOf({ score: 'high' as unknown as number })).toBeNull();
  });
});

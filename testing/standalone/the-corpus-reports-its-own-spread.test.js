/**
 * The corpus can state how unevenly one prompt treated it, and the number is computed rather than remembered.
 *
 * ## Why this is a module and not a `node -e`
 *
 * `B-4` produced a figure that decided the next three rows: one prompt and one model gave a **6.6x spread**
 * in chrono entries per 1,000 turns across ten conversations — 10.3 to 67.8 — and 0 to 8 supersessions across
 * conversations of comparable length. The prompt's own standard is that two models disagreeing a lot is a
 * finding about the prompt; one model disagreeing with itself that much met the test without a second model.
 *
 * `B-16` is then judged by whether the spread narrows, which means the figure gets recomputed every round.
 * A number arrived at by a command somebody typed once is a number nobody can check and everybody quotes —
 * this repo's own rule about a count in prose, one level up. So the derivation is code, the CLI prints it,
 * and this asserts the arithmetic against fixtures whose answers are obvious by inspection.
 *
 * ## What the cases are really for
 *
 * **The ratio is the headline and it is the part that can quietly lie.** A conversation with zero chrono
 * entries makes the spread infinite, and a spread of `Infinity` printed beside nine honest numbers reads as
 * a catastrophe rather than as one empty file. A single conversation has no spread at all and must not
 * report 1.0, which looks like perfect consistency. Both are refused rather than rendered.
 *
 * Run: node --test testing/standalone/the-corpus-reports-its-own-spread.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { corpusSpread } from '../../benchmarks/writer/corpus-spread.mjs';

/** One extraction, reduced to what the measurement reads. */
const ex = (id, turns, chrono, superseded = 0) => ({
  conversationId: id,
  sessions: [{ turns: Array.from({ length: turns }, (_, i) => `D1:${i + 1}`) }],
  chrono: Array.from({ length: chrono }, (_, i) => ({ key: `c${i}` })),
  claims: Array.from({ length: superseded }, (_, i) => ({ key: `s${i}`, superseded: true })),
});

describe('the per-conversation density', () => {
  it('is chrono entries per 1,000 turns, so two sizes are comparable', () => {
    const r = corpusSpread([ex('a', 1000, 10), ex('b', 500, 10)]);
    assert.equal(r.rows.find(x => x.id === 'a').chronoPer1000, 10);
    assert.equal(r.rows.find(x => x.id === 'b').chronoPer1000, 20,
      'the smaller conversation is twice as dense and the raw counts are equal — which is the whole point');
  });

  it('counts superseded CLAIMS, not supersedes edges', () => {
    // Different facts. An edge says which claim replaced which; a retirement often has no successor and no
    // edge at all, so counting edges undercounts exactly the case the prompt says is a complete record.
    const r = corpusSpread([ex('a', 100, 1, 3)]);
    assert.equal(r.rows[0].superseded, 3);
  });

  it('reports rows sorted by density, because the shape of the spread is the finding', () => {
    const r = corpusSpread([ex('a', 1000, 50), ex('b', 1000, 10), ex('c', 1000, 30)]);
    assert.deepEqual(r.rows.map(x => x.id), ['b', 'c', 'a']);
  });
});

describe('the headline', () => {
  it('is the ratio of the densest to the sparsest', () => {
    const r = corpusSpread([ex('a', 1000, 10), ex('b', 1000, 20), ex('c', 1000, 66)]);
    assert.equal(r.chronoSpread, 6.6);
    assert.equal(r.densest.id, 'c');
    assert.equal(r.sparsest.id, 'a');
  });

  it('and the totals are summed, never averaged from the per-conversation rates', () => {
    // Averaging ten rates weights a 369-turn conversation the same as a 689-turn one. The corpus figure is
    // the corpus's own, which means summing both sides first.
    const r = corpusSpread([ex('a', 1000, 10), ex('b', 100, 10)]);
    assert.equal(r.totals.turns, 1100);
    assert.equal(r.totals.chrono, 20);
    assert.equal(r.totals.chronoPer1000, 18.2);
  });

  it('REFUSES to print a spread when something has no chrono entries at all', () => {
    // Infinity beside nine honest numbers reads as a catastrophe rather than as one empty file, and a
    // headline nobody can interpret is worse than one that says why it is missing.
    const r = corpusSpread([ex('a', 1000, 0), ex('b', 1000, 20)]);
    assert.equal(r.chronoSpread, null);
    assert.match(r.why, /no chrono entries/);
    assert.match(r.why, /\ba\b/, 'it must name which one, or the reader has to find it');
  });

  it('refuses a spread over one conversation rather than reporting 1.0', () => {
    // 1.0 is what perfect consistency looks like. A corpus of one has no consistency to report.
    const r = corpusSpread([ex('a', 1000, 20)]);
    assert.equal(r.chronoSpread, null);
    assert.match(r.why, /one conversation/);
  });

  it('throws on an empty corpus rather than reporting zeroes', () => {
    assert.throws(() => corpusSpread([]), /no extractions/);
  });

  it('throws on a conversation with no turns, which would divide by zero silently', () => {
    assert.throws(() => corpusSpread([ex('a', 0, 5)]), /no turns/);
  });
});

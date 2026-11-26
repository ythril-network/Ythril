/**
 * The pure parts of the embed-meaning arm (Q-763): the template queries, the two metrics, the arm B text and the verdict.
 *
 * The arm decides whether a label's vocabulary meaning goes into an edge's embedding text, and that decision rests on these
 * numbers. A query that names the label word measures the label and not its meaning; a query whose slots match two edges
 * has two right answers and scores one of them as a miss; a reciprocal rank taken from the wrong position, or a margin
 * read as a fraction where points were meant, flips the verdict. Each case states the rule it guards.
 *
 * Run: node --test testing/standalone/bsbm-harness-embed-meaning.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armBText, descriptionFor, generateQueries, labelMeaning, labelWords, meanReciprocalRank, rankOf, recallAt, verdict,
} from '../../benchmarks/rdf/embed-meaning.mjs';

// Two products with one producer each; P1 has two features, P2 one; one offer of P1.
const NAMES = new Map([
  ['p1', 'lynx gamesmanship'], ['p2', 'quiet harbor'], ['m1', 'Acme Works'], ['m2', 'Borealis'],
  ['f1', 'waterproof'], ['f2', 'foldable'], ['f3', 'cordless'], ['o1', 'Offer 17'],
]);
const EDGES = [
  { id: 'e1', from: 'p1', label: 'producer', to: 'm1' },
  { id: 'e2', from: 'p2', label: 'producer', to: 'm2' },
  { id: 'e3', from: 'p1', label: 'productFeature', to: 'f1' },
  { id: 'e4', from: 'p1', label: 'productFeature', to: 'f2' },
  { id: 'e5', from: 'p2', label: 'productFeature', to: 'f3' },
  { id: 'e6', from: 'o1', label: 'product', to: 'p1' },
];
const TEMPLATES = {
  producer: ['which company manufactures {from}', 'who makes {from}'],
  productFeature: ['does {from} come with {to}', 'what traits does {from} have'],
  product: ['what item is sold in {from}'],
};

test('a label is split into its words at case changes, and words under four letters are not its words', () => {
  assert.deepEqual(labelWords('productFeature'), ['product', 'feature']);
  assert.deepEqual(labelWords('reviewFor'), ['review']);
  assert.deepEqual(labelWords('rev:reviewer'), ['reviewer']);
});

test('the same seed gives the same queries, in the same order', () => {
  const a = generateQueries({ edges: EDGES, names: NAMES, templates: TEMPLATES, seed: 7, perLabel: 2 });
  const b = generateQueries({ edges: [...EDGES].reverse(), names: NAMES, templates: TEMPLATES, seed: 7, perLabel: 2 });
  assert.deepEqual(a, b, 'the input order of the edges does not change the queries');
  assert.ok(a.length > 0);
});

test('different seeds draw different targets when there is a choice', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, from: `p${i}`, label: 'producer', to: `m${i}` }));
  const names = new Map(many.flatMap(e => [[e.from, `item ${e.from}`], [e.to, `maker ${e.to}`]]));
  const pick = seed => generateQueries({ edges: many, names, templates: { producer: TEMPLATES.producer }, seed, perLabel: 5 }).map(q => q.target);
  assert.notDeepEqual(pick(1), pick(2));
});

test('a query is only made for an edge its filled slots name alone: the one relevant answer', () => {
  const qs = generateQueries({ edges: EDGES, names: NAMES, templates: { productFeature: ['what traits does {from} have'] }, seed: 3, perLabel: 10 });
  // p1 has two features, so "{from}" names two edges of the label and is never asked about p1.
  assert.deepEqual(qs.map(q => q.target), ['e5']);
  assert.equal(qs[0].text, 'what traits does quiet harbor have');
});

test('templates are used in turn, each query names its label and target, and the count per label is the cap', () => {
  const qs = generateQueries({ edges: EDGES, names: NAMES, templates: TEMPLATES, seed: 11, perLabel: 2 });
  const producer = qs.filter(q => q.label === 'producer');
  assert.equal(producer.length, 2);
  assert.deepEqual(producer.map(q => q.template), [0, 1]);
  for (const q of qs) {
    const e = EDGES.find(x => x.id === q.target);
    assert.equal(e.label, q.label);
    assert.ok(!/\{(from|to)\}/.test(q.text), `a slot left unfilled: ${q.text}`);
  }
  assert.deepEqual([...new Set(qs.map(q => q.label))], ['producer', 'product', 'productFeature'], 'labels in sorted order');
});

test('a template that holds a word of its label is refused: it would measure the label, not its meaning', () => {
  assert.throws(
    () => generateQueries({ edges: EDGES, names: NAMES, templates: { producer: ['who is the producer of {from}'] }, seed: 1, perLabel: 1 }),
    /names its label/,
  );
  assert.throws(
    () => generateQueries({ edges: EDGES, names: NAMES, templates: { productFeature: ['features of {from} include {to}'] }, seed: 1, perLabel: 1 }),
    /names its label/,
  );
});

test('the rank is the 1-based position of the target, or null when it is not returned', () => {
  assert.equal(rankOf(['a', 'b', 'c'], 'a'), 1);
  assert.equal(rankOf(['a', 'b', 'c'], 'c'), 3);
  assert.equal(rankOf(['a', 'b', 'c'], 'z'), null);
});

test('recall@10 and MRR on a hand-computed example', () => {
  // Ranks 1, 3, not returned, 10 and 11 (an 11th result is outside the cut).
  const ranks = [1, 3, null, 10, 11];
  assert.equal(recallAt(ranks, 10), 3 / 5);
  assert.equal(recallAt(ranks, 1), 1 / 5);
  // MRR@10: (1 + 1/3 + 0 + 1/10 + 0) / 5 = 0.28666...
  assert.ok(Math.abs(meanReciprocalRank(ranks, 10) - (1 + 1 / 3 + 0.1) / 5) < 1e-12);
  assert.equal(meanReciprocalRank([2, 2], 10), 0.5);
});

test('a label means the description of its declaration, else the comment of its vocabulary term, else nothing', () => {
  const meta = {
    typeSchemas: {
      edge: {
        producer: { description: '  the company that made it  ', iri: 'http://v/producer' },
        vendor: { iri: 'http://v/vendor' },
        reviewer: { description: '   ', iri: 'http://v/reviewer' },
        product: {},
      },
    },
  };
  const comments = new Map([['http://v/producer', 'ignored: the description wins'], ['http://v/vendor', 'the shop selling it'], ['http://v/reviewer', 'who wrote it']]);
  assert.equal(labelMeaning(meta, 'producer', comments), 'the company that made it');
  assert.equal(labelMeaning(meta, 'vendor', comments), 'the shop selling it');
  assert.equal(labelMeaning(meta, 'reviewer', comments), 'who wrote it', 'a blank description falls through');
  assert.equal(labelMeaning(meta, 'product', comments), null);
  assert.equal(labelMeaning(meta, 'unknown', comments), null);
  assert.equal(labelMeaning({}, 'producer', new Map()), null);
});

test('arm B appends the meaning to arm A\'s text, and a label without one keeps arm A\'s text', () => {
  assert.equal(armBText('lynx producer Acme', 'the company that made it'), 'lynx producer Acme the company that made it');
  assert.equal(armBText('lynx producer Acme', null), 'lynx producer Acme');
});

test('the meaning goes into an edge\'s description only when the edge has none, so arm B is arm A plus the meaning', () => {
  assert.equal(descriptionFor({ id: 'e1' }, 'the maker'), 'the maker');
  assert.equal(descriptionFor({ id: 'e1', description: '' }, 'the maker'), 'the maker');
  assert.throws(() => descriptionFor({ id: 'e1', description: 'own text' }, 'the maker'), /already has a description/);
});

test('the flag ships only when recall@10 gains at least 3 points and MRR does not fall', () => {
  assert.equal(verdict({ recall: 0.50, mrr: 0.40 }, { recall: 0.53, mrr: 0.40 }).ships, true);
  assert.equal(verdict({ recall: 0.30, mrr: 0.40 }, { recall: 0.33, mrr: 0.41 }).ships, true, 'exactly 3 points, despite float noise');
  assert.equal(verdict({ recall: 0.50, mrr: 0.40 }, { recall: 0.529, mrr: 0.45 }).ships, false, 'under 3 points');
  assert.equal(verdict({ recall: 0.50, mrr: 0.40 }, { recall: 0.60, mrr: 0.399 }).ships, false, 'MRR fell');
  assert.equal(verdict({ recall: 0.50, mrr: 0.40 }, { recall: 0.60, mrr: 0.399 }).recallGainPoints, 10);
});

/**
 * Phase 6 of the conversation extractor — relations (`F-31`, DECOMPOSITION.md 6.1, 6.2, 6.4).
 *
 * Candidate pairs are the entities one claim NAMES together (6.1). For each pair the decision model chooses a
 * label or `none` — but only among the labels whose declared endpoint types fit the pair, in the direction
 * they fit (6.2). An illegal edge cannot be proposed, so it cannot be written. *"Not when merely mentioned
 * together"* is the `none` option. Degree and change stay in the claim: the edge has no field for them (6.4).
 *
 * Run: node --test testing/standalone/the-extractor-draws-only-legal-edges.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let drawEdges;
before(async () => { ({ drawEdges } = await import('../../server/dist/extractor/conversation/relations.js')); });

const VOCAB = {
  practices: { description: 'Someone does this.', from: ['person'], to: ['activity'] },
  owns: { description: 'Someone owns this.', from: ['person'], to: ['animal', 'object'] },
  knows: { description: 'Two people know each other.', from: ['person'], to: ['person'] },
};
const ENTITIES = new Map([
  ['p1', { id: 'p1', name: 'Ada', type: 'person' }], ['p2', { id: 'p2', name: 'Bo', type: 'person' }],
  ['a1', { id: 'a1', name: 'Luna', type: 'animal' }], ['y1', { id: 'y1', name: 'yoga', type: 'activity' }],
  ['w1', { id: 'w1', name: 'Paris', type: 'place' }],
]);
const model = (pick) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  return { backend: 'jev', model: 'j', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'choice', choice: pick(id, q), probabilities: null, confidence: null }])) };
} }; };

describe('6.2 only legal labels are offered', () => {
  it('a person and an animal are offered owns, in the one direction it fits — and none', async () => {
    const m = model(() => 'none');
    await drawEdges([{ text: 'Ada adopted Luna.', entityIds: ['p1', 'a1'] }], { entities: ENTITIES, vocabulary: VOCAB, decide: m.decide });
    const [q] = Object.values(m.calls[0].questions);
    assert.deepEqual(Object.keys(q.criteria).sort(), ['none', 'owns:p1>a1']);
  });
  it('two people are offered knows both ways', async () => {
    const m = model(() => 'none');
    await drawEdges([{ text: 'Ada met Bo.', entityIds: ['p1', 'p2'] }], { entities: ENTITIES, vocabulary: VOCAB, decide: m.decide });
    assert.deepEqual(Object.keys(Object.values(m.calls[0].questions)[0].criteria).sort(), ['knows:p1>p2', 'knows:p2>p1', 'none']);
  });
  it('a pair no label fits is not asked about at all', async () => {
    const m = model(() => 'none');
    await drawEdges([{ text: 'Luna was in Paris.', entityIds: ['a1', 'w1'] }], { entities: ENTITIES, vocabulary: VOCAB, decide: m.decide });
    assert.equal(m.calls.length, 0);
  });
});

describe('the edges written', () => {
  it('a chosen label is an edge in its direction; none, a refusal or an unknown key is no edge', async () => {
    const claims = [{ text: 'Ada adopted Luna and does yoga.', entityIds: ['p1', 'a1', 'y1'] }];
    const r = await drawEdges(claims, { entities: ENTITIES, vocabulary: VOCAB,
      decide: model((id, q) => (Object.keys(q.criteria).find(k => k.startsWith('practices')) ?? 'none')).decide });
    assert.deepEqual(r.edges.map(e => [e.from, e.label, e.to]), [['p1', 'practices', 'y1']]);
    const bad = await drawEdges(claims, { entities: ENTITIES, vocabulary: VOCAB, decide: model(() => 'owns:a1>p1').decide });
    assert.deepEqual(bad.edges, [], 'a direction the schema does not allow is not an edge, however it arrived');
  });
  it('the same edge from two claims is one edge citing both', async () => {
    const claims = [{ text: 'Ada adopted Luna.', entityIds: ['p1', 'a1'] }, { text: 'Ada feeds Luna.', entityIds: ['p1', 'a1'] }];
    const r = await drawEdges(claims, { entities: ENTITIES, vocabulary: VOCAB, decide: model(() => 'owns:p1>a1').decide });
    assert.equal(r.edges.length, 1);
    assert.deepEqual(r.edges[0].claims, [0, 1]);
  });
  it('one request per claim, every pair asked in it', async () => {
    const m = model(() => 'none');
    await drawEdges([{ text: 'Ada, Bo and Luna.', entityIds: ['p1', 'p2', 'a1'] }], { entities: ENTITIES, vocabulary: VOCAB, decide: m.decide });
    assert.equal(m.calls.length, 1);
    assert.equal(Object.keys(m.calls[0].questions).length, 3, 'p1-p2 (knows), p1-a1 (owns), p2-a1 (owns)');
  });
});

/**
 * Phase 6.3 of the conversation extractor: an edge's `since` / `until`, only when the text says so (`F-31`,
 * DECOMPOSITION.md 6.3).
 *
 * *"Ada has worked at Acme since March 2021"* dates the relationship; *"Ada mentioned Acme on Tuesday"* dates the
 * telling, not the job. A date near an edge is not the edge's date, which is why it is ASKED rather than copied —
 * and why the policy is "absent unless confident": a wrong `since` is a fact the graph states and nobody wrote.
 *
 * Asked only where an answer can be written: an edge whose claims carry a date phase 3 resolved to a DAY and did
 * not mark approximate (the store takes `YYYY-MM-DD`, and an approximate date may not have a day derived from it).
 *
 * Run: node --test testing/standalone/the-extractor-dates-an-edge-only-when-told.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let dateEdges;
before(async () => { ({ dateEdges } = await import('../../server/dist/extractor/conversation/edge-dates.js')); });

const entities = new Map([['a', { id: 'a', name: 'Ada', type: 'person' }], ['k', { id: 'k', name: 'Acme', type: 'organization' }]]);
const day = (value) => ({ precision: 'day', value, approximate: false, asOf: '2023-05-10' });
const edge = { from: 'a', to: 'k', label: 'works_at', claims: [0] };

/** A judge that answers yes to exactly the (kind, date) pairs it is given. */
const judge = (yes) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  const answers = {};
  for (const [id, q] of Object.entries(questions)) answers[id] = { type: 'noul', noul: yes.includes(`${id.split(':')[0]}:${q.instructions.date}`) ? 0.9 : 0.1 };
  return { backend: 'jev', model: 'j', answers };
} }; };

describe('asked only where an answer can be written', () => {
  it('no dated claim: no question, no property', async () => {
    const j = judge([]);
    const r = await dateEdges([edge], [{ text: 'Ada works at Acme.', dates: [] }], { entities, decide: j.decide });
    assert.equal(j.calls.length, 0);
    assert.equal(r.edges[0].properties, undefined);
  });
  it('a month, or an approximate day, is not asked about — no day may be derived from it', async () => {
    const j = judge([]);
    await dateEdges([edge], [{ text: 'Ada joined Acme in March 2021.', dates: [{ precision: 'month', value: '2021-03', approximate: false, asOf: '2023-05-10' }, { ...day('2021-03-01'), approximate: true }] }], { entities, decide: j.decide });
    assert.equal(j.calls.length, 0);
  });
});

describe('absent unless confident', () => {
  it('a start the text states becomes `since`', async () => {
    const r = await dateEdges([edge], [{ text: 'Ada started at Acme on 1 March 2021.', dates: [day('2021-03-01')] }], { entities, decide: judge(['since:2021-03-01']).decide });
    assert.deepEqual(r.edges[0].properties, { since: '2021-03-01' });
  });
  it('an end the text states becomes `until`', async () => {
    const r = await dateEdges([edge], [{ text: 'Ada left Acme on 9 May 2023.', dates: [day('2023-05-09')] }], { entities, decide: judge(['until:2023-05-09']).decide });
    assert.deepEqual(r.edges[0].properties, { until: '2023-05-09' });
  });
  it('a date the text only mentions near the relationship dates nothing', async () => {
    const r = await dateEdges([edge], [{ text: 'On 9 May 2023 Ada talked about Acme.', dates: [day('2023-05-09')] }], { entities, decide: judge([]).decide });
    assert.equal(r.edges[0].properties, undefined);
  });
  it('an end before its start is a contradiction, and both stay absent', async () => {
    const r = await dateEdges([edge], [{ text: 'x', dates: [day('2021-03-01'), day('2020-01-01')] }], { entities, decide: judge(['since:2021-03-01', 'until:2020-01-01']).decide });
    assert.equal(r.edges[0].properties, undefined);
  });
  it('a refused answer is not a yes', async () => {
    const r = await dateEdges([edge], [{ text: 'x', dates: [day('2021-03-01')] }], { entities, decide: async (s, q) => ({ backend: 'jev', model: 'j', answers: Object.fromEntries(Object.keys(q).map(k => [k, { type: 'noul', noul: null, invalid: 'x' }])) }) });
    assert.equal(r.edges[0].properties, undefined);
  });
  it('the question names the relationship, and every judgement is kept', async () => {
    const j = judge(['since:2021-03-01']);
    const r = await dateEdges([edge], [{ text: 'Ada started at Acme on 1 March 2021.', dates: [day('2021-03-01')] }], { entities, decide: j.decide });
    assert.match(JSON.stringify(j.calls[0].questions), /Ada works at Acme/);
    assert.equal(r.judgements.length, 1);
  });
});

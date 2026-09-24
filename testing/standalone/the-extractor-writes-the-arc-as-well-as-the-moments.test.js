/**
 * Phase 5.8 of the conversation extractor: an ARC, as well as the moments (`F-31`, DECOMPOSITION.md 5.8).
 *
 * A system that can report *"she applied in August"* and *"she passed in October"* but not *"the adoption went from
 * researching agencies in May to passing the interviews in October"* is a log, not a knowledge base. So an entity
 * with claims in three or more sessions gets an arc claim, written from those claims and checked like any claim:
 * linted, refused by the evidence gate if it says a name, number or date they do not, and citation-checked. The
 * writer may answer NONE — a subject mentioned often is not one that developed — and then nothing is written.
 *
 * Bounded: an arc cites a few turns, never most of the conversation (the validator refuses a summary). It is
 * ADDITIONAL — the moments stay — and it is added after change tracking, so an arc can never retire them.
 *
 * Run: node --test testing/standalone/the-extractor-writes-the-arc-as-well-as-the-moments.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let writeArcs;
before(async () => { ({ writeArcs } = await import('../../server/dist/extractor/conversation/arcs.js')); });

const entities = new Map([['ada', { id: 'ada', name: 'Ada', type: 'person' }], ['adoption', { id: 'adoption', name: 'the adoption', type: 'project' }]]);
const moment = (text, session, turn) => ({ text, session, statedOn: session, sourceTurns: [turn, `${turn}b`], entityIds: ['adoption'], speaker: 'Ada' });
const moments = [
  moment('Ada was researching adoption agencies in May 2023.', '2023-05-01', 's1:1'),
  moment('Ada applied to the adoption agency in August 2023.', '2023-08-01', 's2:1'),
  moment('Ada passed the adoption interviews in October 2023.', '2023-10-01', 's3:1'),
];
const ARC = 'Ada went from researching adoption agencies in May 2023 to passing the adoption interviews in October 2023.';

const writer = (...texts) => { const calls = []; return { calls, write: async (p) => { calls.push(p); return texts.shift() ?? 'NONE'; } }; };
const judge = (p = 0.9) => async (state, questions) => ({ backend: 'jev', model: 'j', answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: 'noul', noul: p }])) });

describe('an arc, when three sessions develop one subject', () => {
  it('is written from the subject\'s claims, checked, and cites a few turns from each', async () => {
    const w = writer(ARC);
    const r = await writeArcs(moments, entities, { write: w.write, decide: judge() });
    assert.equal(r.arcs.length, 1);
    const arc = r.arcs[0];
    assert.equal(arc.text, ARC);
    assert.deepEqual(arc.entityIds, ['adoption']);
    assert.deepEqual(arc.sourceTurns, ['s1:1', 's2:1', 's3:1'], 'the first turn of each moment, not all of them');
    assert.equal(arc.speaker, 'Ada');
    assert.equal(arc.statedOn, '2023-10-01', 'stated as of the last session the arc draws on');
    assert.match(w.calls[0].user, /May 2023/);
  });
});

describe('what writes no arc', () => {
  it('fewer than three sessions', async () => {
    const w = writer(ARC);
    const r = await writeArcs(moments.slice(0, 2), entities, { write: w.write, decide: judge() });
    assert.equal(r.arcs.length, 0);
    assert.equal(w.calls.length, 0, 'not even asked');
  });
  it('a writer that says nothing developed', async () => {
    const r = await writeArcs(moments, entities, { write: writer('NONE').write, decide: judge() });
    assert.equal(r.arcs.length, 0);
  });
  it('an arc that says what its claims do not — refused by code, rewritten once, then left out', async () => {
    const w = writer('Ada adopted Bella in December 2023.', 'Ada adopted Bella in December 2023.');
    const r = await writeArcs(moments, entities, { write: w.write, decide: judge() });
    assert.equal(r.arcs.length, 0);
    assert.equal(w.calls.length, 2);
    assert.match(w.calls[1].user, /Bella|December/);
  });
  it('an arc the citation check does not support', async () => {
    const r = await writeArcs(moments, entities, { write: writer(ARC, ARC).write, decide: judge(0.1) });
    assert.equal(r.arcs.length, 0);
  });
  it('an assistant\'s claims make no arc of their own', async () => {
    const theirs = moments.map(m => ({ ...m, attributed: true, speaker: 'assistant' }));
    const w = writer(ARC);
    const r = await writeArcs(theirs, entities, { write: w.write, decide: judge() });
    assert.equal(r.arcs.length, 0);
    assert.equal(w.calls.length, 0);
  });
});

/**
 * Phase 5.9 of the conversation extractor: a background STATE told many times is written once (`F-31`,
 * DECOMPOSITION.md 5.9).
 *
 * *"Ada works at Acme"* said in five sessions is one fact told five times. Written five times it fills five ranked
 * slots with one answer and pushes everything else out of a recall — so the later tellings are folded into the
 * first claim as its source turns, and the claim is written once.
 *
 * Asked per pair, about claims that share an entity and come from DIFFERENT sessions (two claims in one session are
 * two things said, not a repetition). The question is the same UNCHANGED fact told again — a change is phase 7's,
 * and this runs before it so a changed job is never merged away: *"merge the telling, keep contradictions apart"*.
 *
 * Run: node --test testing/standalone/the-extractor-writes-a-repeated-state-once.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let mergeRepeats;
before(async () => { ({ mergeRepeats } = await import('../../server/dist/extractor/conversation/repeats.js')); });

const c = (text, session, sourceTurns, entityIds = ['ada', 'acme']) => ({ text, session, statedOn: session, sourceTurns, entityIds });

/** A judge that says "the same" to exactly the pairs named `later<earlier`, by claim text. */
const judge = (same) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  const answers = {};
  for (const [id, q] of Object.entries(questions)) answers[id] = { type: 'noul', noul: same.includes(`${q.instructions.later}<${q.instructions.earlier}`) ? 0.9 : 0.1 };
  return { backend: 'jev', model: 'j', answers };
} }; };

const first = c('Ada works at Acme.', '2023-05-01', ['s1:1']);
const again = c('Ada is still at Acme.', '2023-06-01', ['s2:4']);

describe('the same state, told again', () => {
  it('is written once: the first claim keeps its text and gains the later turns', async () => {
    const r = await mergeRepeats([first, again], judge(['Ada is still at Acme.<Ada works at Acme.']).decide);
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].text, 'Ada works at Acme.');
    assert.deepEqual(r.claims[0].sourceTurns, ['s1:1', 's2:4']);
    assert.deepEqual(r.merged, [{ kept: 0, folded: 1 }]);
  });

  it('three tellings fold into the first, not into each other', async () => {
    const third = c('Ada works at Acme, as ever.', '2023-07-01', ['s3:2']);
    const r = await mergeRepeats([first, again, third], judge([
      'Ada is still at Acme.<Ada works at Acme.', 'Ada works at Acme, as ever.<Ada works at Acme.', 'Ada works at Acme, as ever.<Ada is still at Acme.',
    ]).decide);
    assert.equal(r.claims.length, 1);
    assert.deepEqual(r.claims[0].sourceTurns, ['s1:1', 's2:4', 's3:2']);
  });
});

describe('what is never merged', () => {
  it('a different fact about the same entities', async () => {
    const r = await mergeRepeats([first, c('Ada left Acme.', '2023-06-01', ['s2:1'])], judge([]).decide);
    assert.equal(r.claims.length, 2);
  });
  it('two claims from ONE session are not even asked about', async () => {
    const j = judge(['Ada likes Acme.<Ada works at Acme.']);
    const r = await mergeRepeats([first, c('Ada likes Acme.', '2023-05-01', ['s1:3'])], j.decide);
    assert.equal(r.claims.length, 2);
    assert.equal(j.calls.length, 0);
  });
  it('claims that share no entity are not asked about', async () => {
    const j = judge([]);
    await mergeRepeats([first, c('Bo moved to Oslo.', '2023-06-01', ['s2:1'], ['bo', 'oslo'])], j.decide);
    assert.equal(j.calls.length, 0);
  });
  it('an attributed claim is not merged with a person\'s — they are different records on purpose', async () => {
    const r = await mergeRepeats([first, { ...again, attributed: true, speaker: 'assistant' }], judge(['Ada is still at Acme.<Ada works at Acme.']).decide);
    assert.equal(r.claims.length, 2);
  });
  it('a refused answer merges nothing', async () => {
    const r = await mergeRepeats([first, again], async (s, q) => ({ backend: 'jev', model: 'j', answers: Object.fromEntries(Object.keys(q).map(k => [k, { type: 'noul', noul: null, invalid: 'x' }])) }));
    assert.equal(r.claims.length, 2);
  });
});

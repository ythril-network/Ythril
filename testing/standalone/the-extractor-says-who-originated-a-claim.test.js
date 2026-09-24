/**
 * Phase 5.4 + 5.5 of the conversation extractor: who ORIGINATED a claim (`F-31`, DECOMPOSITION.md 5.4, 5.5).
 *
 * A claim was the speaker of the exchange's first turn, whoever that was. So an assistant that supplied a fact —
 * a restaurant, a drug interaction, a date — produced a claim filed as the person's, indistinguishable from
 * something they said. And one named `assistant` produced a claim the validator refuses, failing the whole
 * conversation's ingest.
 *
 *  - 5.4 asks, only for an exchange with an assistant turn in it, who originated the fact: the person, the
 *    assistant restating the person, the assistant as origin, or unclear. Only `origin` is the assistant's:
 *    `speaker: "assistant"`, `attributed: true`. Restating, unclear and a refused answer are the PERSON's claim —
 *    they never add an unearned `attributed`.
 *  - 5.5 asks, for an assistant-originated fact, whether the exchange DID something with it (picked it, booked
 *    it, came back to it). *"When in doubt, leave it out"*: below the threshold the claim is dropped, reported.
 *
 * Run: node --test testing/standalone/the-extractor-says-who-originated-a-claim.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let judgeOrigin;
before(async () => { ({ judgeOrigin } = await import('../../server/dist/extractor/conversation/origin.js')); });

const person = { id: 's1:1', speaker: 'Ada', speech: 'Where should we eat tonight?', role: 'person' };
const helper = { id: 's1:2', speaker: 'ChatGPT', speech: 'Try Luigi\'s on Main Street — it opened last month.', role: 'assistant' };
const claim = 'Luigi\'s on Main Street opened in April 2023.';

const answering = (origin, acted) => {
  const calls = [];
  return { calls, decide: async (state, questions) => {
    calls.push({ state, questions });
    return { backend: 'jev', model: 'j', answers: {
      ...(questions.origin ? { origin: origin === null ? { type: 'choice', choice: null, invalid: 'x' } : { type: 'choice', choice: origin } } : {}),
      ...(questions.acted ? { acted: { type: 'noul', noul: acted } } : {}),
    } };
  } };
};

describe('an exchange with no assistant in it is never asked', () => {
  it('the claim is the person\'s, and nothing is spent', async () => {
    const d = answering('origin', 0.9);
    const r = await judgeOrigin({ claim, turns: [person, { ...person, id: 's1:3', speaker: 'Bo', speech: 'Luigi\'s!' }] }, d.decide);
    assert.deepEqual({ speaker: r.speaker, attributed: r.attributed }, { speaker: 'Ada', attributed: false });
    assert.equal(d.calls.length, 0);
  });
});

describe('5.4 who originated it', () => {
  it('the assistant as origin, and the exchange acted on it: the assistant\'s, attributed', async () => {
    const r = await judgeOrigin({ claim, turns: [person, helper] }, answering('origin', 0.8).decide);
    assert.deepEqual({ speaker: r.speaker, attributed: r.attributed, drop: r.drop }, { speaker: 'assistant', attributed: true, drop: undefined });
  });

  for (const verdict of ['person', 'restating', 'unclear', null]) {
    it(`${verdict ?? 'a refused answer'}: the person's claim, never an unearned mark`, async () => {
      const r = await judgeOrigin({ claim, turns: [person, helper] }, answering(verdict, 0.99).decide);
      assert.deepEqual({ speaker: r.speaker, attributed: r.attributed, drop: r.drop }, { speaker: 'Ada', attributed: false, drop: undefined });
    });
  }

  it('an exchange with no person in it falls back to the person the caller names', async () => {
    const r = await judgeOrigin({ claim, turns: [helper], person: 'Ada' }, answering('restating', 0).decide);
    assert.equal(r.speaker, 'Ada');
  });

  it('the question is asked about the claim against the turns, and the answers are kept', async () => {
    const d = answering('origin', 0.9);
    const r = await judgeOrigin({ claim, turns: [person, helper] }, d.decide);
    assert.equal(d.calls[0].questions.origin.type, 'choice');
    assert.ok('unclear' in d.calls[0].questions.origin.criteria, 'a no-match option, or decide() refuses the question');
    assert.match(JSON.stringify(d.calls[0].state), /Luigi/);
    assert.equal(r.judgement.answers.origin.choice, 'origin');
  });
});

describe('5.5 when in doubt, leave it out', () => {
  it('an assistant\'s fact the exchange did nothing with is dropped, and says why', async () => {
    const r = await judgeOrigin({ claim, turns: [person, helper] }, answering('origin', 0.2).decide);
    assert.match(r.drop, /assistant/);
  });
  it('a refused 5.5 answer is not a yes', async () => {
    const r = await judgeOrigin({ claim, turns: [person, helper] }, answering('origin', null).decide);
    assert.ok(r.drop);
  });
});

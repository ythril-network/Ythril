/**
 * The extractor's decision client (`F-31`, DECOMPOSITION.md "How every jev step is asked").
 *
 * Owner, 2026-09-23: *"the jev endpoint is configurable model right? also as fallback this has to be handled
 * with the assistant llm"*. So there are two backends and one contract — TypeSafe's own, from
 * docs.typesafe.ai/api.md — and every answer is checked by code before anything reads it, whichever backend
 * gave it. The model judges; software governs.
 *
 * No live endpoint is reached: the transport is handed in, so what is asserted is what would be SENT and
 * what is made of what comes back.
 *
 * Run: node --test testing/standalone/the-extractor-decides-by-jev-or-assist.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

let pickDecisionBackend, decide, DecisionUnavailableError, DecisionError, egressConsented;
before(async () => {
  ({ pickDecisionBackend, decide, DecisionUnavailableError, DecisionError }
    = await import('../../server/dist/extractor/decide.js'));
  ({ egressConsented } = await import('../../server/dist/config/egress-consent.js'));
});

const jevSlot = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', acknowledgedHost: 'api.typesafe.ai', apiKey: 'k1' };
// The assist endpoint as `assistBackend('conversations')` hands it over — consent, budget and fallback already decided
// there (F-33, `the-assist-model-falls-back-and-keeps-a-budget.test.js`). No `which`, so these calls are not accounted.
const assistSlot = { baseUrl: 'https://llm.example.com/v1', model: 'big-model', apiKey: 'k2' };

/** A transport that records every call and answers from a queue. */
function transport(...replies) {
  const calls = [];
  const post = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift();
    if (!r) throw new Error('no reply queued');
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, post, sleep: async () => {} };
}

const QUESTIONS = {
  who: { type: 'choice', instructions: 'Who is "she"?', criteria: { ada: 'Ada, the speaker', bo: 'Bo', none: 'Neither' } },
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
  mood: { type: 'score', instructions: 'How upset?', criteria: ['calm', 'upset', 'furious'] },
};

describe('egress consent is one rule, not four copies of it', () => {
  it('the acknowledged host must be the host the URL would send to', () => {
    assert.equal(egressConsented({ baseUrl: 'https://api.typesafe.ai', acknowledgedHost: 'api.typesafe.ai' }), true);
    assert.equal(egressConsented({ baseUrl: 'https://api.typesafe.ai', acknowledgedHost: 'evil.example' }), false);
    assert.equal(egressConsented({ baseUrl: 'not a url', acknowledgedHost: 'not a url' }), false);
    assert.equal(egressConsented({ baseUrl: '', acknowledgedHost: '' }), false);
    assert.equal(egressConsented(undefined), false);
  });

  it('no server source compares acknowledgedHost to a host by hand', () => {
    const files = trackedSources('server/src', { exclude: ['server/src/config/egress-consent.ts'], untracked: true });
    const inline = files
      .filter(f => /acknowledgedHost\s*===|===\s*[\w?.!]*acknowledgedHost\b/.test(
        readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    assert.deepEqual(inline, [], 'these decide egress consent themselves instead of asking egressConsented');
  });
});

describe('which backend answers', () => {
  it('the decision slot, when its host is acknowledged', () =>
    assert.equal(pickDecisionBackend({ decision: jevSlot, assist: assistSlot })?.kind, 'jev'));
  it('the assist model, when the decision slot is not consented to', () => {
    const b = pickDecisionBackend({ decision: { ...jevSlot, acknowledgedHost: undefined }, assist: assistSlot });
    assert.equal(b?.kind, 'assist');
    assert.equal(b?.model, 'big-model');
  });
  it('the assist model, when there is no decision slot at all', () =>
    assert.equal(pickDecisionBackend({ assist: assistSlot })?.kind, 'assist'));
  it('nobody, when the decision slot is not consented to and the resolver hands over no assist endpoint', () =>
    assert.equal(pickDecisionBackend({ decision: { ...jevSlot, acknowledgedHost: 'x' }, assist: null }), null));
  // Whether the assist endpoint may take conversations at all — its CONVERSATIONS consent, not the documents one
  // (F-35) — is the resolver's rule now, checked in `the-assist-model-falls-back-and-keeps-a-budget.test.js`.
  it('refusing names both settings, so the operator knows what to set', () => {
    const e = new DecisionUnavailableError();
    assert.match(e.message, /decisionModel/);
    assert.match(e.message, /documentProcessing\.assistModel/);
  });
});

describe('the Jev backend is sent Jev\'s own request', () => {
  it('POST <base>/v1/systemone, Bearer, {model, state, questions}, answers kept whole', async () => {
    const t = transport({ body: { model: 'jev-1.13.0', usage: { input_tokens: 9, output_tokens: 3 }, answers: {
      who: { type: 'choice', choice: 'ada', probabilities: { ada: 0.9, bo: 0.08, none: 0.02 }, confidence: 0.85 },
      urgent: { type: 'noul', noul: 0.2 },
      mood: { type: 'score', score: 1.1, legend: { 0: 'calm', 1: 'upset', 2: 'furious' }, probabilities: { 0: 0, 1: 0.9, 2: 0.1 }, confidence: 0.8 },
    } } });
    const d = await decide(pickDecisionBackend({ decision: jevSlot }), 'Ada: she called', QUESTIONS, t);
    assert.equal(t.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(t.calls[0].headers.Authorization, 'Bearer k1');
    assert.deepEqual(t.calls[0].body, { model: 'jev-latest', state: 'Ada: she called', questions: QUESTIONS });
    assert.equal(d.backend, 'jev');
    assert.equal(d.model, 'jev-1.13.0');
    assert.equal(d.answers.who.choice, 'ada');
    assert.deepEqual(d.answers.who.probabilities, { ada: 0.9, bo: 0.08, none: 0.02 }, 'raw probabilities are kept');
    assert.equal(d.answers.urgent.noul, 0.2);
    assert.equal(d.answers.mood.score, 1.1);
  });

  it('a base URL already ending in /v1 is not doubled', async () => {
    const t = transport({ body: { model: 'j', answers: { urgent: { type: 'noul', noul: 1 } } } });
    await decide(pickDecisionBackend({ decision: { ...jevSlot, baseUrl: 'https://api.typesafe.ai/v1/' } }), 's', { urgent: QUESTIONS.urgent }, t);
    assert.equal(t.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  });

  it('429 and 529 are waited out; the answer after them is used', async () => {
    const t = transport({ status: 429, body: '{}' }, { status: 529, body: '{}' },
      { body: { model: 'j', answers: { urgent: { type: 'noul', noul: 0.7 } } } });
    const d = await decide(pickDecisionBackend({ decision: jevSlot }), 's', { urgent: QUESTIONS.urgent }, t);
    assert.equal(t.calls.length, 3);
    assert.equal(d.answers.urgent.noul, 0.7);
  });

  it('a 422 is not retried — the request is wrong, and asking again will not fix it', async () => {
    const t = transport({ status: 422, body: '{"error":"criteria required"}' });
    await assert.rejects(decide(pickDecisionBackend({ decision: jevSlot }), 's', QUESTIONS, t),
      (e) => e instanceof DecisionError && e.status === 422 && /criteria required/.test(e.message));
    assert.equal(t.calls.length, 1);
  });

  it('retries end: a backend that stays overloaded is an error, not a hang', async () => {
    const t = transport(...Array.from({ length: 10 }, () => ({ status: 529, body: '{}' })));
    await assert.rejects(decide(pickDecisionBackend({ decision: jevSlot }), 's', QUESTIONS, t),
      (e) => e instanceof DecisionError && e.status === 529);
    assert.ok(t.calls.length > 1 && t.calls.length < 10, `tried ${t.calls.length} times`);
  });
});

describe('the assist model is asked the same questions, and answers in the same shape', () => {
  const chat = (answers) => ({ body: { model: 'big-model-2', choices: [{ message: { content: JSON.stringify({ answers }) } }] } });

  it('an OpenAI chat call whose schema only allows the listed options', async () => {
    const t = transport(chat({ who: 'bo', urgent: 0.9, mood: 2 }));
    const d = await decide(pickDecisionBackend({ assist: assistSlot }), 'Ada: she called', QUESTIONS, t);
    assert.equal(t.calls[0].url, 'https://llm.example.com/v1/chat/completions');
    assert.equal(t.calls[0].headers.Authorization, 'Bearer k2');
    const schema = t.calls[0].body.response_format.json_schema.schema.properties.answers.properties;
    assert.deepEqual(schema.who.enum, ['ada', 'bo', 'none']);
    assert.deepEqual([schema.urgent.minimum, schema.urgent.maximum], [0, 1]);
    assert.deepEqual([schema.mood.minimum, schema.mood.maximum], [0, 2]);
    assert.ok(JSON.stringify(t.calls[0].body.messages).includes('Ada: she called'), 'the state is sent');
    assert.equal(d.backend, 'assist');
    assert.equal(d.answers.who.choice, 'bo');
    assert.equal(d.answers.who.probabilities, null, 'an assist model gives no distribution, and none is invented');
    assert.equal(d.answers.urgent.noul, 0.9);
    assert.equal(d.answers.mood.score, 2);
    assert.deepEqual(d.answers.mood.legend, { 0: 'calm', 1: 'upset', 2: 'furious' });
  });

  it('a reply wrapped in a code fence is still read', async () => {
    const t = transport({ body: { choices: [{ message: { content: '```json\n{"answers":{"urgent":1}}\n```' } }] } });
    const d = await decide(pickDecisionBackend({ assist: assistSlot }), 's', { urgent: QUESTIONS.urgent }, t);
    assert.equal(d.answers.urgent.noul, 1);
  });
});

describe('software governs: an answer outside the question is refused, from either backend', () => {
  it('an assist choice that is not one of the options is marked invalid, never passed on', async () => {
    const t = transport({ body: { choices: [{ message: { content: JSON.stringify({ answers: { who: 'carol', urgent: 3 } }) } }] } });
    const d = await decide(pickDecisionBackend({ assist: assistSlot }), 's', { who: QUESTIONS.who, urgent: QUESTIONS.urgent }, t);
    assert.equal(d.answers.who.choice, null);
    assert.match(d.answers.who.invalid, /carol/);
    assert.equal(d.answers.urgent.noul, null);
    assert.match(d.answers.urgent.invalid, /0.*1/);
  });

  it('a missing answer is invalid, not a default', async () => {
    const t = transport({ body: { model: 'j', answers: {} } });
    const d = await decide(pickDecisionBackend({ decision: jevSlot }), 's', { who: QUESTIONS.who }, t);
    assert.equal(d.answers.who.choice, null);
    assert.match(d.answers.who.invalid, /no answer/);
  });

  it('a Jev choice outside the criteria is refused the same way', async () => {
    const t = transport({ body: { model: 'j', answers: { who: { type: 'choice', choice: 'carol', probabilities: { carol: 1 }, confidence: 1 } } } });
    const d = await decide(pickDecisionBackend({ decision: jevSlot }), 's', { who: QUESTIONS.who }, t);
    assert.equal(d.answers.who.choice, null);
    assert.match(d.answers.who.invalid, /carol/);
  });

  it('a question that names no no-match option is refused before anything is sent', async () => {
    const t = transport();
    await assert.rejects(decide(pickDecisionBackend({ decision: jevSlot }), 's',
      { who: { type: 'choice', instructions: 'Who?', criteria: { ada: null, bo: null } } }, t),
      (e) => e instanceof DecisionError && /who/.test(e.message) && /none|no-match/.test(e.message));
    assert.equal(t.calls.length, 0);
  });
});

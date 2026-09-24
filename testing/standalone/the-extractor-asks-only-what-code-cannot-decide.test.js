/**
 * The conversation extractor's first judgement steps (`F-31`, DECOMPOSITION.md 2.3, 2.5, 3.4, 3.12).
 *
 * What is asserted is the division of labour the decomposition promises: code finds the candidates and asks
 * ONLY about them, a model answers typed questions through `decide()`, and code applies the policy to the
 * answer — including the no-match answer, which always routes to the safe outcome, never to a guess.
 *
 * `decide` is handed in, so every test states exactly what the model said and checks what was ASKED and what
 * was made of the answer. Calendar as in the time test: 2023-05-10 is a Wednesday, 05-12 a Friday.
 *
 * Run: node --test testing/standalone/the-extractor-asks-only-what-code-cannot-decide.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let loadConversation, classifyTurns, judgeConversation;
before(async () => {
  ({ loadConversation } = await import('../../server/dist/extractor/conversation/load.js'));
  ({ classifyTurns } = await import('../../server/dist/extractor/conversation/classify.js'));
  ({ judgeConversation } = await import('../../server/dist/extractor/conversation/judge-turns.js'));
});

/** A model that answers from a table keyed by question id prefix, and records every request. */
function model(answer) {
  const calls = [];
  const decide = async (state, questions) => {
    calls.push({ state, questions });
    const answers = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = { type: q.type, ...answer(id, q, state) };
    return { backend: 'jev', model: 'jev-test', answers };
  };
  return { calls, decide };
}

const run = async (sessions, answer) => {
  const conv = loadConversation({ sessions });
  const m = model(answer);
  const out = await judgeConversation(conv, classifyTurns(conv), m.decide);
  return { ...out, calls: m.calls };
};

const one = (date, ...turns) => [{ date, turns }];

describe('nothing to judge, nothing asked', () => {
  it('declared roles and plain turns send no request at all', async () => {
    const { calls, turns } = await run(one('2023-05-10',
      { speaker: 'Ada', role: 'person', text: 'I went hiking yesterday.' },
      { speaker: 'Bot', role: 'assistant', text: 'That sounds lovely.' }), () => { throw new Error('asked'); });
    assert.equal(calls.length, 0);
    assert.deepEqual(turns[0].map(t => t.role), ['person', 'assistant']);
    assert.equal(turns[0][0].times[0].resolution.value, '2023-05-09', 'code still resolves what code can');
  });
});

describe('2.3 a speaker role the source does not declare', () => {
  const two = one('2023-05-10', { speaker: 'Ada', text: 'Can you help me plan a trip?' },
    { speaker: 'Helper', text: 'Of course! Here are three options for you.' });

  it('is asked once per speaker, all speakers in one request, each with a no-match option', async () => {
    const { calls } = await run(two, () => ({ choice: 'person' }));
    assert.equal(calls.length, 1);
    const qs = Object.values(calls[0].questions);
    assert.equal(qs.length, 2);
    for (const q of qs) assert.deepEqual(Object.keys(q.criteria).sort(), ['assistant', 'person', 'unclear']);
  });

  it('assistant is taken; unclear and an invalid answer both fall to person, the safe default', async () => {
    const { turns } = await run(two, (id, q, state) =>
      JSON.stringify(q.instructions).includes('Helper') ? { choice: 'assistant' } : { choice: 'unclear' });
    assert.deepEqual(turns[0].map(t => t.role), ['person', 'assistant']);
    const bad = await run(two, () => ({ choice: null, invalid: 'not an option' }));
    assert.deepEqual(bad.turns[0].map(t => t.role), ['person', 'person']);
  });
});

describe('2.5 a candidate paste', () => {
  const doc = ['# Terms', '', '## Clause 4', 'The party of the first part…'.repeat(40)].join('\n');
  const conv = one('2023-05-10', { speaker: 'Dana', role: 'person', text: 'Can you read this?' },
    { speaker: 'Dana', role: 'person', text: doc });

  it('only the candidate is asked about', async () => {
    const { calls } = await run(conv, () => ({ noul: 0.9 }));
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.values(calls[0].questions).map(q => q.type), ['noul']);
  });
  it('a likely yes marks it pasted; a no or a refused answer leaves it the speaker\'s own words', async () => {
    assert.equal((await run(conv, () => ({ noul: 0.9 }))).turns[0][1].pasted, true);
    assert.equal((await run(conv, () => ({ noul: 0.2 }))).turns[0][1].pasted, false);
    assert.equal((await run(conv, () => ({ noul: null, invalid: 'x' }))).turns[0][1].pasted, false);
    assert.equal((await run(conv, () => ({ noul: 0.9 }))).turns[0][0].pasted, false, 'never asked, never pasted');
  });
});

describe('3.12 a bare weekday: the tense is judged, the arithmetic is code', () => {
  const said = one('2023-05-10', { speaker: 'Ada', role: 'person', text: 'We met Friday at the market.' });

  it('asks past / future / unclear, and resolves by the rule once the direction is known', async () => {
    const { calls, turns } = await run(said, () => ({ choice: 'past' }));
    const [q] = Object.values(calls[0].questions);
    assert.deepEqual(Object.keys(q.criteria).sort(), ['future', 'past', 'unclear']);
    assert.equal(turns[0][0].times[0].resolution.value, '2023-05-05');
    assert.equal((await run(said, () => ({ choice: 'future' }))).turns[0][0].times[0].resolution.value, '2023-05-12');
  });
  it('unclear gives no day — the weekday stays in the claim\'s words', async () => {
    assert.equal((await run(said, () => ({ choice: 'unclear' }))).turns[0][0].times[0].resolution.precision, 'none');
  });
});

describe('3.4 a forward weekday that names today', () => {
  const onFriday = one('2023-05-12', { speaker: 'Ada', role: 'person', text: 'See you Friday, leaving now!' });

  it('is asked only when the weekday IS the day of speaking', async () => {
    const wed = await run(one('2023-05-10', { speaker: 'Ada', role: 'person', text: 'See you Friday!' }), () => ({ noul: 1 }));
    assert.equal(wed.calls.length, 0);
    assert.equal(wed.turns[0][0].times[0].resolution.value, '2023-05-12');
  });
  it('a likely yes places it today; otherwise the rule — seven days on', async () => {
    assert.equal((await run(onFriday, () => ({ noul: 0.8 }))).turns[0][0].times[0].resolution.value, '2023-05-12');
    assert.equal((await run(onFriday, () => ({ noul: 0.1 }))).turns[0][0].times[0].resolution.value, '2023-05-19');
  });
});

describe('the run keeps every raw answer, and asks per turn in one request', () => {
  it('a turn with two questions is one request; the answers are kept with the backend that gave them', async () => {
    const doc = ['# Notes', '', '## Friday', 'We met Friday. '.repeat(80)].join('\n');
    const { calls, judgements } = await run(one('2023-05-10',
      { speaker: 'Dana', role: 'person', text: 'short' }, { speaker: 'Dana', role: 'person', text: doc }),
      (id, q) => (q.type === 'noul' ? { noul: 0.3 } : { choice: 'past', probabilities: { past: 0.7, future: 0.2, unclear: 0.1 } }));
    assert.equal(calls.length, 1);
    assert.ok(Object.keys(calls[0].questions).length >= 2);
    assert.equal(judgements.length, 1);
    assert.equal(judgements[0].backend, 'jev');
    assert.equal(judgements[0].turnId, '2023-05-10:2');
    const choice = Object.values(judgements[0].answers).find(a => a.type === 'choice');
    assert.deepEqual(choice.probabilities, { past: 0.7, future: 0.2, unclear: 0.1 });
  });

  it('a caption is never searched for dates — it is context, not speech', async () => {
    const { calls, turns } = await run(one('2023-05-10',
      { speaker: 'Ada', role: 'person', text: 'Look! [image: a poster for a concert on Friday]' }), () => ({ choice: 'past' }));
    assert.equal(calls.length, 0);
    assert.deepEqual(turns[0][0].times, []);
  });
});

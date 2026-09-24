/**
 * Phase 7 of the conversation extractor — change over time (`F-31`, DECOMPOSITION.md 7.1–7.6).
 *
 * Candidates (7.1): each claim against the few EARLIER claims about the same entity — earlier by phase 1's
 * order, never page order. One request per later claim, a question set per earlier one:
 *
 *   change:j     choice  replaced / ended / unchanged / unclear   (7.2 + 7.4: did the situation change, and was
 *                                                                  the earlier REPLACED or did it simply end)
 *   stillTrue:j  noul    was the earlier true of its own period    (7.3 — a yes vetoes the supersede)
 *   telling:j    noul    same unchanged world, incompatible telling (7.5 — both dated to their telling)
 *   count:j      choice  replaced / cumulative / neither           (7.6 — asked only when both carry a number)
 *
 * *"Expect very few"* is the prior, and the policy is written for it: only a clear answer supersedes, and
 * *"never retire something the conversation did not retire"*.
 *
 * Run: node --test testing/standalone/the-extractor-tracks-change-over-time.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let trackChange;
before(async () => { ({ trackChange } = await import('../../server/dist/extractor/conversation/change.js')); });

const claim = (text, entityIds, sessionDate) => ({ text, entityIds, sessionDate });
const model = (a) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  return { backend: 'jev', model: 'j', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: q.type, ...a(id, q, state) }])) };
} }; };
const quiet = (id) => (id.startsWith('change') ? { choice: 'unchanged' } : id.startsWith('count') ? { choice: 'neither' } : { noul: 0.1 });

describe('7.1 candidates', () => {
  it('a claim is compared only with earlier claims that share an entity, one request per later claim', async () => {
    const m = model(quiet);
    await trackChange([claim('Ada works at Acme.', ['p1', 'o1'], '2023-01-01'), claim('Bo likes tea.', ['p2'], '2023-02-01'),
      claim('Ada works at Initech.', ['p1', 'o2'], '2023-03-01')], m.decide);
    assert.equal(m.calls.length, 1, 'only the third claim has an earlier one about the same entity');
    assert.deepEqual(Object.keys(m.calls[0].questions).sort(), ['change:0', 'stillTrue:0', 'telling:0']);
  });
  it('the count question is asked only when both claims carry a number', async () => {
    const m = model(quiet);
    await trackChange([claim('Mel has 2 kids.', ['p1'], '2023-01-01'), claim('Mel has 3 kids.', ['p1'], '2023-06-01')], m.decide);
    assert.ok('count:0' in m.calls[0].questions);
  });
});

describe('the policy', () => {
  const job = [claim('Ada works at Acme.', ['p1'], '2023-01-01'), claim('Ada now works at Initech.', ['p1'], '2023-03-01')];
  it('replaced: the earlier is superseded, and the later supersedes it', async () => {
    const r = await trackChange(job, model((id) => (id.startsWith('change') ? { choice: 'replaced' } : { noul: 0.1 })).decide);
    assert.deepEqual(r.superseded, [0]);
    assert.deepEqual(r.supersedes, [{ later: 1, earlier: 0 }]);
  });
  it('ended: the earlier is superseded, and NO edge — nothing replaced it', async () => {
    const r = await trackChange(job, model((id) => (id.startsWith('change') ? { choice: 'ended' } : { noul: 0.1 })).decide);
    assert.deepEqual(r.superseded, [0]);
    assert.deepEqual(r.supersedes, []);
  });
  it('still true of its own period vetoes the supersede — a habit that stopped was still a habit', async () => {
    const r = await trackChange(job, model((id) => (id.startsWith('change') ? { choice: 'replaced' } : id.startsWith('stillTrue') ? { noul: 0.9 } : { noul: 0.1 })).decide);
    assert.deepEqual(r.superseded, []);
  });
  it('unchanged, unclear or a refusal retires nothing', async () => {
    for (const c of ['unchanged', 'unclear', null]) {
      const r = await trackChange(job, model((id) => (id.startsWith('change') ? { choice: c } : { noul: 0.1 })).decide);
      assert.deepEqual(r.superseded, [], String(c));
    }
  });
  it('an incompatible telling of the same world dates BOTH claims to their telling', async () => {
    const r = await trackChange([claim('Ada was born in Oslo.', ['p1'], '2023-01-01'), claim('Ada was born in Bergen.', ['p1'], '2023-06-09')],
      model((id) => (id.startsWith('change') ? { choice: 'unchanged' } : id.startsWith('telling') ? { noul: 0.9 } : { noul: 0.1 })).decide);
    assert.deepEqual(r.superseded, []);
    assert.deepEqual(r.rewritten, { 0: 'As of 1 January 2023, Ada was born in Oslo.', 1: 'As of 9 June 2023, Ada was born in Bergen.' });
  });
  it('a count that grew: replaced supersedes, cumulative dates both, neither leaves both alone', async () => {
    const kids = [claim('Mel has 2 kids.', ['p1'], '2023-01-01'), claim('Mel has 3 kids.', ['p1'], '2023-06-01')];
    const ask = (count) => model((id) => (id.startsWith('change') ? { choice: 'unchanged' } : id.startsWith('count') ? { choice: count } : { noul: 0.1 })).decide;
    assert.deepEqual((await trackChange(kids, ask('replaced'))).superseded, [0]);
    const cum = await trackChange(kids, ask('cumulative'));
    assert.deepEqual([cum.superseded, Object.keys(cum.rewritten)], [[], ['0', '1']]);
    const none = await trackChange(kids, ask('neither'));
    assert.deepEqual([none.superseded, none.rewritten], [[], {}]);
  });
});

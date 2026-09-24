/**
 * Phase 5 of the conversation extractor, the parts that are not writing (`F-31`, DECOMPOSITION.md 5.1, 5.3,
 * 5.7): grouping turns into exchanges (a judgement), linting a written claim (code), and making every turn
 * appear in some claim (code, by construction).
 *
 * Run: node --test testing/standalone/the-extractor-groups-and-lints-claims.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let groupExchanges, lintClaim, coverTurns;
before(async () => {
  ({ groupExchanges, lintClaim, coverTurns } = await import('../../server/dist/extractor/conversation/claims.js'));
});

const session = (key, ...texts) => ({ key, date: '2023-05-10', turns: texts.map((t, i) => ({ id: `${key}:${i + 1}`, speaker: i % 2 ? 'Bo' : 'Ada', speech: t })) });

function model(pick) {
  const calls = [];
  return { calls, decide: async (state, questions) => {
    calls.push({ state, questions });
    return { backend: 'jev', model: 'jev-test', answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: 'choice', choice: pick(id, q), probabilities: null, confidence: null }])) };
  } };
}

describe('5.1 exchanges: the boundary is the judgement', () => {
  it('one request per session; the first turn is never asked — it always starts one', async () => {
    const m = model(() => 'continues');
    await groupExchanges([session('s1', 'a', 'b', 'c'), session('s2', 'd', 'e')], m.decide);
    assert.equal(m.calls.length, 2);
    assert.deepEqual(Object.keys(m.calls[0].questions), ['s1:2', 's1:3']);
    for (const q of Object.values(m.calls[0].questions)) assert.deepEqual(Object.keys(q.criteria).sort(), ['continues', 'neither', 'starts']);
  });

  it('starts splits; continues joins; a session boundary always splits', async () => {
    const r = await groupExchanges([session('s1', 'I adopted a cat', 'aw', 'Also I moved', 'where?'), session('s2', 'hi')],
      model(id => (id === 's1:3' ? 'starts' : 'continues')).decide);
    assert.deepEqual(r.exchanges.map(x => x.turnIds), [['s1:1', 's1:2'], ['s1:3', 's1:4'], ['s2:1']]);
  });

  it('a turn about nothing rides along in the exchange before it, marked so no claim is written from it', async () => {
    const r = await groupExchanges([session('s1', 'I adopted a cat', 'thanks!', 'Also I moved')],
      model(id => (id === 's1:2' ? 'neither' : 'starts')).decide);
    assert.deepEqual(r.exchanges.map(x => x.turnIds), [['s1:1', 's1:2'], ['s1:3']]);
    assert.deepEqual(r.exchanges[0].ridesAlong, ['s1:2']);
  });

  it('a refused answer keeps the turn with the one before — a split is the costlier mistake', async () => {
    const m = { decide: async (s, qs) => ({ backend: 'jev', model: 'j', answers: Object.fromEntries(Object.keys(qs).map(id => [id, { type: 'choice', choice: null, invalid: 'x', probabilities: null, confidence: null }])) }) };
    const r = await groupExchanges([session('s1', 'a', 'b')], m.decide);
    assert.deepEqual(r.exchanges.map(x => x.turnIds), [['s1:1', 's1:2']]);
  });
});

describe('5.3 lint: a claim reads on its own', () => {
  it('every date resolved for the exchange must be in the text', () => {
    assert.deepEqual(lintClaim('Ada adopted a cat.', { dates: ['9 May 2023'] }), ['the resolved date "9 May 2023" is missing']);
    assert.deepEqual(lintClaim('Ada adopted a cat on 9 May 2023.', { dates: ['9 May 2023'] }), []);
  });
  it('no leading pronoun — the subject is named', () => {
    assert.match(lintClaim('She adopted a cat.', {})[0], /pronoun/);
  });
  it('no conversation structure: turn ids, turn numbers, session ordinals', () => {
    for (const bad of ['In D1:3 Ada said so.', 'In the third session Ada moved.', 'At turn 4 Ada left.']) {
      assert.ok(lintClaim(bad, {}).some(p => /structure/.test(p)), bad);
    }
  });
  it('a clean claim has no problems', () => {
    assert.deepEqual(lintClaim('Caroline attended an LGBTQ support group on 7 May 2023.', { dates: ['7 May 2023'] }), []);
  });
});

describe('5.7 every turn appears in some claim', () => {
  it('an uncovered turn joins the claim of its own exchange', () => {
    const exchanges = [{ turnIds: ['s1:1', 's1:2', 's1:3'] }, { turnIds: ['s1:4'] }];
    const claims = [{ text: 'a', sourceTurns: ['s1:1'] }, { text: 'b', sourceTurns: ['s1:4'] }];
    const r = coverTurns(claims, exchanges);
    assert.deepEqual(r.claims[0].sourceTurns, ['s1:1', 's1:2', 's1:3']);
    assert.deepEqual(r.uncovered, []);
  });
  it('an exchange with no claim at all is reported, never silently dropped', () => {
    const r = coverTurns([{ text: 'a', sourceTurns: ['s1:1'] }], [{ turnIds: ['s1:1'] }, { turnIds: ['s1:2', 's1:3'] }]);
    assert.deepEqual(r.uncovered, ['s1:2', 's1:3']);
  });
});

describe('5.6 a claim links the entities its turns mention — and a linked single mention is minted after all (4.8)', () => {
  let linkClaims;
  before(async () => { ({ linkClaims } = await import('../../server/dist/extractor/conversation/claims.js')); });
  const judged = {
    entities: [{ id: 'run:0', name: 'Luna', type: 'animal', group: false, aliases: [], mentions: [{ turnId: 's1:1' }, { turnId: 's2:4' }] }],
    unreturned: [{ id: 'run:1', name: 'Dune', type: 'work', group: false, aliases: [], mentions: [{ turnId: 's1:2' }] },
      { id: 'run:2', name: 'Paris', type: 'place', group: false, aliases: [], mentions: [{ turnId: 's9:9' }] }],
    matchedExisting: [{ id: 'x9', name: 'Caroline', type: 'person', source: 'space', aliases: [], mentions: [{ turnId: 's1:2' }] }],
    speakers: [{ id: 'speaker:Ada', name: 'Ada', type: 'person', group: false, aliases: [], mentions: [{ turnId: 's1:1' }] }],
  };
  it('links what the claim NAMES among what its turns mention — made, existing or a speaker', () => {
    const r = linkClaims([{ text: 'Ada lent Caroline her copy of Dune.', sourceTurns: ['s1:1', 's1:2'] }], judged);
    assert.deepEqual(r.claims[0].entityIds.sort(), ['run:1', 'speaker:Ada', 'x9'], 'Luna was mentioned nearby but the claim is not about her');
  });
  it('an unreturned thing a claim names is minted; one merely in a covered turn is not', () => {
    assert.deepEqual(linkClaims([{ text: 'Ada read Dune.', sourceTurns: ['s1:2'] }], judged).minted.map(e => e.id).sort(), ['run:0', 'run:1']);
    assert.deepEqual(linkClaims([{ text: 'Ada was busy.', sourceTurns: ['s1:2'] }], judged).minted.map(e => e.id), ['run:0'],
      'coverage put the turn in this claim; that alone must not mint what was said in it');
  });
});

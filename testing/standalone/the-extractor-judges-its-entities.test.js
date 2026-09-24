/**
 * Phase 4 of the conversation extractor — the entity judgements and the policy over them (`F-31`,
 * DECOMPOSITION.md 4.12, 4.2, 4.4, 4.5, 4.6, 4.8, 4.9).
 *
 * Code found the mentions (4.1) and dealt each one a hand (4.3). Here the decision model is asked, per turn and
 * in ONE request: is this a thing the conversation is about (4.12), which card is it or is it new (4.4), what
 * type would it be (4.2), does it name a group (4.6). Code then applies the policy: a picked card is a merge
 * (4.5), a new thing needs a type from the SPACE's schema or it is not an entity at all (4.2), and only what the
 * conversation returns to is minted (4.8). Every surface form ends up as an alias of the one entity (4.9).
 *
 * `decide` is handed in, so each test states what the model said.
 *
 * Run: node --test testing/standalone/the-extractor-judges-its-entities.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let judgeEntities, Shortlister;
before(async () => {
  ({ judgeEntities } = await import('../../server/dist/extractor/conversation/judge-entities.js'));
  ({ Shortlister } = await import('../../server/dist/extractor/conversation/shortlist.js'));
});

const TYPES = { person: 'Someone the conversation is about.', animal: 'A pet or other animal.', work: 'A book, film, song or game.' };

/** A model answering from a function of (question id, question), recording every request. */
function model(answer) {
  const calls = [];
  return {
    calls,
    decide: async (state, questions) => {
      calls.push({ state, questions });
      const answers = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = { type: q.type, ...answer(id, q, state) };
      return { backend: 'jev', model: 'jev-test', answers };
    },
  };
}

/** Turns, their mentions (by name), and the speakers: the shape phase 4 receives. */
function input(turns) {
  return {
    turns: turns.map(([id, speaker, speech]) => ({ id, speaker, speech })),
    mentions: new Map(turns.map(([id, , speech, names]) => [id, (names ?? []).map(n => {
      const at = speech.indexOf(n);
      return { turnId: id, start: at, end: at + n.length, text: n, name: n, kind: /^[A-Z]/.test(n) ? 'entity' : 'phrase' };
    })])),
  };
}

const yesThing = (id, q) => (id.startsWith('thing:') ? { noul: 0.9 } : id.startsWith('group:') ? { noul: 0.1 } : undefined);

describe('what is asked, and how often', () => {
  it('one request per turn that has mentions; none for a turn without', async () => {
    const m = model((id, q) => yesThing(id, q) ?? (q.type === 'choice' ? { choice: Object.keys(q.criteria)[0] } : { noul: 0 }));
    const { turns, mentions } = input([['t1', 'Ada', 'We adopted Luna.', ['Luna']], ['t2', 'Bo', 'Nice!', []]]);
    await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(m.calls.length, 1);
  });

  it('the type is chosen from the space\'s own types plus none — nothing else can be written', async () => {
    const m = model((id, q) => yesThing(id, q) ?? (id.startsWith('type:') ? { choice: 'animal' } : { choice: 'new' }));
    const { turns, mentions } = input([['t1', 'Ada', 'We adopted Luna.', ['Luna']]]);
    await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    const type = Object.entries(m.calls[0].questions).find(([id]) => id.startsWith('type:'))[1];
    assert.deepEqual(Object.keys(type.criteria).sort(), ['animal', 'none', 'person', 'work']);
  });

  it('a mention with an empty hand is not asked which card — there is no card to pick', async () => {
    const m = model((id, q) => yesThing(id, q) ?? { choice: 'person' });
    const { turns, mentions } = input([['t1', 'Ada', 'Luna is here.', ['Luna']]]);
    await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.ok(!Object.keys(m.calls[0].questions).some(id => id.startsWith('match:')));
  });
});

describe('the policy over the answers', () => {
  it('a thing mentioned twice, typed, is minted — once, with both surface forms as aliases', async () => {
    const m = model((id, q) => yesThing(id, q) ?? (id.startsWith('type:') ? { choice: 'animal' }
      : { choice: Object.keys(q.criteria).find(k => k !== 'new') ?? 'new' }));
    const { turns, mentions } = input([
      ['t1', 'Ada', 'We adopted Luna.', ['Luna']],
      ['t2', 'Ada', 'luna chewed my shoe', ['luna']],
    ]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0].type, 'animal');
    assert.deepEqual(r.entities[0].aliases, ['luna'], 'the other surface form is an alias');
    assert.deepEqual(r.entities[0].mentions.map(x => x.turnId), ['t1', 't2']);
  });

  it('a thing mentioned once is not minted — the conversation never returned to it', async () => {
    const m = model((id, q) => yesThing(id, q) ?? { choice: 'work' });
    const { turns, mentions } = input([['t1', 'Ada', 'I read Dune once.', ['Dune']]]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(r.entities.length, 0);
    assert.equal(r.unreturned.length, 1, 'kept aside, so a claim that links it can still mint it');
  });

  it('a passing noun, a type of none, or a refused answer makes no entity', async () => {
    const { turns, mentions } = input([['t1', 'Ada', 'Luna, Luna.', ['Luna']], ['t2', 'Ada', 'Luna again', ['Luna']]]);
    for (const answer of [
      (id) => (id.startsWith('thing:') ? { noul: 0.1 } : { choice: 'animal' }),
      (id) => (id.startsWith('thing:') ? { noul: 0.9 } : id.startsWith('group:') ? { noul: 0 } : { choice: 'none' }),
      (id) => (id.startsWith('thing:') ? { noul: null, invalid: 'x' } : { choice: 'animal' }),
      // A type the SPACE does not declare, however it arrived — the choice is the space's types or nothing.
      (id) => (id.startsWith('thing:') ? { noul: 0.9 } : id.startsWith('group:') ? { noul: 0 } : { choice: 'vehicle' }),
    ]) {
      const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: model(answer).decide });
      assert.equal(r.entities.length + r.unreturned.length, 0, 'not minted, and not even kept aside');
    }
  });

  it('a picked card is a merge into the SPACE\'s entity — nothing new is minted for it', async () => {
    const space = { id: 'x9', name: 'Caroline', type: 'person', source: 'space' };
    const s = new Shortlister({ searchSpace: async () => [space] });
    const m = model((id, q) => yesThing(id, q) ?? (id.startsWith('match:') ? { choice: 'x9' } : { choice: 'person' }));
    const { turns, mentions } = input([['t1', 'Ada', 'I met Carolin today.', ['Carolin']]]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: s, decide: m.decide });
    assert.equal(r.entities.length, 0);
    assert.deepEqual(r.matchedExisting.map(x => [x.id, x.mentions.length, x.aliases]), [['x9', 1, ['Carolin']]]);
  });

  it('a pronoun is never a thing itself; it is matched to its referent or dropped', async () => {
    const m = model((id, q) => yesThing(id, q) ?? (id.startsWith('match:') ? { choice: Object.keys(q.criteria).find(k => k !== 'none') } : { choice: 'person' }));
    const { turns, mentions } = input([
      ['t1', 'Ada', 'We adopted Luna.', ['Luna']],
      ['t2', 'Ada', 'She sleeps all day. Luna is lazy.', ['She', 'Luna']],
    ]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    const qs = Object.entries(m.calls[1].questions);
    assert.ok(!qs.some(([id]) => id === 'thing:0'), 'no "is this a thing" for a pronoun');
    const pron = qs.find(([id]) => id === 'match:0')[1];
    assert.ok('none' in pron.criteria, 'a pronoun may refer to nothing on the list');
    assert.equal(r.entities[0].mentions.length, 3, 'Luna twice and "She" once');
  });

  it('a group is one entity, marked as a group', async () => {
    const m = model((id, q) => (id.startsWith('thing:') ? { noul: 0.9 } : id.startsWith('group:') ? { noul: 0.9 } : id.startsWith('type:') ? { choice: 'person' } : { choice: Object.keys(q.criteria).find(k => k !== 'new') ?? 'new' }));
    const { turns, mentions } = input([['t1', 'Mel', 'The kids love it.', ['The kids']], ['t2', 'Mel', 'the kids again', ['the kids']]]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0].group, true);
  });

  it('every request and answer is kept with the run', async () => {
    const m = model((id, q) => yesThing(id, q) ?? { choice: 'animal' });
    const { turns, mentions } = input([['t1', 'Ada', 'We adopted Luna.', ['Luna']]]);
    const r = await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(r.judgements.length, 1);
    assert.equal(r.judgements[0].turnId, 't1');
    assert.equal(r.judgements[0].backend, 'jev');
  });
});

describe('4.7 a merge the dates rule out', () => {
  it('the turn\'s resolved dates reach the judge, and the merge question says they can rule a card out', async () => {
    // A card's description carries its own dates ("released in 2019"); what the judge could not see was that the
    // turn's "yesterday" is 9 May 2023. With both, a card whose dates contradict the turn is not the same thing.
    const m = model((id, q) => yesThing(id, q) ?? { choice: 'new' });
    const { turns, mentions } = input([['t1', 'Ada', 'We adopted Luna yesterday.', ['Luna']]]);
    turns[0].dates = ['9 May 2023'];
    const shortlister = new Shortlister({ searchSpace: async () => [{ id: 'x1', name: 'Luna', type: 'animal', description: 'Luna is a cat Bo adopted in 2019.', source: 'space' }] });
    await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister, decide: m.decide });
    const call = m.calls.find(c => Object.keys(c.questions).some(id => id.startsWith('match:')));
    assert.ok(call, 'a match question was asked');
    assert.deepEqual(call.state.turn.dates, ['9 May 2023']);
    const match = Object.entries(call.questions).find(([id]) => id.startsWith('match:'))[1];
    assert.match(match.instructions.question, /dates/);
  });
  it('a turn with no resolved date carries none — the rule is not invented', async () => {
    const m = model((id, q) => yesThing(id, q) ?? { choice: 'new' });
    const { turns, mentions } = input([['t1', 'Ada', 'We adopted Luna.', ['Luna']]]);
    await judgeEntities({ turns, mentions, entityTypes: TYPES, shortlister: new Shortlister({}), decide: m.decide });
    assert.equal(m.calls[0].state.turn.dates, undefined);
  });
});

/**
 * Phase 4.3 of the conversation extractor: the shortlist a mention is matched against (`F-31`,
 * DECOMPOSITION.md 4.3). 4.4 then asks *"is this mention one of these, or new?"* — so this is judged on
 * whether the right card is IN the hand, never on picking it. The model picks; code deals.
 *
 * Two sources, both bounded: the entities this run has already made, and the SPACE (a second conversation
 * matches against what the first one wrote). One lookup per DISTINCT mention, cached for the run — no list of
 * every person is ever built. Near-misses (*"Carolin"*, *"caroline"*) are kept in the hand on purpose:
 * spelling and casing are the judge's to see past, and a card left out can never be picked.
 *
 * Run: node --test testing/standalone/the-extractor-shortlists-before-it-asks.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let Shortlister, normalizeName;
before(async () => {
  ({ Shortlister, normalizeName } = await import('../../server/dist/extractor/conversation/shortlist.js'));
});

const run = (id, name, type = 'person') => ({ id, name, type, source: 'run' });

describe('names are compared in one normal form', () => {
  it('case, articles, a trailing possessive and punctuation do not make two names', () => {
    assert.equal(normalizeName('The Grand Canyon'), normalizeName('grand canyon'));
    assert.equal(normalizeName("Caroline's"), normalizeName('Caroline'));
    assert.equal(normalizeName('Caroline!'), 'caroline');
  });
});

describe('the run\'s own entities', () => {
  it('an exact name, in any casing, is in the hand', async () => {
    const s = new Shortlister({});
    s.addRunEntity(run('e1', 'Caroline'));
    assert.deepEqual((await s.shortlist('caroline')).map(e => e.id), ['e1']);
  });

  it('a misspelling one or two letters off is in the hand — the judge decides, not the spelling', async () => {
    const s = new Shortlister({});
    s.addRunEntity(run('e1', 'Caroline'));
    s.addRunEntity(run('e2', 'Melanie'));
    assert.deepEqual((await s.shortlist('Carolin')).map(e => e.id), ['e1']);
  });

  it('a shared distinctive word puts it in the hand ("the support group" / "Caroline\'s LGBTQ support group")', async () => {
    const s = new Shortlister({});
    s.addRunEntity(run('g1', "Caroline's LGBTQ support group", 'organization'));
    s.addRunEntity(run('p1', 'Caroline'));
    const ids = (await s.shortlist('the support group')).map(e => e.id);
    assert.ok(ids.includes('g1'), JSON.stringify(ids));
  });

  it('an unrelated name is not', async () => {
    const s = new Shortlister({});
    s.addRunEntity(run('e1', 'Caroline'));
    assert.deepEqual(await s.shortlist('Oscar'), []);
  });
});

describe('the space', () => {
  it('is searched once per distinct mention, and its cards join the run\'s', async () => {
    const asked = [];
    const s = new Shortlister({ searchSpace: async (text) => { asked.push(text); return [{ id: 'x9', name: 'Caroline Smith', type: 'person', source: 'space' }]; } });
    s.addRunEntity(run('e1', 'Caroline'));
    const a = await s.shortlist('Caroline');
    const b = await s.shortlist('caroline');
    assert.deepEqual(a.map(e => e.id), ['e1', 'x9']);
    assert.deepEqual(b.map(e => e.id), ['e1', 'x9']);
    assert.equal(asked.length, 1, 'one lookup per distinct mention, cached for the run');
  });

  it('a card is never dealt twice when both sources hold it', async () => {
    const s = new Shortlister({ searchSpace: async () => [{ id: 'e1', name: 'Caroline', type: 'person', source: 'space' }] });
    s.addRunEntity(run('e1', 'Caroline'));
    assert.deepEqual((await s.shortlist('Caroline')).map(e => e.id), ['e1']);
  });

  it('the hand is bounded', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `Caroline ${i}`, type: 'person', source: 'space' }));
    const s = new Shortlister({ searchSpace: async () => many }, { max: 6 });
    assert.equal((await s.shortlist('Caroline')).length, 6);
  });

  it('an entity added after a lookup is still found — the cache holds the SPACE answer, not the hand', async () => {
    const s = new Shortlister({ searchSpace: async () => [] });
    await s.shortlist('Caroline');
    s.addRunEntity(run('e1', 'Caroline'));
    assert.deepEqual((await s.shortlist('Caroline')).map(e => e.id), ['e1']);
  });
});

describe('recall against the committed extractions, with the real sidecar', () => {
  /*
   * For every extracted entity and every LATER turn it was sourced from: does some mention the finder
   * proposes in that turn deal the entity? The first source turn is excluded — there it is minted, not
   * matched. The run holds the extraction's entities; `recent` is the entities of the previous six turns;
   * the space search is absent here, so a reference that shares no word with its entity ("art" for
   * "painting") counts as a miss even though production's meaning-ranked space search can deal it.
   * Measured 2026-09-24: 85.1% of 618 cases (62.1% before pronouns and recent context were dealt).
   */
  const RECENT_TURNS = 6;
  it('deals the right entity for at least 83% of later mentions', async () => {
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { loadConversations } = await import('../../benchmarks/locomo/loader.mjs');
    const { findMentions } = await import('../../server/dist/extractor/conversation/mentions.js');
    const { isNlpAvailable } = await import('../../server/dist/extractor/conversation/nlp-client.js');
    const { splitCaptions } = await import('../../server/dist/extractor/conversation/classify.js');
    const EX = 'benchmarks/locomo/extractions';
    const files = existsSync(EX) ? readdirSync(EX).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions found — the sweep would be vacuous`);
    const path = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8')).datasets.locomo.cachePath;
    if (!existsSync(path) || !(await isNlpAvailable())) {
      console.log(`SKIPPED: ${!existsSync(path) ? `${path} is not fetched` : 'the NLP sidecar is not running'}. `
        + 'Shortlist recall was NOT measured. Local only.');
      return;
    }
    const byId = new Map(loadConversations(path).map(c => [c.id, c]));
    let cases = 0, dealt = 0;
    for (const f of files) {
      const x = JSON.parse(readFileSync(`${EX}/${f}`, 'utf8'));
      const conv = byId.get(x.conversationId);
      const flat = conv.sessions.flatMap(s => s.turns.map(t => ({ id: t.id, speaker: t.speaker, speech: splitCaptions(t.text).speech })));
      const mentions = await findMentions(conv.sessions.map(s => s.turns.map(t => ({ id: t.id, speaker: t.speaker, speech: splitCaptions(t.text).speech }))));
      const pos = new Map(flat.map((t, i) => [t.id, i]));
      const card = o => o && { id: o.key, name: o.name, type: o.type, source: 'run' };
      const byName = new Map(x.entities.map(o => [o.name.toLowerCase(), o]));
      const speakers = [...new Set(flat.map(t => t.speaker))];
      const s = new Shortlister({}, { max: 6 });
      for (const o of x.entities) s.addRunEntity(card(o));
      for (const e of x.entities) {
        const turns = (e.sourceTurns ?? []).filter(t => pos.has(t)).sort((a, b) => pos.get(a) - pos.get(b));
        for (const t of turns.slice(1)) {
          cases++;
          const i = pos.get(t), turn = flat[i];
          const others = speakers.filter(sp => sp !== turn.speaker);
          // The six TURNS before this one, most recent first — a count of turns, not a character window.
          const prevIds = [];
          for (let k = i - 1; k >= 0 && prevIds.length < RECENT_TURNS; k--) prevIds.push(flat[k].id);
          const recent = prevIds.flatMap(pid => x.entities.filter(o => (o.sourceTurns ?? []).includes(pid))).map(card);
          const ctx = { speaker: card(byName.get(turn.speaker.toLowerCase())),
            addressee: others.length === 1 ? card(byName.get(others[0].toLowerCase())) : undefined, recent };
          for (const m of mentions.get(t) ?? []) {
            if ((await s.shortlist(m.name, ctx)).some(c => c.id === e.key)) { dealt++; break; }
          }
        }
      }
    }
    assert.ok(cases >= 400, `only ${cases} cases — the fixture set shrank, re-derive the floor`);
    console.log(`shortlist recall ${(dealt / cases).toFixed(3)} over ${cases} later mentions`);
    assert.ok(dealt / cases >= 0.83, `shortlist recall ${(dealt / cases).toFixed(3)} over ${cases}`);
  });
});

describe('a mention without a name', () => {
  const ada = { id: 'a', name: 'Ada', type: 'person', source: 'run' };
  const bo = { id: 'b', name: 'Bo', type: 'person', source: 'run' };
  const book = { id: 'k', name: 'The Lean Startup', type: 'work', source: 'run' };
  it('"I" is the speaker and "you" the one spoken to — grammar, dealt in code', async () => {
    const s = new Shortlister({});
    assert.deepEqual((await s.shortlist('I', { speaker: ada, addressee: bo })).map(e => e.id), ['a']);
    assert.deepEqual((await s.shortlist('you', { speaker: ada, addressee: bo })).map(e => e.id), ['b']);
  });
  it('"it" and "the book" are dealt what the recent turns were about — which one is 4.4\'s judgement', async () => {
    const s = new Shortlister({});
    assert.deepEqual((await s.shortlist('it', { recent: [book, bo] })).map(e => e.id), ['k', 'b']);
    assert.ok((await s.shortlist('the book', { recent: [book] })).some(e => e.id === 'k'));
  });
  it('an exact name is dealt before six near ones', async () => {
    const s = new Shortlister({}, { max: 2 });
    for (const n of ["John's bike", "John's blog", "John's family", "John's car"]) s.addRunEntity({ id: n, name: n, type: 'object', source: 'run' });
    assert.equal((await s.shortlist("John's car"))[0].id, "John's car");
  });
});

/**
 * Phase 9.1 of the conversation extractor: the assembled extraction is the COMMITTED format — checked here by
 * the benchmark's own validator against the benchmark's schema, so the extractor cannot drift into a second
 * format the writer does not read.
 *
 * Run: node --test testing/standalone/the-extractor-assembles-the-committed-format.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';

let assembleExtraction, loadConversation;
before(async () => {
  ({ assembleExtraction } = await import('../../server/dist/extractor/conversation/assemble.js'));
  ({ loadConversation } = await import('../../server/dist/extractor/conversation/load.js'));
});
const SCHEMA = JSON.parse(readFileSync('benchmarks/space/schema.json', 'utf8'));

function run() {
  const conversation = loadConversation({ sessions: [
    { date: '2023-05-10', turns: [{ speaker: 'Ada', text: 'We adopted a cat yesterday, Luna!' }, { speaker: 'Bo', text: 'Congrats!' }] },
    { date: '2023-06-01', turns: [{ speaker: 'Ada', text: 'Luna now works as a therapy cat.' }, { speaker: 'Bo', text: 'Wow.' }] },
  ] });
  const [s1, s2] = conversation.sessions;
  const ada = { id: 'speaker:Ada', name: 'Ada', type: 'person', group: false, aliases: [], mentions: [{ turnId: s1.turns[0].id }] };
  const bo = { id: 'speaker:Bo', name: 'Bo', type: 'person', group: false, aliases: [], mentions: [{ turnId: s1.turns[1].id }] };
  const luna = { id: 'run:0', name: 'Luna', type: 'animal', group: false, aliases: ['the cat'], mentions: [{ turnId: s1.turns[0].id }, { turnId: s2.turns[0].id }] };
  return {
    conversationId: 'conv-test', conversation,
    entities: [ada, bo, luna], existing: [],
    descriptions: new Map([['run:0', 'Luna is a cat Ada adopted on 9 May 2023.'], ['speaker:Ada', 'Ada adopted Luna.'], ['speaker:Bo', 'Bo is Ada\'s friend.']]),
    claims: [
      { text: 'Ada adopted a cat named Luna on 9 May 2023.', sourceTurns: s1.turns.map(t => t.id), entityIds: ['speaker:Ada', 'run:0'], speaker: 'Ada', statedOn: s1.date, session: s1.key },
      { text: 'Luna works as a therapy cat.', sourceTurns: s2.turns.map(t => t.id), entityIds: ['run:0'], speaker: 'Ada', statedOn: s2.date, session: s2.key },
    ],
    edges: [{ from: 'speaker:Ada', to: 'run:0', label: 'owns', claims: [0] }],
    events: [{ title: 'Ada adopted a cat named Luna on 9 May 2023.', date: '2023-05-09', status: 'completed', entityIds: ['speaker:Ada', 'run:0'], claim: 0 }],
    change: { superseded: [], supersedes: [], rewritten: {} },
    backends: ['jev', 'assist'],
  };
}

describe('9.1 the assembled extraction', () => {
  it('passes the benchmark validator, against the benchmark schema, with no problems', () => {
    const x = assembleExtraction(run());
    const problems = validateExtraction({ ...x, producedBy: { ...x.producedBy, promptSha256: '0'.repeat(64), schemaSha256: '0'.repeat(64) } }, SCHEMA)
      .filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems, []);
  });

  it('keys are slugs, unique across entities, chrono and claims — and no Ythril id is in a record', () => {
    const x = assembleExtraction(run());
    const keys = [...x.entities.map(e => e.key), ...x.chrono.map(c => c.key), ...x.claims.flatMap(c => (c.key ? [c.key] : []))];
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!JSON.stringify([x.entities, x.claims, x.chrono, x.edges]).includes('run:'), 'run ids never leak into records');
  });

  it('a supersede marks the earlier claim, keys both, and draws claim → claim', () => {
    const r = run();
    r.change = { superseded: [0], supersedes: [{ later: 1, earlier: 0 }], rewritten: {} };
    const x = assembleExtraction(r);
    assert.equal(x.claims[0].superseded, true);
    assert.deepEqual(x.edges.find(e => e.label === 'supersedes'), { label: 'supersedes', from: x.claims[1].key, to: x.claims[0].key });
  });

  it('a claim re-dated to its telling carries the new text', () => {
    const r = run();
    r.change = { superseded: [], supersedes: [], rewritten: { 1: 'As of 1 June 2023, Luna works as a therapy cat.' } };
    assert.equal(assembleExtraction(r).claims[1].text, 'As of 1 June 2023, Luna works as a therapy cat.');
  });

  it('an entity the space already holds is listed by id beside the records, never inside one', () => {
    const r = run();
    r.existing = [{ id: 'x9', name: 'Caroline', type: 'person', source: 'space', aliases: [] }];
    r.claims[0].entityIds.push('x9');
    const x = assembleExtraction(r);
    assert.deepEqual(x.existingEntities, [{ key: 'caroline', id: 'x9' }]);
    assert.ok(x.claims[0].entities.includes('caroline'));
    assert.ok(!x.entities.some(e => e.key === 'caroline'), 'not re-created');
  });
});

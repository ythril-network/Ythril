/**
 * The conversation extractor, end to end, with stand-in models (`F-31`, phases 1–9).
 *
 * A two-session conversation runs through every phase — load, classify, time, mentions, shortlist, entity
 * judgements, exchanges, written and checked claims, descriptions, relations, change over time, timeline,
 * assembly — and the result must pass the BENCHMARK's validator against the benchmark's schema. The stand-ins
 * are deliberately simple: a sidecar that proposes capitalised words, a judge that answers every question the
 * obvious way, a writer that turns the brief into a sentence. What is asserted is that the phases fit together
 * and that the output is the committed format; each phase's own rules are tested in its own file.
 *
 * Run: node --test testing/standalone/the-extractor-runs-end-to-end.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';

let extractConversation;
before(async () => { ({ extractConversation } = await import('../../server/dist/extractor/conversation/extract.js')); });

const SCHEMA = JSON.parse(readFileSync('benchmarks/space/schema.json', 'utf8'));
const vocabulary = {
  entityTypes: Object.fromEntries(SCHEMA.filter(e => e.knowledgeType === 'entity').map(e => [e.typeName, e.description ?? e.typeName])),
  edgeLabels: Object.fromEntries(SCHEMA.filter(e => e.knowledgeType === 'edge').map(e => [e.typeName,
    { description: e.description ?? e.typeName, from: e.schema.endpoints.from, to: e.schema.endpoints.to }])),
};

const source = { sessions: [
  { date: '2023-05-10', turns: [
    { speaker: 'Ada', role: 'person', text: 'We adopted a cat yesterday! Her name is Luna.' },
    { speaker: 'Bo', role: 'person', text: 'Congrats on Luna!' },
  ] },
  { date: '2023-06-01', turns: [
    { speaker: 'Ada', role: 'person', text: 'Luna loves the garden now.' },
    { speaker: 'Bo', role: 'person', text: 'Cute.' },
  ] },
] };

/** Capitalised words as entity spans — enough for Ada, Bo and Luna. */
const spans = async (texts) => texts.map(t => [...t.matchAll(/\b(Luna|Ada|Bo)\b/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, kind: 'entity' })));

/** The obvious answer to every question the extractor asks. */
const decide = async (state, questions) => {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    let a;
    if (q.type === 'noul') a = { noul: /^(thing|supported)/.test(id) ? 0.95 : 0.05 };
    else if (id.startsWith('type:')) a = { choice: /Luna/.test(JSON.stringify(q.instructions)) ? 'animal' : 'person' };
    else if (id.startsWith('match:')) a = { choice: Object.keys(q.criteria).find(k => k !== 'new' && k !== 'none') ?? 'new' };
    else if (id === 'status') a = { choice: 'completed' };
    else if (id.startsWith('rel:')) a = { choice: Object.keys(q.criteria).find(k => k.startsWith('owns:')) ?? 'none' };
    else if (id.startsWith('change:')) a = { choice: 'unchanged' };
    else if (q.criteria && 'continues' in q.criteria) a = { choice: /Congrats|Cute/.test(JSON.stringify(state)) ? 'continues' : 'starts' };
    else a = { choice: Object.keys(q.criteria ?? { none: 1 }).includes('none') ? 'none' : Object.keys(q.criteria)[0] };
    answers[id] = { type: q.type, probabilities: null, confidence: null, ...a };
  }
  return { backend: 'jev', model: 'jev-test', answers };
};

/** A writer that states what the brief hands it: the dates as given, the names, and the first spoken turn. */
const write = async ({ user }) => {
  if (/^Entity: (.+?) \(/.test(user)) return `${user.match(/^Entity: (.+?) \(/)[1]} appears in the conversation.`;
  const dates = (user.match(/use them as written: (.+?)\./) ?? [])[1];
  if (/adopted/.test(user)) return `Ada adopted a cat named Luna${dates ? ` on ${dates}` : ''}.`;
  return 'Luna loves the garden.';
};

describe('end to end, with stand-ins', () => {
  it('produces an extraction the benchmark validator accepts', async () => {
    const r = await extractConversation('conv-e2e', source, vocabulary, { decide, write, spans });
    const x = r.extraction;
    const problems = validateExtraction({ ...x, producedBy: { ...x.producedBy, promptSha256: '0'.repeat(64), schemaSha256: '0'.repeat(64) } }, SCHEMA)
      .filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems, [], JSON.stringify(x, null, 1).slice(0, 3000));
    assert.deepEqual(r.uncovered, []);
  });

  it('the pieces landed: the speakers and Luna, the adoption claim with its resolved date, the event, the edge', async () => {
    const { extraction: x } = await extractConversation('conv-e2e', source, vocabulary, { decide, write, spans });
    assert.deepEqual(x.entities.map(e => e.name).sort(), ['Ada', 'Bo', 'Luna']);
    assert.equal(x.entities.find(e => e.name === 'Luna').type, 'animal');
    const adoption = x.claims.find(c => /adopted/.test(c.text));
    assert.match(adoption.text, /9 May 2023/, 'the date phase 3 resolved from "yesterday" reached the claim');
    assert.ok(x.chrono.some(c => c.date === '2023-05-09' && c.status === 'completed'));
    assert.ok(x.edges.some(e => e.label === 'owns'));
  });

  it('every judgement is kept, with the backend that gave it', async () => {
    const r = await extractConversation('conv-e2e', source, vocabulary, { decide, write, spans });
    assert.ok(r.judgements.length >= 5);
    assert.ok(r.judgements.every(j => j.backend === 'jev'));
  });
});

describe('an assistant in the conversation (5.4 / 5.5)', () => {
  const withAssistant = { sessions: [...source.sessions, { date: '2023-06-02', turns: [
    { speaker: 'Ada', role: 'person', text: 'Which vet should Luna see?' },
    { speaker: 'Vetbot', role: 'assistant', text: 'Luna could see Dr Kim at the Pawsville clinic.' },
  ] }] };
  // The obvious answers, plus: the assistant originated what it said, and the exchange acted on it.
  const deciding = async (state, questions) => {
    const d = await decide(state, questions);
    if (questions.origin) d.answers.origin = { type: 'choice', choice: /Pawsville|Kim/.test(JSON.stringify(state)) ? 'origin' : 'person' };
    if (questions.acted) d.answers.acted = { type: 'noul', noul: 0.9 };
    return d;
  };
  const writing = async (p) => (/Pawsville/.test(p.user) ? 'Luna could see Dr Kim at the Pawsville clinic.' : write(p));

  it('an assistant-originated claim is the assistant\'s, attributed — and the file still validates', async () => {
    const r = await extractConversation('conv-e2e-a', withAssistant, vocabulary, { decide: deciding, write: writing, spans });
    const x = r.extraction;
    const theirs = x.claims.filter(c => c.attributed);
    assert.equal(theirs.length, 1, JSON.stringify(x.claims, null, 1));
    assert.equal(theirs[0].speaker, 'assistant');
    assert.ok(x.claims.filter(c => !c.attributed).every(c => c.speaker !== 'assistant'), 'nobody else gets the mark');
    const problems = validateExtraction({ ...x, producedBy: { ...x.producedBy, promptSha256: '0'.repeat(64), schemaSha256: '0'.repeat(64) } }, SCHEMA)
      .filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems, []);
  });
});

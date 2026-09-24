/**
 * Phase 5.2 + 5.10 of the conversation extractor: one claim per exchange, written by the assist model and then
 * CHECKED — linted in code (5.3) and citation-checked by the decision model (5.10). A claim that fails either is
 * rewritten once with the failure as input, and then dropped and reported: verify and escalate.
 *
 * The writer is handed everything already resolved — dates from phase 3, entity names from phase 4 — so it has
 * nothing to resolve itself. Both models are handed in.
 *
 * Run: node --test testing/standalone/the-extractor-writes-checked-claims.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let writeClaim, formatDate;
before(async () => {
  ({ writeClaim, formatDate } = await import('../../server/dist/extractor/conversation/write-claim.js'));
});

const exchange = {
  sessionDate: '2023-05-10',
  turns: [
    { id: 's1:1', speaker: 'Ada', speech: 'We adopted a cat yesterday! Her name is Luna.' },
    { id: 's1:2', speaker: 'Bo', speech: 'Aw, congrats!' },
  ],
  ridesAlong: ['s1:2'],
  dates: [{ precision: 'day', value: '2023-05-09' }],
  entities: ['Ada', 'Luna'],
};

const writer = (...texts) => { const calls = []; return { calls, write: async (p) => { calls.push(p); return texts.shift(); } }; };
const judge = (...supported) => { const calls = []; return { calls, decide: async (state, questions) => {
  calls.push({ state, questions });
  const p = supported.shift();
  return { backend: 'jev', model: 'j', answers: { supported: p === null ? { type: 'noul', noul: null, invalid: 'x' } : { type: 'noul', noul: p } } };
} }; };

describe('dates are written the way a reader reads them', () => {
  it('day, month and year precision', () => {
    assert.equal(formatDate({ precision: 'day', value: '2023-05-09' }), '9 May 2023');
    assert.equal(formatDate({ precision: 'month', value: '2023-03' }), 'March 2023');
    assert.equal(formatDate({ precision: 'year', value: '2021' }), '2021');
    assert.equal(formatDate({ precision: 'none' }), null);
  });
});

describe('write, lint, check', () => {
  it('the writer is handed the resolved date and the names, and a clean supported claim is kept', async () => {
    const w = writer('Ada adopted a cat named Luna on 9 May 2023.');
    const j = judge(0.95);
    const r = await writeClaim(exchange, { write: w.write, decide: j.decide });
    assert.equal(r.claim.text, 'Ada adopted a cat named Luna on 9 May 2023.');
    assert.deepEqual(r.claim.sourceTurns, ['s1:1', 's1:2'], 'the ride-along turn is cited, not written from');
    assert.match(w.calls[0].user, /9 May 2023/);
    assert.match(w.calls[0].user, /Luna/);
    assert.doesNotMatch(w.calls[0].user, /congrats/, 'a turn about nothing is not handed to the writer');
    assert.equal(r.attempts, 1);
  });

  it('a lint failure is rewritten once, with the problem named to the writer', async () => {
    const w = writer('She adopted a cat.', 'Ada adopted a cat named Luna on 9 May 2023.');
    const r = await writeClaim(exchange, { write: w.write, decide: judge(0.9).decide });
    assert.equal(r.attempts, 2);
    assert.match(w.calls[1].user, /pronoun/);
    assert.match(w.calls[1].user, /9 May 2023/);
    assert.equal(r.claim.text, 'Ada adopted a cat named Luna on 9 May 2023.');
  });

  it('an unsupported claim is rewritten once, then dropped and reported — never kept', async () => {
    const r = await writeClaim(exchange, {
      // Wrong in a way only a judge can see: no name, number or date the evidence gate could refute.
      write: writer('Ada adopted a dog named Luna on 9 May 2023.', 'Ada bought a cat named Luna on 9 May 2023.').write,
      decide: judge(0.1, 0.2).decide,
    });
    assert.equal(r.claim, null);
    assert.match(r.dropped.reason, /not supported/);
    assert.equal(r.attempts, 2);
  });

  it('a refused citation check is not a pass', async () => {
    const r = await writeClaim(exchange, { write: writer('Ada adopted a cat named Luna on 9 May 2023.', 'Ada adopted a cat named Luna on 9 May 2023.').write, decide: judge(null, null).decide });
    assert.equal(r.claim, null);
  });

  it('a claim code can prove wrong never reaches the judge — rewritten with the proof as the reason', async () => {
    const w = writer('Ada adopted a cat named Bella on 9 May 2023.', 'Ada adopted a cat named Luna on 9 May 2023.');
    const j = judge(0.9);
    const r = await writeClaim(exchange, { write: w.write, decide: j.decide });
    assert.equal(j.calls.length, 1, 'only the second, clean attempt was judged');
    assert.match(w.calls[1].user, /Bella/);
    assert.equal(r.claim.text, 'Ada adopted a cat named Luna on 9 May 2023.');
  });

  it('the citation check is asked about the claim against its own turns', async () => {
    const j = judge(0.9);
    await writeClaim(exchange, { write: writer('Ada adopted a cat named Luna on 9 May 2023.').write, decide: j.decide });
    assert.equal(j.calls[0].questions.supported.type, 'noul');
    assert.match(JSON.stringify(j.calls[0].state), /Her name is Luna/);
    assert.match(JSON.stringify(j.calls[0].questions.supported.instructions), /adopted a cat named Luna/);
  });
});

describe('2.5 pasted material yields one claim about the paste, never its contents', () => {
  const pasted = 'CLINICAL NOTE. Patient presents with elevated markers. '.repeat(40);
  const pasteExchange = {
    sessionDate: '2023-05-10',
    turns: [{ id: 's1:5', speaker: 'Ada', speech: `Can you explain this? ${pasted}`, pasted: true }],
    ridesAlong: [],
    dates: [],
    entities: ['Ada'],
  };

  it('the writer is told it is pasted material, and shown a bounded preview rather than the document', async () => {
    const w = writer('Ada shared a clinical note and asked for it to be explained.');
    await writeClaim(pasteExchange, { write: w.write, decide: judge(0.9).decide });
    assert.match(w.calls[0].user, /pasted/i);
    assert.ok(w.calls[0].user.length < pasted.length, 'the whole paste is not handed to the writer');
    assert.match(w.calls[0].system, /pasted/i, 'the rule is in the instructions, not left to the model');
  });

  it('a turn that is not pasted is handed over whole, as before', async () => {
    const w = writer('Ada adopted a cat named Luna on 9 May 2023.');
    await writeClaim(exchange, { write: w.write, decide: judge(0.9).decide });
    assert.doesNotMatch(w.calls[0].user, /pasted/i);
  });
});

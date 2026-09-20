/**
 * An event that happened over a weekend reaches the store with both of its ends.
 *
 * ## What this is fixing, and how it was found
 *
 * `B-14`, from the ten unattended extractions of `B-4`. A chrono record in Ythril carries `startsAt` **and**
 * `endsAt` — the REST route validates both. The extraction format offered only a single `date`, the writer
 * mapped that onto `startsAt`, and all five chrono types were worded as single-dated. So a two-day event was
 * inexpressible, and **five separate extractions each invented the same fallback**: write the span into the
 * sentence and emit no chrono entry at all.
 *
 * The cost is not theoretical and it is not evenly spread. A marriage, a gastritis diagnosis, a pride parade
 * and a career-high game are absent from the timeline, while a photograph taken on a named Friday is on it —
 * so what reaches the timeline was decided by the grammar somebody happened to use, not by whether the event
 * mattered. Measured across the ten: chrono entries per 1,000 turns ranged from 10.3 to 67.8, a 6.6x spread
 * from one prompt and one model.
 *
 * ## Why the cases are shaped this way
 *
 * **Passing a field through is the easy half and it is not what goes wrong.** What goes wrong is the span
 * that runs backwards, the span written as something other than a date, and the `endsAt: undefined` that a
 * spread leaves behind on every single-day record in the corpus. Each of those produces a record the store
 * accepts, so the refusals belong here rather than in a 400 nobody reads.
 *
 * **And the doc is asserted against the code**, because a format the model reads and a writer the format
 * describes are two copies of one fact. A field the writer supports and the format never mentions is a
 * capability no extractor knows it has — which is precisely how this one stayed invisible for ten
 * conversations.
 *
 * Run: node --test testing/standalone/a-two-day-event-reaches-the-store-as-a-span.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';
import { writeSpace, loadSpaceDefinition } from '../../benchmarks/writer/write-space.mjs';
import { recordingYthril } from '../_shared/recording-ythril-client.mjs';

const { entries } = loadSpaceDefinition();

/** The smallest extraction that writes one chrono entry, with whatever dating the case is about. */
const withChrono = (chrono) => ({
  conversationId: 'conv-x',
  sessions: [{ date: '2023-07-17', turns: ['D1:1'] }],
  entities: [{ key: 'ada', type: 'person', name: 'Ada',
    description: 'Ada, one of the two speakers in this conversation.' }],
  chrono: [{ key: 'k', type: 'event', title: 'Ada went to the parade', entities: ['ada'], ...chrono }],
  claims: [{ text: 'Ada went to the parade.', speaker: 'Ada', statedOn: '2023-07-17',
    entities: ['ada'], chrono: ['k'], sourceTurns: ['D1:1'] }],
});

const write = async (extraction) => {
  const ythril = recordingYthril();
  await writeSpace({ extraction, ythril, space: 's' });
  return ythril.wrote.chrono[0];
};

describe('a span is accepted and reaches the store', () => {
  it('the validator accepts a chrono entry with both ends', () => {
    assert.deepEqual(validateExtraction(withChrono({ date: '2023-07-15', endsAt: '2023-07-16' }), entries), []);
  });

  it('and the writer sends both, mapped onto the store\'s field names', async () => {
    const record = await write(withChrono({ date: '2023-07-15', endsAt: '2023-07-16' }));
    assert.equal(record.startsAt, '2023-07-15');
    assert.equal(record.endsAt, '2023-07-16', 'the second end was dropped, which is the whole defect');
  });

  it('a single-day event carries NO endsAt key at all', async () => {
    // Not `endsAt: undefined`. A spread leaves that behind on every one-day record in the corpus, and a
    // record whose absent field is present-and-undefined reads differently to every consumer that checks
    // with `in` — including the sync schemas, which strip what they do not declare.
    const record = await write(withChrono({ date: '2023-07-15' }));
    assert.equal('endsAt' in record, false);
    assert.equal(record.startsAt, '2023-07-15');
  });
});

describe('the refusals, which are the half a pass-through would skip', () => {
  it('REFUSES a span that runs backwards', () => {
    // The store takes it. Two ISO strings in the wrong order is a valid record and an event that ended
    // before it began — and nothing downstream reads it as anything but a date range.
    const problems = validateExtraction(withChrono({ date: '2023-07-16', endsAt: '2023-07-15' }), entries);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /before it (starts|began)|ends before/i);
  });

  it('refuses an endsAt that is not a resolved date', () => {
    for (const bad of ['last weekend', '2023-07', '16 July 2023']) {
      const problems = validateExtraction(withChrono({ date: '2023-07-15', endsAt: bad }), entries);
      assert.equal(problems.length >= 1, true, `'${bad}' was accepted as a date`);
    }
  });

  it('accepts a span of one day, because a same-day range is not an error', () => {
    // An extractor that writes both ends for a one-day event is being explicit, not wrong. Refusing it
    // would push it back to the ambiguity this field exists to remove.
    assert.deepEqual(validateExtraction(withChrono({ date: '2023-07-15', endsAt: '2023-07-15' }), entries), []);
  });

  it('refuses an endsAt with no date to start from', () => {
    const problems = validateExtraction(withChrono({ endsAt: '2023-07-16' }), entries);
    assert.equal(problems.length >= 1, true, 'an end with no beginning was accepted');
  });
});

describe('the format tells an extractor the field exists', () => {
  it('the extraction format documents endsAt', () => {
    // The copy that matters. The writer supporting a field the format never mentions is a capability no
    // extractor knows it has, which is exactly how this one stayed invisible across ten conversations.
    const doc = readFileSync('benchmarks/plan/extraction-format.md', 'utf8');
    assert.match(doc, /endsAt/, 'the format does not mention endsAt, so nothing reading it will ever write one');
  });

  it('and the prompt says what a two-day event gets', () => {
    const prompt = readFileSync('benchmarks/prompt/extraction.md', 'utf8');
    assert.match(prompt, /endsAt/,
      'the prompt never names endsAt. Five extractions independently dropped weekend events from the '
      + 'timeline because nothing told them there was anywhere to put one.');
  });
});

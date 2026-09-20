/**
 * Whether a dated thing has happened is a FIELD, not a type, and the extraction now says it.
 *
 * ## The duplication this removes
 *
 * A Ythril chrono entry carries `status` — `upcoming`, `active`, `completed`, `cancelled`, with `overdue`
 * derived per type by `datePassedPolicy` and never stored. The benchmark space instead declared five chrono
 * TYPES, of which `plan` and `deadline` say only that the thing has not happened yet, and
 * `writer/write-space.mjs` set title, type, dates, description and entities — **never `status`**.
 *
 * So the extraction encoded in the type what the store carries in a field, and the weaker of the two won
 * because nothing plumbed the stronger one through. That is this repo's named defect class, and it is the
 * same shape as the `endsAt` gap found hours earlier: a field the store has, the format never mentions, and
 * the writer therefore cannot send.
 *
 * ## The evidence for retiring the types rather than keeping both
 *
 * Across 5,882 turns of extracted conversation: `deadline` collected **one** record — *"Dave hoped to have
 * the Mustang fully restored"*, an aspiration rather than a due date — and `prediction` collected **none**.
 * `milestone` is a reader's opinion about importance, recalled at 57% by a classifier and disputed by ten
 * separate extractions that all had the schema in front of them. Nothing in the product filters on
 * significance.
 *
 * *"Joanna planned to visit Nate"* is an `event` with `status: upcoming`. It is not a different kind of
 * thing.
 *
 * ## What this refuses, and why each refusal is not decoration
 *
 * `overdue` is DERIVED and never stored; writing it would put a value in the collection that the read path
 * computes, so the two could disagree. And a status must be declared rather than defaulted, for the same
 * reason `unattended` is: a caller that omits it is the caller whose record has no answer.
 *
 * Run: node --test testing/standalone/a-chrono-entry-says-whether-it-happened.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction } from '../../benchmarks/writer/validate-extraction.mjs';
import { writeSpace, loadSpaceDefinition } from '../../benchmarks/writer/write-space.mjs';
import { recordingYthril } from '../_shared/recording-ythril-client.mjs';

const { entries } = loadSpaceDefinition();

const withChrono = (chrono) => ({
  conversationId: 'conv-x',
  sessions: [{ date: '2023-07-17', turns: ['D1:1'] }],
  entities: [{ key: 'ada', type: 'person', name: 'Ada', description: 'Ada, one of the two speakers.' }],
  chrono: [{ key: 'k', type: 'event', title: 'Ada went to the parade', entities: ['ada'], ...chrono }],
  claims: [{ text: 'Ada went to the parade.', speaker: 'Ada', statedOn: '2023-07-17',
    entities: ['ada'], chrono: ['k'], sourceTurns: ['D1:1'] }],
});

const write = async (extraction) => {
  const ythril = recordingYthril();
  await writeSpace({ extraction, ythril, space: 's' });
  return ythril.wrote.chrono[0];
};

describe('the vocabulary is one type now', () => {
  it('the schema declares `event` and nothing else for chrono', () => {
    const chronoTypes = entries.filter(e => e.knowledgeType === 'chrono').map(e => e.typeName).sort();
    assert.deepEqual(chronoTypes, ['event'],
      'chrono types other than `event` are still declared. `plan` and `deadline` said only that a thing had '
      + 'not happened, which `status` says; `milestone` was an opinion about importance that nothing reads.');
  });

  it('and the retired ones are refused rather than quietly accepted', () => {
    for (const type of ['plan', 'deadline', 'prediction', 'milestone']) {
      const problems = validateExtraction(withChrono({ date: '2023-07-15', status: 'completed', type }), entries);
      assert.ok(problems.length >= 1, `'${type}' is still accepted as a chrono type`);
    }
  });
});

describe('status reaches the store', () => {
  it('a completed event is written with its status', async () => {
    const record = await write(withChrono({ date: '2023-07-15', status: 'completed' }));
    assert.equal(record.status, 'completed');
  });

  it('an intended one is `upcoming`, which is what `plan` used to mean', async () => {
    const record = await write(withChrono({ date: '2023-09-01', status: 'upcoming' }));
    assert.equal(record.status, 'upcoming');
    assert.equal(record.type, 'event', 'it is an event that has not happened yet, not another kind of thing');
  });

  it('a cancelled one records that it was called off', async () => {
    const record = await write(withChrono({ date: '2023-09-01', status: 'cancelled' }));
    assert.equal(record.status, 'cancelled');
  });
});

describe('the refusals', () => {
  it('REFUSES `overdue`, which the read path derives and nothing may store', () => {
    // Writing it puts a value in the collection that `deriveChronoStatus` computes on read, so the stored
    // and returned answers could disagree — and the derived one is the one an operator sees.
    const problems = validateExtraction(withChrono({ date: '2023-07-15', status: 'overdue' }), entries);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /derived|never stored/i);
  });

  it('refuses a status the store does not have', () => {
    for (const bad of ['done', 'planned', 'COMPLETED', '']) {
      assert.ok(validateExtraction(withChrono({ date: '2023-07-15', status: bad }), entries).length >= 1,
        `'${bad}' was accepted as a status`);
    }
  });

  it('refuses a chrono entry with NO status rather than defaulting one', () => {
    // The same asymmetry as `unattended`: a caller that omits it is the caller whose record has no answer,
    // and a default would make every silent omission read as a deliberate claim.
    const problems = validateExtraction(withChrono({ date: '2023-07-15' }), entries);
    assert.ok(problems.length >= 1, 'a chrono entry with no status was accepted');
    assert.match(problems.join('\n'), /status/);
  });
});

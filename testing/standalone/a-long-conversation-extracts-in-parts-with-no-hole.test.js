/**
 * An extraction delivered in several parts merges into one file, and a missing part is refused.
 *
 * ## Why parts exist at all, measured rather than assumed
 *
 * The tracker recorded a third structural difference between LoCoMo and LongMemEval as *"a history runs to
 * 500 sessions rather than 20"*. Measured from the pinned file, that is wrong twice: 500 is the number of
 * INSTANCES, and the 500-sessions figure belongs to `longmemeval_m`, which is not pinned. A real
 * `longmemeval_s` history is 39–66 sessions (median 50) and 396–616 turns (median 492).
 *
 * So the INPUT is not the problem — ~140k tokens reads in one pass on any long-context model. **The output
 * is.** `conv-26` is 419 turns and its committed extraction is 133 KB; a median LongMemEval history is 17%
 * longer, so ~45k tokens of JSON in a single reply. That fits inside a couple of frontier models and
 * nothing else, and this prompt's stated goal is to be model-portable: *"any model of comparable reasoning
 * strength should produce a comparable graph"*. A protocol that only works above a 64k output cap is a
 * finding about the model, not about the memory.
 *
 * ## What a hand-written merge drops, which is why this is a module
 *
 * **A missing part.** Concatenating arrays from three files when there were four produces a file that is
 * structurally perfect and describes three-quarters of a conversation. Every downstream check passes: the
 * types are declared, the keys resolve, the dates parse. The hole is invisible until a question about the
 * lost sessions returns nothing, which reads as a retrieval failure.
 *
 * So a part DECLARES its place — `part: { index, of }` — and the merge refuses anything but a complete run.
 * Nothing else in the pipeline can see that a part is absent, because absence has no evidence anywhere else.
 *
 * ## Identity across parts is the other half
 *
 * *"Identity is the whole job"*, says the prompt: a mention in session 3 and one in session 18 must be one
 * node. A later part that cannot see the keys already minted invents new ones, and two keys for one thing
 * is the failure that makes the graph useless. So a part carries the whole entity, and the merge reconciles
 * by key — later wins on description, because an entity's description is written from the whole
 * conversation and grows as it goes.
 *
 * Run: node --test testing/standalone/a-long-conversation-extracts-in-parts-with-no-hole.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtractionParts } from '../../benchmarks/writer/merge-extraction.mjs';

const part = (index, of, extra = {}) => ({
  conversationId: 'conv-x',
  part: { index, of },
  sessions: [], entities: [], chrono: [], edges: [], claims: [],
  ...extra,
});

const ADA = { key: 'ada', type: 'person', name: 'Ada', description: 'An engineer.' };

describe('a complete run merges', () => {
  it('every array is concatenated in part order', () => {
    const merged = mergeExtractionParts([
      part(1, 2, {
        sessions: [{ date: '2023-01-01', turns: ['D1:1'] }],
        entities: [ADA],
        claims: [{ text: 'Ada joined Acme.', speaker: 'Ada', statedOn: '2023-01-01', entities: ['ada'], sourceTurns: ['D1:1'] }],
      }),
      part(2, 2, {
        sessions: [{ date: '2023-06-01', turns: ['D2:1'] }],
        claims: [{ text: 'Ada left Acme.', speaker: 'Ada', statedOn: '2023-06-01', entities: ['ada'], sourceTurns: ['D2:1'] }],
      }),
    ]);
    assert.equal(merged.conversationId, 'conv-x');
    assert.deepEqual(merged.sessions.map(s => s.date), ['2023-01-01', '2023-06-01']);
    assert.equal(merged.claims.length, 2);
    assert.equal(merged.entities.length, 1);
    assert.equal(merged.part, undefined, 'the merged file is one extraction, not a part of anything');
  });

  it('parts arriving out of order are ordered by index, not by arrival', () => {
    const merged = mergeExtractionParts([
      part(2, 2, { sessions: [{ date: '2023-06-01' }] }),
      part(1, 2, { sessions: [{ date: '2023-01-01' }], entities: [ADA], claims: [{ text: 'x' }] }),
    ]);
    assert.deepEqual(merged.sessions.map(s => s.date), ['2023-01-01', '2023-06-01']);
  });

  it('a single part with no part block passes straight through', () => {
    // Every LoCoMo extraction is one part and none of them declares one. A protocol that made the short
    // case pay for the long one would be a migration of ten committed files for nothing.
    const whole = { conversationId: 'conv-26', sessions: [], entities: [], chrono: [], edges: [], claims: [] };
    assert.deepEqual(mergeExtractionParts([whole]), whole);
  });
});

describe('a hole is refused, because nothing downstream can see one', () => {
  it('a missing middle part', () => {
    assert.throws(() => mergeExtractionParts([part(1, 3), part(3, 3)]), /part 2 .*missing|missing.*2/i);
  });

  it('a missing LAST part — the one a loop stops before noticing', () => {
    assert.throws(() => mergeExtractionParts([part(1, 3), part(2, 3)]), /3/);
  });

  it('the same part twice', () => {
    assert.throws(() => mergeExtractionParts([part(1, 2), part(1, 2), part(2, 2)]), /twice|duplicate/i);
  });

  it('parts that disagree about how many there are', () => {
    // Two runs of the same conversation, spliced. The counts are the only evidence that happened.
    assert.throws(() => mergeExtractionParts([part(1, 2), part(2, 3)]), /disagree|of 2|of 3/i);
  });

  it('parts from different conversations', () => {
    const other = part(2, 2);
    other.conversationId = 'conv-y';
    assert.throws(() => mergeExtractionParts([part(1, 2), other]), /conv-y|different conversation/i);
  });

  it('no parts at all', () => {
    assert.throws(() => mergeExtractionParts([]), /no parts/i);
  });
});

describe('identity survives the seam', () => {
  it('an entity named in two parts stays ONE entity', () => {
    const later = { ...ADA, description: 'An engineer; joined Acme in 2021 and left in June 2023.' };
    const merged = mergeExtractionParts([
      part(1, 2, { entities: [ADA], claims: [{ text: 'a' }] }),
      part(2, 2, { entities: [later] }),
    ]);
    assert.equal(merged.entities.length, 1, 'two keys for one thing is the failure that makes a graph useless');
    assert.equal(merged.entities[0].description, later.description,
      'the later part saw more of the conversation, so its description is the more complete one');
  });

  it('an entity whose TYPE changed between parts is refused rather than silently resolved', () => {
    // Picking a winner here would bury a real disagreement: one of the two parts misread the subject, and
    // whichever way it resolves, the edges drawn in the other part now run to the wrong kind of thing.
    const retyped = { ...ADA, type: 'organization' };
    assert.throws(() => mergeExtractionParts([
      part(1, 2, { entities: [ADA] }), part(2, 2, { entities: [retyped] }),
    ]), /'ada'.*person.*organization|type/i);
  });

  it('aliases and sourceTurns are unioned, not replaced', () => {
    const first = { ...ADA, properties: { aliases: 'Ada L.' }, sourceTurns: ['D1:1'] };
    const second = { ...ADA, properties: { aliases: 'Adie' }, sourceTurns: ['D2:4'] };
    const merged = mergeExtractionParts([
      part(1, 2, { entities: [first] }), part(2, 2, { entities: [second] }),
    ]);
    const e = merged.entities[0];
    assert.deepEqual(e.sourceTurns, ['D1:1', 'D2:4'],
      'an entity is synthesised from every session that mentions it, so its provenance is the union');
    assert.match(e.properties.aliases, /Ada L\./);
    assert.match(e.properties.aliases, /Adie/);
  });

  it('a claim key reused across parts is refused', () => {
    // One namespace, and the seam is exactly where a model forgets what it already minted.
    assert.throws(() => mergeExtractionParts([
      part(1, 2, { claims: [{ key: 'k', text: 'a' }] }),
      part(2, 2, { claims: [{ key: 'k', text: 'b' }] }),
    ]), /'k'/);
  });
});

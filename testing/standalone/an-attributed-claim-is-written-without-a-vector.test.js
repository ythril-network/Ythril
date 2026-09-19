/**
 * A claim an assistant originated is stored so that nothing can RANK it.
 *
 * ## The decision, and why suppression is the mechanism
 *
 * Owner, 2026-09-19, on returning attributed claims like any other: *"(2) fills context very often with
 * stuff thats not interesting"* — and on excluding them: that hides real content. Suppression is the one
 * mechanism that is neither. A record with no vector cannot be ranked by `recall` even deliberately, while
 * `filter`, `graph_traverse` and recall's own expansion still reach it in full, because the walk follows
 * links and never consults a vector.
 *
 * That property is verified against a live instance in
 * `testing/integration/a-suppressed-record-is-unranked-but-still-reached.test.js`. This file asserts the
 * other half: that the writer actually stores an attributed claim that way.
 *
 * ## DERIVED, never set beside the mark
 *
 * Two fields meaning one thing drift, and the drift here is invisible: a claim marked `attributed` that
 * still carries a vector is back to competing for ranked slots, silently, in an answer somebody asked a
 * question to get. So the suppression follows the mark in one expression, and this asserts the pairing in
 * both directions rather than the presence of either.
 *
 * Run: node --test testing/standalone/an-attributed-claim-is-written-without-a-vector.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeSpace } from '../../benchmarks/writer/write-space.mjs';

/** The smallest schema the writer will accept: it reads the claim type's name out of this. */
const SCHEMA = [
  { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: {} } },
  { knowledgeType: 'fact', typeName: 'utterance', schema: { propertySchemas: {} } },
];

/** A client that records what it was asked to write and invents ids, so the writer runs for real. */
function recordingClient() {
  let n = 0;
  const wrote = { memories: [], entities: [], chrono: [], edges: [], files: [] };
  const id = () => `id-${++n}`;
  return {
    wrote,
    createSpace: async () => ({}),
    writeEntity: async (_s, r) => { wrote.entities.push(r); return { id: id() }; },
    writeChrono: async (_s, r) => { wrote.chrono.push(r); return { id: id() }; },
    writeMemory: async (_s, r) => { wrote.memories.push(r); return { id: id() }; },
    writeEdge: async (_s, r) => { wrote.edges.push(r); return { id: id() }; },
    writeFile: async (_s, r) => { wrote.files.push(r); return { id: id() }; },
  };
}

const extractionWith = claims => ({
  conversationId: 'conv-x',
  schema: SCHEMA,
  sessions: [{ date: '2023-05-08', text: 'Ada: hello' }],
  entities: [{ key: 'ada', type: 'person', name: 'Ada', description: 'An engineer.' }],
  chrono: [],
  edges: [],
  claims,
});

async function write(claims) {
  const ythril = recordingClient();
  await writeSpace({ extraction: extractionWith(claims), ythril, space: 'test-space', schemaEntries: SCHEMA });
  return ythril.wrote.memories;
}

const PERSON = {
  text: 'Ada started working at Acme in March 2021.', speaker: 'Ada', statedOn: '2023-05-08',
  entities: ['ada'], sourceTurns: ['D1:1'],
};
const ASSISTANT = {
  text: 'The assistant recommended two budget hostels in Amsterdam.', speaker: 'assistant',
  attributed: true, statedOn: '2023-05-08', entities: ['ada'], sourceTurns: ['D1:2'],
};

describe('the writer runs and the fixture reaches it', () => {
  it('writes one record per claim', async () => {
    // A floor: an assertion over an empty list passes while checking nothing, and every case below is a
    // statement about what a written record carries.
    const written = await write([PERSON, ASSISTANT]);
    assert.equal(written.length, 2, `expected both claims to be written, got ${written.length}`);
  });
});

describe('an attributed claim is written without a vector', () => {
  it('carries the mark AND the suppression', async () => {
    const [, assistant] = await write([PERSON, ASSISTANT]);
    assert.equal(assistant.properties?.attributed, true, 'the mark must reach the record');
    assert.equal(assistant.suppressEmbeddings, true,
      'an attributed claim must be stored with no vector, or it competes for a ranked slot against the '
      + 'things a person actually said');
  });

  it('and a person\'s claim carries neither', async () => {
    const [person] = await write([PERSON, ASSISTANT]);
    assert.equal(person.properties?.attributed, undefined,
      'absence is the default — present-and-false is a different row to every predicate anybody writes');
    assert.notEqual(person.suppressEmbeddings, true,
      'suppressing a person\'s claim would retire a real fact from ranking, which is the quiet failure');
  });

  it('the suppression FOLLOWS the mark rather than sitting beside it', async () => {
    /*
     * The pairing, asserted as a pairing. Two fields meaning one thing drift, and this drift is invisible:
     * a claim that says it is attributed while still carrying a vector is back to competing for slots and
     * nothing reports it.
     */
    for (const claim of [PERSON, ASSISTANT]) {
      const [written] = await write([claim]);
      const marked = written.properties?.attributed === true;
      const unranked = written.suppressEmbeddings === true;
      assert.equal(marked, unranked,
        `'${claim.speaker}' produced a record where attributed=${marked} and suppressEmbeddings=${unranked}. `
        + 'They are one decision and must not be able to disagree.');
    }
  });
});

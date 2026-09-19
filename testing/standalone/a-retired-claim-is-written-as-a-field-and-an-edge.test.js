/**
 * A claim a later session retired is written marked, and the edge that names its replacement is a real
 * claim-to-claim edge.
 *
 * ## What the writer has to get right, and neither half is obvious
 *
 * **The mark is a record FIELD, not a property — the opposite of `attributed`, one line away in the same
 * writer.** That looks arbitrary until you ask whose vocabulary each belongs to. `attributed` is this
 * corpus's: a property declared on the claim type, meaningful in the benchmark space and nowhere else.
 * `superseded` is the product's, on every fact, entity, edge and chrono entry in every space. Writing it
 * as a property would put a second spelling of a real field into the one space anybody reads to judge the
 * product — and `properties.superseded` and `superseded` are different rows to every predicate anybody
 * writes, so nothing would notice.
 *
 * **The edge ends are CLAIMS, so the writer has to say so.** An edge declares the kind at each end and a
 * wrong one is refused at the write. Every end was an entity until supersession, so the writer resolved
 * `from` and `to` in the entity map alone — a claim key would have resolved to `undefined`, and the
 * instance would have answered `\`from\` string required`, which names the wrong problem on request 340.
 *
 * ## It does NOT suppress, and that is the assertion worth keeping
 *
 * Attribution and retirement are both "trust this less", and the mechanism is opposite: an attributed
 * claim is stored with no vector so nothing can rank it, and a superseded one keeps its vector and keeps
 * ranking. Hiding it would make *"where DID she work?"* unanswerable in order to fix *"where does she
 * work?"* — the owner's own objection, 2026-09-19. So the pairing is asserted in both directions here,
 * because the natural mistake is to copy the line above it.
 *
 * Run: node --test testing/standalone/a-retired-claim-is-written-as-a-field-and-an-edge.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeSpace } from '../../benchmarks/writer/write-space.mjs';
import { recordingYthril } from '../_shared/recording-ythril-client.mjs';

const SCHEMA = [
  { knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: {} } },
  { knowledgeType: 'fact', typeName: 'utterance', schema: { propertySchemas: {} } },
];

const OLD = {
  key: 'worked-at-acme', text: 'Ada worked at Acme as a platform engineer from March 2021.',
  speaker: 'Ada', statedOn: '2023-05-08', superseded: true, entities: ['ada'], sourceTurns: ['D1:1'],
};
const NEW = {
  key: 'works-at-beta', text: 'Ada left Acme and started at Beta in June 2023.',
  speaker: 'Ada', statedOn: '2023-06-14', entities: ['ada'], sourceTurns: ['D4:2'],
};

async function write({ claims, edges = [] }) {
  const ythril = recordingYthril();
  await writeSpace({
    extraction: {
      conversationId: 'conv-x',
      schema: SCHEMA,
      sessions: [{ date: '2023-05-08', text: 'Ada: hello' }],
      entities: [{ key: 'ada', type: 'person', name: 'Ada', description: 'An engineer.' }],
      chrono: [], edges, claims,
    },
    ythril, space: 'test-space', schemaEntries: SCHEMA,
  });
  return ythril.wrote;
}

describe('the mark reaches the record', () => {
  it('a retired claim is written with superseded as a top-level field', async () => {
    const { memories } = await write({ claims: [OLD, NEW] });
    const retired = memories.find(m => m.fact.includes('Acme as a platform engineer'));
    assert.equal(retired.superseded, true,
      'the mark must be a record field; as a property it is a second spelling of a real one');
    assert.equal(retired.properties?.superseded, undefined,
      '`properties.superseded` and `superseded` are different rows to every predicate — writing both, or '
      + 'the wrong one, is invisible until somebody filters and gets nothing');
  });

  it('the claim that replaced it carries nothing', async () => {
    const { memories } = await write({ claims: [OLD, NEW] });
    const current = memories.find(m => m.fact.includes('started at Beta'));
    assert.equal(current.superseded, undefined,
      'marking the new claim instead of the old one is the natural slip, and it inverts the answer');
  });

  it('and it does NOT suppress the vector', async () => {
    // The opposite of `attributed`, in the same writer. A suppressed record cannot be ranked even
    // deliberately, so this assertion IS the owner's "where did Ada work?" objection, in code.
    const { memories } = await write({ claims: [OLD, NEW] });
    for (const m of memories) {
      assert.equal(m.suppressEmbeddings, undefined,
        `a superseded claim must keep its vector — got ${JSON.stringify(m)}`);
    }
  });
});

describe('the edge reaches the instance as a claim-to-claim edge', () => {
  const EDGE = { label: 'supersedes', from: 'works-at-beta', to: 'worked-at-acme' };

  it('both ends resolve to the CLAIMS, and both declare their kind', async () => {
    const { memories, edges } = await write({ claims: [OLD, NEW], edges: [EDGE] });
    assert.equal(edges.length, 1, 'the edge must be written');
    const [e] = edges;
    assert.equal(e.fromKind, 'fact', 'an edge end that is a claim must say so, or the write is refused');
    assert.equal(e.toKind, 'fact');

    // Resolved to the right records, not merely to something. The recording client issues distinct ids
    // precisely so this can tell "wired correctly" from "wired to whatever was written first".
    const byText = t => memories.findIndex(m => m.fact.includes(t));
    assert.notEqual(byText('started at Beta'), byText('Acme as a platform engineer'));
    assert.notEqual(e.from, e.to, 'an edge from a claim to itself means the key map resolved both the same');
  });

  it('an ordinary entity edge still sends no kinds at all', async () => {
    // Omitting them means both ends are entities, which is what every other edge in the corpus means.
    // Sending `entity` explicitly would change nothing but the bytes — and a writer that started doing it
    // would be a diff nobody could read the intent of.
    const { edges } = await write({
      claims: [OLD, NEW],
      edges: [{ label: 'knows', from: 'ada', to: 'ada' }],
    });
    assert.equal(edges[0].fromKind, undefined);
    assert.equal(edges[0].toKind, undefined);
  });
});

describe('a claim nothing points at needs no key', () => {
  it('claims without keys are written exactly as before', async () => {
    const plain = { text: 'Ada likes pottery.', speaker: 'Ada', statedOn: '2023-05-08', entities: ['ada'], sourceTurns: ['D1:3'] };
    const { memories } = await write({ claims: [plain] });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].superseded, undefined);
    assert.equal(memories[0].key, undefined, 'the local key is the extraction file\'s, and reaches no record');
  });
});

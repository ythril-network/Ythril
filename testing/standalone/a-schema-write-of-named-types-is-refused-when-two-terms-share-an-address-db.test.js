/**
 * A schema write that names its types outright, `PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName` and
 * `PUT /api/spaces/:id/schema`, is refused `422 rdf_term_clash` when the type it writes would give two terms of an RDF space one address
 * (bundle-270, Q-754, own find of the design's alternative sketch).
 *
 * ## The defect it prevents
 *
 * Both routes write through `commitOwnMetaEdit`, which stores what it is given; the term-clash rule (Q-748 rule 5) was asked only by the
 * settings planner, so the same type PATCH and `schema_update` refuse was stored by these two, and the space then held two terms on one
 * address: the export names both by it and the import reads it back as one. Now both routes ask the planner's own check before they write,
 * and before a networked space's round is opened. No MCP door writes one type by name (`schema_update` goes through the planner).
 *
 * Run: node --test testing/standalone/a-schema-write-of-named-types-is-refused-when-two-terms-share-an-address-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-named-type-clash-');
const skip = await mongoSkipReason();
const rdfOf = (id) => {
  const base = `https://ythril.example.org/ld/${id}/`;
  return { enabled: true, base, vocab: `${base}vocab/`, baseEpoch: 0 };
};
const TAKEN = 'https://e.example/terms/Thing';
const metaOf = (id) => ({ rdf: rdfOf(id), typeSchemas: { entity: { Theirs: { iri: TAKEN } } } });
const CLASH = { typeSchemas: { entity: { Mine: { iri: TAKEN } } } };
const FREE = { typeSchemas: { entity: { Mine: { iri: 'https://e.example/terms/Other' } } } };

describe('a schema write of named types is refused when two terms would share an address', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('named_type_clash');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: 'solo', label: 'Solo', folders: [], meta: metaOf('solo') },
        { id: 'voted', label: 'Voted', folders: [], meta: metaOf('voted') },
      ],
      networks: [{
        id: NET_ID, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['voted'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const fresh = () => { inst.reset(); inst.loader.getConfig().networks[0].pendingRounds = []; };
  /** `PUT .../schema` replaces the whole map, so the stored type is sent beside the new one. */
  const whole = (meta) => ({ typeSchemas: { entity: { Theirs: { iri: TAKEN }, ...meta.typeSchemas.entity } } });

  for (const door of ['put-single-type', 'put-schema']) {
    it(`${door}: a type taking another term's address is 422 rdf_term_clash, and nothing is stored`, async () => {
      fresh();
      const answer = await inst.doors[door]('solo', door === 'put-schema' ? whole(CLASH) : CLASH);
      assert.equal(answer.status, 422, `a clash went unrefused: ${answer.text.slice(0, 300)}`);
      assert.equal(answer.body?.code, 'rdf_term_clash', answer.text.slice(0, 300));
      assert.match(answer.body?.error ?? '', /Mine/);
      assert.match(answer.body?.error ?? '', /Theirs/);
      assert.ok(!('Mine' in (inst.heldTypes('solo').entity ?? {})), 'the clashing type was stored');
    });

    it(`${door}: on a networked space the clash is refused before a round is opened`, async () => {
      fresh();
      const answer = await inst.doors[door]('voted', door === 'put-schema' ? whole(CLASH) : CLASH);
      assert.equal(answer.status, 422, answer.text.slice(0, 300));
      assert.equal(answer.body?.code, 'rdf_term_clash');
      assert.equal(inst.loader.getConfig().networks[0].pendingRounds.length, 0, 'a refused write opened a round');
    });

    it(`${door}: a type with its own address is written as before`, async () => {
      fresh();
      const answer = await inst.doors[door]('solo', door === 'put-schema' ? whole(FREE) : FREE);
      assert.equal(answer.status, 200, answer.text.slice(0, 300));
      assert.ok('Mine' in inst.heldTypes('solo').entity);
    });
  }
});

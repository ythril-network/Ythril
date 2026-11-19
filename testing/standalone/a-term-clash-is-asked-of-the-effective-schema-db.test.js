/**
 * The term-clash rule is asked of the schema the space RUNS: its own definitions laid under each network's layer (Q-748, slice A-fix, the
 * review's unproven suspicion "rule 5 runs on own definitions only", proven here).
 *
 * A PATCH merged its body over the space's own definitions and asked the clash rule of that alone, so an own type given the explicit `iri`
 * a network layer's type already has went through: the effective schema, which the export and the resolver name terms by, then held two
 * types with one address. Now the rule is asked of the effective schema after the edit, and such a write is 422 `rdf_term_clash` on both
 * doors.
 *
 * Run: node --test testing/standalone/a-term-clash-is-asked-of-the-effective-schema-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-effective-clash-');
const skip = await mongoSkipReason();
const BASE = 'https://ythril.example.org/ld/layered/';
const RDF = { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 };
const TAKEN = 'https://e.example/terms/Thing';
const OWN = { rdf: RDF, typeSchemas: { entity: { Mine: {} } } };
const LAYER = { typeSchemas: { entity: { Theirs: { iri: TAKEN } } } };

describe('the term-clash rule reads the effective schema', { skip }, () => {
  let inst;
  before(async () => {
    await openTestMongo('rdf_effective_clash');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: 'layered', label: 'Layered', folders: [], meta: { rdf: RDF, typeSchemas: { entity: { Mine: {}, Theirs: { iri: TAKEN } } } } }],
      networks: [{
        id: NET_ID, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['layered'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [], schemaLayers: { layered: LAYER },
        members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  for (const door of ['space-patch', 'mcp-schema-update']) {
    it(`${door}: an own type taking the address a layer's type has is 422 rdf_term_clash`, async () => {
      inst.reset();
      inst.loader.getConfig().spaces[0].ownMeta = structuredClone(OWN);
      const answer = await inst.doors[door]('layered', { typeSchemas: { entity: { Mine: { iri: TAKEN } } } });
      assert.equal(answer.status, 422, `a clash with a layer's type went unrefused: ${answer.text.slice(0, 300)}`);
      assert.match(`${answer.text} ${JSON.stringify(answer.body ?? null)}`, /rdf_term_clash/);
      assert.equal(inst.loader.getConfig().networks[0].pendingRounds.length, 0, 'a refused write opened a round');
    });
  }
});

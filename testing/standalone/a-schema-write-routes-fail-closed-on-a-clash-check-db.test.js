/**
 * The routes that write named types do not let the clash check through what it could not judge (bundle-270, Q-754, fix round R5 and R6;
 * the type cap they also held is gone, Q-981).
 *
 * ## What it holds
 *
 * - A group apply asks the term-clash rule of the schema the space runs, its own definitions under each network's layer (R5): an entry whose
 *   address a layer's type already has is refused `rdf_term_clash` before a round is opened.
 * - The per-type routes do not skip the clash check when the merged meta does not parse (R6): a type that gives a record more rules than may
 *   apply to it is refused as PATCH refuses it, so the clash question is never skipped by a parse that fails.
 *
 * Run: node --test testing/standalone/a-schema-write-routes-fail-closed-on-a-clash-check-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const dir = tempInstanceDir('ythril-write-routes-cap-');
const skip = await mongoSkipReason();
const NS = 'https://acme.example/ns/';
const TAKEN = 'https://e.example/terms/Thing';
const rdfOf = (id) => {
  const base = `https://ythril.example.org/ld/${id}/`;
  return { enabled: true, base, vocab: `${base}vocab/`, baseEpoch: 0 };
};
const RULE = { rule: 'size(self.description) > 0', message: 'a description is needed' };
/** As many space rules naming `entity` as one record may have apply to it from the space: a type's own rule is then one too many. */
const SPACE_RULES = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`space${i}`, { ...RULE, kinds: ['entity'] }]));

describe('the schema write routes do not skip the clash check', { skip, timeout: 300_000 }, () => {
  let inst, schemaLibraryRouter;
  before(async () => {
    await openTestMongo('write_routes_cap');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: 'layered', label: 'Layered', folders: [], meta: { rdf: rdfOf('layered'), typeSchemas: { entity: { Theirs: { iri: `${NS}person` } } } } },
        { id: 'failopen', label: 'Fail open', folders: [], meta: { rdf: rdfOf('failopen'), rules: SPACE_RULES, typeSchemas: { entity: { Theirs: { iri: TAKEN } } } } },
      ],
      library: [
        { name: 'acme-entity-person', knowledgeType: 'entity', typeName: 'person', schemaGroup: 'acme', schema: { propertySchemas: { email: { type: 'string' } } } },
      ],
      networks: [{
        id: NET_ID, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['layered'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        schemaLayers: { layered: { typeSchemas: { entity: { Theirs: { iri: `${NS}person` } } } } },
        members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
    inst.loader.getConfig().schemaLibraryNamespaces = { acme: { prefix: 'acme', iri: NS } };
    ({ schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const fresh = () => { inst.reset(); inst.loader.getConfig().networks[0].pendingRounds = []; inst.loader.getConfig().schemaLibraryNamespaces = { acme: { prefix: 'acme', iri: NS } }; };
  const apply = (group, spaceId) => callRoute(schemaLibraryRouter, 'post', '/groups/:group/apply', { params: { group }, body: { spaceId }, authToken: AUTH });

  it('a group apply whose entry takes the address a network layer\'s type has is refused rdf_term_clash, and opens no round', async () => {
    fresh();
    inst.loader.getConfig().spaces.find(s => s.id === 'layered').ownMeta = { rdf: rdfOf('layered'), typeSchemas: {} };
    const answer = await apply('acme', 'layered');
    assert.ok(answer.code === 409 || answer.code === 422, `a group apply stored a clash with a layer: ${answer.code} ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body?.code, 'rdf_term_clash', JSON.stringify(answer.body));
    assert.equal(inst.loader.getConfig().networks[0].pendingRounds.length, 0, 'a refused apply opened a round');
  });

  const CLASH_AND_TOO_MANY_RULES = { entity: { Mine: { iri: TAKEN, rules: { own: RULE } } } };
  const whole = { entity: { Theirs: { iri: TAKEN }, ...CLASH_AND_TOO_MANY_RULES.entity } };

  it('premise: PATCH refuses a type that gives a record more rules than may apply to it', async () => {
    fresh();
    const answer = await inst.doors['space-patch']('failopen', { typeSchemas: CLASH_AND_TOO_MANY_RULES });
    assert.equal(answer.status, 400, `the planner's parse did not refuse the type: ${answer.text.slice(0, 300)}`);
    assert.match(answer.text, /rules apply/);
  });

  for (const door of ['put-single-type', 'put-schema']) {
    it(`${door}: a type that takes another term's address and also fails the merged meta's parse is refused, not stored`, async () => {
      fresh();
      const answer = await inst.doors[door]('failopen', { typeSchemas: door === 'put-schema' ? whole : CLASH_AND_TOO_MANY_RULES });
      assert.ok(answer.status >= 400, `the type went through unjudged: ${answer.status} ${answer.text.slice(0, 300)}`);
      assert.ok(!('Mine' in (inst.heldTypes('failopen').entity ?? {})), 'the refused type was stored');
    });
  }
});

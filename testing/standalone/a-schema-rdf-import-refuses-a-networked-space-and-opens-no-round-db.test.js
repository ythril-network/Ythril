/**
 * The schema-from-RDF door refuses a space in a network and opens no vote round (bundle-270, Q-754, design revision 2 steps 9 and 10, the
 * challenge's F1 and F6), on both doors: `POST /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A build into a networked space answers 409 `schema_rdf_networked`, carrying the dry-run answer (`proposed`) and naming the doors that do
 *   open a round (`PATCH /api/spaces/:id`, `schema_update`); no round opens and nothing is stored.
 * - A space joined to a network between the upload and the write is refused the same way, with no round: the settings write is asked with
 *   `refuseIfNetworked`.
 * - A dry run on a networked space is answered: it writes nothing and opens nothing.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-refuses-a-networked-space-and-opens-no-round-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, knobs, actModule } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdfnetsrc';
const NETTED = { rest: 'srdfnetr', mcp: 'srdfnetm' };
const LATE = { rest: 'srdflater', mcp: 'srdflatem' };
const SOURCE_TYPES = { entity: { person: { propertySchemas: { age: { type: 'number' } } } } };
const STORED = { entity: { tool: {} } };

describe('the schema-from-RDF door refuses a networked space and opens no round (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, file;
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_networked',
      spaces: [spaceWith(SRC, SOURCE_TYPES), ...[...Object.values(NETTED), ...Object.values(LATE)].map(id => spaceWith(id, STORED))],
    });
    admin = await d.mint('schema-rdf-networked-admin', {}, { admin: true });
    file = await d.exportTurtle(admin.key, SRC);
    for (const id of Object.values(NETTED)) d.joinNetwork(`net-${id}`, id);
  });
  after(async () => { actModule.setSchemaRdfImportKnobsForTest?.(null); await d?.close(); });

  const params = (over = {}) => ({ mode: 'expand', sourceBase: baseOf(SRC), ...over });

  it('a build into a networked space is 409 schema_rdf_networked with the dry-run answer, and no round opens', async () => {
    const { rest, mcp } = await d.both(admin.key, [NETTED.rest, NETTED.mcp], file, params());
    assert.equal(rest.status, 409, rest.text.slice(0, 300));
    assert.equal(rest.code, 'schema_rdf_networked', rest.text.slice(0, 300));
    assert.match(rest.body.error, /PATCH \/api\/spaces\/:id/);
    assert.match(rest.body.error, /schema_update/);
    assert.deepEqual(rest.body.proposed?.typeSchemas?.entity?.person, SOURCE_TYPES.entity.person, 'the refusal carries what the file would build');
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.equal(mcp.code, 'schema_rdf_networked', mcp.text.slice(0, 300));
    assert.deepEqual(mcp.body?.proposed?.typeSchemas?.entity?.person, SOURCE_TYPES.entity.person, 'MCP: the refusal carries what the file would build');
    for (const id of Object.values(NETTED)) {
      assert.equal(d.roundsOf(`net-${id}`), 0, `${id}: a round was opened`);
      assert.deepEqual(d.heldTypes(id), STORED, `${id}: something was stored`);
    }
  });

  it('a space joined to a network between the upload and the write is refused, and no round opens', async () => {
    for (const [door, id] of Object.entries(LATE)) {
      knobs({ hooks: { beforeWrite: () => d.joinNetwork(`net-${id}`, id) } });
      const answer = door === 'rest'
        ? await d.buildRest(admin.key, id, file, { params: params() })
        : await d.buildMcp(admin.key, { space: id, document: file, format: 'turtle', ...params() });
      knobs(null);
      if (door === 'rest') assert.equal(answer.status, 409, answer.text.slice(0, 300));
      else assert.equal(answer.isError, true, answer.text.slice(0, 300));
      assert.equal(answer.code, 'schema_rdf_networked', `${door}: ${answer.text.slice(0, 300)}`);
      assert.equal(d.roundsOf(`net-${id}`), 0, `${door}: a round was opened`);
      assert.deepEqual(d.heldTypes(id), STORED, `${door}: something was stored`);
    }
  });

  it('a dry run on a networked space is answered, writes nothing and opens nothing', async () => {
    const { rest, mcp } = await d.both(admin.key, [NETTED.rest, NETTED.mcp], file, params({ dryRun: true }));
    assert.equal(rest.status, 200, rest.text.slice(0, 300));
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.deepEqual(rest.body.typeSchemas?.entity?.person, SOURCE_TYPES.entity.person);
    for (const id of Object.values(NETTED)) {
      assert.equal(d.roundsOf(`net-${id}`), 0);
      assert.deepEqual(d.heldTypes(id), STORED);
    }
  });
});

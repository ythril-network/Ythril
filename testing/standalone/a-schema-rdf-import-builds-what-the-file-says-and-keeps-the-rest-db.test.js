/**
 * The schema-from-RDF door builds what the file says and keeps the rest (bundle-270, Q-754, design revisions 2 and 3), on both doors:
 * `POST /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - An `expand` writes the types and properties the file adds, and leaves every space-level field (`purpose`, `validationMode`) and every stored
 *   type the file does not name exactly as it was (only the changed types are sent, in merge mode: amendment A7 and the challenge's F3).
 * - `generate` into a space that has types is refused 409 `schema_rdf_not_empty`, and nothing is stored.
 * - A schema exported by `GET /api/spaces/:id/schema-rdf`, imported by the door into an empty space with the exporter's base as `sourceBase`,
 *   is stored as an equal schema.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-builds-what-the-file-says-and-keeps-the-rest-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf } from './_schema-rdf-import-doors.mjs';
import { META as FIXTURE } from './_schema-export-fixture.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdfkeepsrc';
const FIX = 'srdfkeepfix';
const EXPAND = { rest: 'srdfkeepexpr', mcp: 'srdfkeepexpm' };
const GEN = { rest: 'srdfkeepgenr', mcp: 'srdfkeepgenm' };
const TRIP = { rest: 'srdfkeeptripr', mcp: 'srdfkeeptripm' };

const SOURCE_TYPES = {
  entity: {
    person: { propertySchemas: { age: { type: 'number' } } },
    place: { propertySchemas: { city: { type: 'string' } } },
  },
};
const STORED_TYPES = {
  entity: {
    person: { propertySchemas: { name: { type: 'string' } } },
    tool: { description: 'Not in the file', propertySchemas: { brand: { type: 'string' } } },
  },
};
const KEPT = { purpose: 'A purpose the file does not state', validationMode: 'strict' };

describe('the schema-from-RDF door builds what the file says and keeps the rest (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin;
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_keeps',
      spaces: [
        spaceWith(SRC, SOURCE_TYPES, { purpose: 'The source ontology', validationMode: 'warn' }),
        spaceWith(FIX, FIXTURE.typeSchemas),
        ...Object.values(EXPAND).map(id => spaceWith(id, STORED_TYPES, KEPT)),
        ...Object.values(GEN).map(id => spaceWith(id, STORED_TYPES)),
        ...Object.values(TRIP).map(id => spaceWith(id, undefined)),
      ],
    });
    admin = await d.mint('schema-rdf-keeps-admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  it('an expand writes what the file adds and leaves every other field and every type it does not name as it was', async () => {
    const file = await d.exportTurtle(admin.key, SRC);
    const before = Object.fromEntries(Object.values(EXPAND).map(id => [id, structuredClone(d.heldMeta(id))]));
    const { rest, mcp } = await d.both(admin.key, [EXPAND.rest, EXPAND.mcp], file, { mode: 'expand', sourceBase: baseOf(SRC) });
    assert.equal(rest.status, 200, `REST: ${rest.text.slice(0, 400)}`);
    assert.equal(mcp.isError, false, `MCP: ${mcp.text.slice(0, 400)}`);
    for (const [door, id] of Object.entries(EXPAND)) {
      const held = d.heldMeta(id);
      const was = before[id];
      assert.deepEqual(held.typeSchemas.entity.place, SOURCE_TYPES.entity.place, `${door}: the type the file adds is written`);
      assert.deepEqual(held.typeSchemas.entity.person.propertySchemas, { name: { type: 'string' }, age: { type: 'number' } }, `${door}: the property the file adds joins the stored ones`);
      assert.deepEqual(held.typeSchemas.entity.tool, was.typeSchemas.entity.tool, `${door}: a stored type the file does not name is as it was`);
      assert.equal(held.purpose, KEPT.purpose, `${door}: the purpose is the space's, not the file's`);
      assert.equal(held.validationMode, KEPT.validationMode, `${door}: the validation mode is the space's, not the file's`);
      assert.deepEqual(held.rdf, was.rdf, `${door}: the RDF setting is as it was`);
    }
    assert.equal(rest.body.written, true);
    assert.equal(mcp.body.written, true);
    assert.equal(rest.body.mode, 'expand');
  });

  it('generate into a space with types is refused 409 schema_rdf_not_empty, and nothing is stored', async () => {
    const file = await d.exportTurtle(admin.key, SRC);
    const before = Object.fromEntries(Object.values(GEN).map(id => [id, structuredClone(d.heldMeta(id))]));
    const { rest, mcp } = await d.both(admin.key, [GEN.rest, GEN.mcp], file, { mode: 'generate', sourceBase: baseOf(SRC) });
    assert.equal(rest.status, 409, rest.text.slice(0, 300));
    assert.equal(rest.code, 'schema_rdf_not_empty', rest.text.slice(0, 300));
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.equal(mcp.code, 'schema_rdf_not_empty', mcp.text.slice(0, 300));
    for (const id of Object.values(GEN)) assert.deepEqual(d.heldMeta(id), before[id], `${id}: a refused generate stored something`);
  });

  it('a schema the export wrote, imported into an empty space, is stored as an equal schema', async () => {
    const file = await d.exportTurtle(admin.key, FIX);
    const { rest, mcp } = await d.both(admin.key, [TRIP.rest, TRIP.mcp], file, { mode: 'generate', sourceBase: baseOf(FIX) });
    assert.equal(rest.status, 200, `REST: ${rest.text.slice(0, 400)}`);
    assert.equal(mcp.isError, false, `MCP: ${mcp.text.slice(0, 400)}`);
    for (const id of Object.values(TRIP)) assert.deepEqual(d.heldTypes(id), d.heldTypes(FIX), `${id}: the imported schema differs from the exported one`);
  });
});

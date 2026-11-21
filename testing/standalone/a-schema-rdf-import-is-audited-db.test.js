/**
 * The schema-from-RDF door is audited as `schema.rdf.import` (bundle-270, Q-754, design revision 3 "Audit"), on both doors: `POST
 * /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A build leaves one row of the operation whose changes name the types it added (names only, as every schema write records them).
 * - A refused build leaves a row with no changes: a refusal changed nothing, and its row must not claim an edit.
 * - A dry run's row records counts and flags only: no type name and no text of the file.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-is-audited-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const OP = 'schema.rdf.import';
const SRC = 'srdfauditsrc';
const BUILD = { rest: 'srdfauditbr', mcp: 'srdfauditbm' };
const FULL = 'srdfauditfull';
const SOURCE_TYPES = { entity: { auditedPerson: { description: 'A distinctive description', propertySchemas: { age: { type: 'number' } } } } };

describe('the schema-from-RDF door is audited (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin;
  const tokens = {};
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_audited',
      spaces: [spaceWith(SRC, SOURCE_TYPES), ...Object.values(BUILD).map(id => spaceWith(id, undefined)), spaceWith(FULL, { entity: { held: {} } })],
    });
    admin = await d.mint('schema-rdf-audit-admin', {}, { admin: true });
    for (const door of ['rest', 'mcp']) tokens[door] = await d.mint(`schema-rdf-audit-${door}`, {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  const rowsOf = async (token) => {
    await untilAuditWritesLanded();
    return d.col('audit_log').find({ tokenId: token.id, operation: OP }).sort({ timestamp: 1 }).toArray();
  };
  const run = (door, space, text, params) => (door === 'rest'
    ? d.buildRest(tokens[door].key, space, text, { params })
    : d.buildMcp(tokens[door].key, { space, document: text, format: 'turtle', ...params }));

  it('a build, a refusal and a dry run each leave the row their outcome allows, on both doors', async () => {
    const file = await d.exportTurtle(admin.key, SRC);
    for (const door of ['rest', 'mcp']) {
      const built = await run(door, BUILD[door], file, { mode: 'generate', sourceBase: baseOf(SRC) });
      assert.ok(door === 'rest' ? built.status === 200 : built.isError === false, `${door} build: ${built.text.slice(0, 300)}`);
      const refused = await run(door, FULL, file, { mode: 'generate', sourceBase: baseOf(SRC) });
      assert.equal(refused.code, 'schema_rdf_not_empty', `${door} refusal: ${refused.text.slice(0, 300)}`);
      const dry = await run(door, FULL, file, { mode: 'expand', sourceBase: baseOf(SRC), dryRun: true });
      assert.ok(door === 'rest' ? dry.status === 200 : dry.isError === false, `${door} dry run: ${dry.text.slice(0, 300)}`);

      const rows = await rowsOf(tokens[door]);
      assert.equal(rows.length, 3, `${door}: ${rows.length} ${OP} rows: ${JSON.stringify(rows.map(r => [r.status, r.spaceId]))}`);
      const [buildRow, refusedRow, dryRow] = rows;
      assert.equal(buildRow.spaceId, BUILD[door]);
      const added = (buildRow.changes ?? []).find(c => c.field === 'typeSchemas.entity');
      assert.deepEqual(added?.added, ['auditedPerson'], `${door}: the build's row names the added type: ${JSON.stringify(buildRow.changes)}`);
      assert.deepEqual(refusedRow.changes ?? [], [], `${door}: a refused build's row claims a change: ${JSON.stringify(refusedRow.changes)}`);
      const dryChanges = dryRow.changes ?? [];
      assert.ok(dryChanges.some(c => c.field === 'dryRun' && c.to === true), `${door}: the dry run's row says it was one: ${JSON.stringify(dryChanges)}`);
      assert.ok(dryChanges.some(c => typeof c.to === 'number'), `${door}: the dry run's row counts: ${JSON.stringify(dryChanges)}`);
      const text = JSON.stringify(dryChanges);
      assert.ok(!/typeSchemas|auditedPerson|distinctive/.test(text), `${door}: the dry run's row names a type or repeats the file: ${text}`);
    }
  });
});

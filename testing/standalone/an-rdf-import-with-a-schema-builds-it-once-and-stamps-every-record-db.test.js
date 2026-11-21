/**
 * An RDF data import that asks for a schema builds it from the file's classes and shapes, judges the data by it, writes it once and stamps every
 * record with its fingerprint (bundle-270, Q-955, tests 1, 2, 9, 10, 12, 13, 14, 16, 17, 22, 24 and 25 of its plan): `POST
 * /api/brain/spaces/:spaceId/import/rdf?schema=` and MCP `import_rdf { schema }`.
 *
 * ## What it holds
 *
 * - An expand import writes the built types once (version + 1) and every imported record carries the fingerprint of the schema stored after it
 *   (1, on both doors: 17).
 * - A file whose data fails the built schema is refused 409 and leaves the version and the types unchanged (2, on both doors: 17).
 * - With `schema` set, the class, shape and ontology subjects are not imported as records, and are counted as not taken (9); without it they
 *   are imported exactly as today (22, pinning).
 * - A dry run accepts a value valid only under the proposed type and writes no schema (10).
 * - The audit row names the caller and the schema's fingerprint before and after (12).
 * - One SHACL file with a blank-node property shape builds the same schema through `import_rdf` and `import_schema_rdf` (13).
 * - A file of one named graph and no `sourceBase` builds its types by the graph's base, the names the data's records carry (14).
 * - A second import of the same file changes nothing and leaves the version unmoved (16).
 * - A library `$ref` type is kept, and the records' fingerprint is the stored schema's (24).
 * - The import's schema change says what a PATCH of the same change says (its notice, 25).
 *
 * Run: node --test testing/standalone/an-rdf-import-with-a-schema-builds-it-once-and-stamps-every-record-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openRdfImportSchemaDoors, spaceWith, baseOf, fileOf, schemaFile, BUILT_PERSON, SECRET } from './_rdf-import-schema-doors.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const BUILT = { rest: 'rdfisbuiltr', mcp: 'rdfisbuiltm' };
const BAD = { rest: 'rdfisbadr', mcp: 'rdfisbadm' };
const DRY = 'rdfisdry';
const NINE = 'rdfisnine';
const PARITY = { imp: 'rdfisparimp', door: 'rdfispardoor' };
const GRAPH = 'rdfisgraph';
const TWICE = 'rdfistwice';
const TODAY = 'rdfistoday';
const SRC = 'rdfislibsrc';
const LINKED = 'rdfislinked';
const NOTICE = { imp: 'rdfisnotimp', patch: 'rdfisnotpatch' };
const ENTRY = 'rdfislibperson';
const GRAPH_BASE = 'https://src.example/ld/g/';

describe('an RDF import with a schema builds it once and stamps every record (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, stamp;
  const strictIds = [...Object.values(BUILT), ...Object.values(BAD), DRY, NINE, ...Object.values(PARITY), GRAPH, TWICE, ...Object.values(NOTICE)];
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_schema_builds',
      spaces: [
        ...strictIds.map(id => spaceWith(id, undefined, STRICT)),
        spaceWith(TODAY, undefined, { validationMode: 'off' }),
        spaceWith(SRC, { entity: { person: { propertySchemas: { name: { type: 'string' } } }, place: { propertySchemas: { city: { type: 'string' } } } } }),
        spaceWith(LINKED, { entity: { person: { $ref: `library:${ENTRY}` } } }, STRICT),
      ],
    });
    d.loader.saveSchemaLibrary([{ name: ENTRY, knowledgeType: 'entity', typeName: 'person', schema: { propertySchemas: { name: { type: 'string' } } } }]);
    const all = [...strictIds, TODAY, SRC, LINKED];
    writer = await d.mint('rdf-import-schema-writer', Object.fromEntries(all.map(id => [id, d.row({ knowledge: 'write', schema: 'write' })])));
    stamp = await import('../../server/dist/spaces/schema-stamp.js');
  });
  after(async () => { await d?.close(); });

  const spaceOf = (id) => d.loader.getConfig().spaces.find(s => s.id === id);
  const names = async (id) => (await d.records(id, 'entities')).map(r => r.name).sort();

  it('1, 17: an expand import writes the built types once and every record carries the new fingerprint, on both doors', async () => {
    const before_ = Object.fromEntries(Object.values(BUILT).map(id => [id, d.versionOf(id)]));
    const { rest, mcp } = await d.importBoth(writer.key, [BUILT.rest, BUILT.mcp], fileOf(), { schema: 'expand' });
    assert.equal(rest.status, 200, `REST: ${rest.text.slice(0, 400)}`);
    assert.equal(mcp.isError, false, `MCP: ${mcp.text.slice(0, 400)}`);
    for (const id of Object.values(BUILT)) {
      assert.equal(d.versionOf(id), before_[id] + 1, `${id}: the schema is written once`);
      assert.deepEqual(d.heldTypes(id).entity?.Person, BUILT_PERSON, `${id}: the built type is stored`);
      const fp = stamp.schemaFingerprintOf(spaceOf(id));
      const people = await d.records(id, 'entities');
      assert.deepEqual(people.map(p => p.name).sort(), ['Alice', 'Bob'], id);
      for (const p of people) assert.equal(p[stamp.SCHEMA_FINGERPRINT_FIELD], fp, `${id}: ${p.name} carries the stored schema's fingerprint`);
    }
  });

  it('2, 17: a file whose data fails the built schema is refused 409 and leaves the version and the types as they were, on both doors', async () => {
    const before_ = Object.fromEntries(Object.values(BAD).map(id => [id, d.versionOf(id)]));
    const { rest, mcp } = await d.importBoth(writer.key, [BAD.rest, BAD.mcp], fileOf({ bad: true }), { schema: 'expand' });
    assert.equal(rest.status, 409, `REST: ${rest.text.slice(0, 400)}`);
    assert.equal(rest.code, 'rdf_import_refused');
    assert.equal(mcp.code, 'rdf_import_refused', `MCP: ${mcp.text.slice(0, 400)}`);
    for (const id of Object.values(BAD)) {
      assert.equal(d.versionOf(id), before_[id], `${id}: no schema was written`);
      assert.deepEqual(d.heldTypes(id), {}, `${id}: no type was stored`);
      assert.deepEqual(await d.records(id, 'entities'), [], `${id}: no record was written`);
    }
    assert.ok(!rest.text.includes(SECRET) && !mcp.text.includes(SECRET), 'a value of the file is repeated');
  });

  it('9: with schema set, the class, shape and ontology subjects are not imported as records and are counted as not taken', async () => {
    const r = await d.importRestOne(writer.key, NINE, fileOf(), { schema: 'expand' });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.deepEqual(await names(NINE), ['Alice', 'Bob'], 'only the data subjects are records');
    assert.ok((r.body?.notTaken?.schema ?? 0) > 0, `the schema statements are counted as not taken: ${JSON.stringify(r.body?.notTaken)}`);
  });

  it('22: without schema, the class and shape subjects are translated as records, exactly as today (pinning)', async () => {
    // Today the class, the shape, the ontology header and the blank property shape are subjects the translation takes as records: in an off
    // space the blank subject (refused by default) refuses the whole file, and nothing is skipped as a schema statement.
    const r = await d.importRestOne(writer.key, TODAY, fileOf());
    assert.equal(r.status, 409, r.text.slice(0, 400));
    assert.equal(r.code, 'rdf_import_refused');
    const report = r.body.report;
    assert.equal(report.subjects, 6, `every subject of the file is one the translation reads: ${JSON.stringify(report.reasonsByCode)}`);
    assert.equal(report.schema, undefined, 'an import without schema reports no schema step');
    assert.ok(!('schema' in (report.notTaken ?? {})), `nothing is skipped as a schema statement: ${JSON.stringify(report.notTaken)}`);
    assert.ok(report.reasonCount > 0, JSON.stringify(report.reasonsByCode));
    assert.deepEqual(await d.records(TODAY, 'entities'), []);
    assert.deepEqual(d.heldTypes(TODAY), {}, 'no schema is built');
  });

  it('10: a dry run accepts a value valid only under the proposed type and writes no schema', async () => {
    const without = await d.importRestOne(writer.key, DRY, fileOf(), { dryRun: true });
    assert.equal(without.status, 409, `the premise: the strict space without the type refuses the data: ${without.text.slice(0, 300)}`);
    const v = d.versionOf(DRY);
    const dry = await d.importRestOne(writer.key, DRY, fileOf(), { schema: 'generate', dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 400));
    assert.equal(dry.body.kinds.entity.inserted, 2, JSON.stringify(dry.body.kinds));
    assert.equal(d.versionOf(DRY), v, 'a dry run writes no schema');
    assert.deepEqual(d.heldTypes(DRY), {});
    assert.deepEqual(await d.records(DRY, 'entities'), []);
  });

  it('12: the audit row of an import with schema names the caller and the schema\'s fingerprint before and after', async () => {
    await untilAuditWritesLanded();
    const rows = await d.col('audit_log').find({ operation: 'rdf.import', spaceId: BUILT.rest }).toArray();
    const row = rows.find(x => (x.changes ?? []).some(c => c.field === 'schemaFingerprintAfter'));
    assert.ok(row, `a row carries the schema's fingerprints: ${JSON.stringify(rows.map(x => x.changes?.map(c => c.field)))}`);
    assert.equal(row.tokenId, writer.id, 'the row names the caller');
    const field = (f) => row.changes.find(c => c.field === f)?.to;
    assert.match(String(field('schemaFingerprintBefore')), /^[0-9a-f]{64}$/);
    assert.match(String(field('schemaFingerprintAfter')), /^[0-9a-f]{64}$/);
    assert.notEqual(field('schemaFingerprintBefore'), field('schemaFingerprintAfter'));
    assert.ok(!JSON.stringify(rows).includes(SECRET));
  });

  it('13: one SHACL file with a blank-node property shape builds the same schema through import_rdf and import_schema_rdf', async () => {
    const imp = await d.importMcpOne(writer.key, PARITY.imp, schemaFile(), { schema: 'generate' });
    assert.equal(imp.isError, false, `import_rdf: ${imp.text.slice(0, 400)}`);
    const door = await d.buildMcp(writer.key, { space: PARITY.door, document: schemaFile(), format: 'turtle', mode: 'generate' });
    assert.equal(door.isError, false, `import_schema_rdf: ${door.text.slice(0, 400)}`);
    assert.deepEqual(d.heldTypes(PARITY.imp), d.heldTypes(PARITY.door), 'the two doors built different schemas');
    assert.deepEqual(d.heldTypes(PARITY.imp).entity?.Person?.propertySchemas?.age, BUILT_PERSON.propertySchemas.age, 'the blank-node property shape was followed');
  });

  it('14: a file of one named graph and no sourceBase builds its types by the graph\'s base, the names its records carry', async () => {
    const v = `${GRAPH_BASE}vocab/`;
    const file = [
      `<${GRAPH_BASE}> {`,
      `  <${v}entity/member> a <http://www.w3.org/2002/07/owl#Class> .`,
      `  <http://people.example/dora> a <${v}entity/member> ; <http://www.w3.org/2000/01/rdf-schema#label> "Dora" .`,
      '}',
      '',
    ].join('\n');
    const r = await d.importRestOne(writer.key, GRAPH, file, { schema: 'generate' }, { format: 'trig' });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.deepEqual(d.heldTypes(GRAPH).entity?.member, {}, `the type is named by the graph's base and carries no address: ${JSON.stringify(d.heldTypes(GRAPH))}`);
    const [dora] = await d.records(GRAPH, 'entities');
    assert.equal(dora?.type, 'member', 'the record carries the built type');
  });

  it('16: a second import of the same file with schema changes nothing and leaves the version unmoved', async () => {
    const first = await d.importRestOne(writer.key, TWICE, schemaFile(), { schema: 'expand' });
    assert.equal(first.status, 200, first.text.slice(0, 400));
    const v = d.versionOf(TWICE);
    assert.ok(v > 0, 'the first import wrote the schema');
    const second = await d.importRestOne(writer.key, TWICE, schemaFile(), { schema: 'expand' });
    assert.equal(second.status, 200, second.text.slice(0, 400));
    assert.equal(d.versionOf(TWICE), v, 'a no-change import wrote the schema again');
    assert.equal(second.body?.schema?.written, false);
  });

  it('24: a library $ref type is kept through import_rdf, and the records\' fingerprint is the stored schema\'s', async () => {
    const admin = await d.mint('rdf-import-schema-admin', {}, { admin: true });
    const schema = await d.exportTurtle(admin.key, SRC);
    const data = `<http://people.example/eve> a <${baseOf(SRC)}vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Eve" .\n`;
    const r = await d.importRestOne(writer.key, LINKED, `${schema}\n${data}`, { schema: 'expand', sourceBase: baseOf(SRC) });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    assert.deepEqual(d.heldTypes(LINKED).entity.person, { $ref: `library:${ENTRY}` }, 'the linked type was rewritten');
    assert.ok(d.heldTypes(LINKED).entity.place, 'the type the file adds is written');
    const fp = stamp.schemaFingerprintOf(spaceOf(LINKED));
    const [eve] = await d.records(LINKED, 'entities');
    assert.equal(eve?.[stamp.SCHEMA_FINGERPRINT_FIELD], fp);
  });

  it('25: the import\'s schema change says what a PATCH of the same change says', async () => {
    const r = await d.importRestOne(writer.key, NOTICE.imp, schemaFile(), { schema: 'generate' });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    const patch = await d.rest(writer.key, 'PATCH', `/api/spaces/${NOTICE.patch}`, { meta: { typeSchemas: d.heldTypes(NOTICE.imp) }, typeSchemasMode: 'merge' });
    assert.equal(patch.status, 200, patch.text.slice(0, 300));
    const noticeKeys = ['layers', 'warnings', 'convert', 'merge', 'networkMerge'];
    const patchNotice = Object.fromEntries(Object.entries(patch.body).filter(([k]) => noticeKeys.includes(k)));
    assert.ok(r.body?.schema, `the report carries its schema step: ${r.text.slice(0, 300)}`);
    assert.deepEqual(r.body.schema.notice, patchNotice);
    assert.deepEqual(d.heldTypes(NOTICE.imp), d.heldTypes(NOTICE.patch));
  });
});

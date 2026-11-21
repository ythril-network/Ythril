/**
 * The schema-from-RDF door writes only what the file changes (bundle-270, Q-754, fix round R2 and R3), on both doors: `POST
 * /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A stored type that is a reference to a library entry stays a reference when a build touches the space (R2): the mapping was handed the
 *   entry's resolved copy, so an expand that named the type wrote a concrete copy over the `$ref`, and later library updates no longer reached
 *   the space. The type is kept whole and the answer says why the file's fields were not taken.
 * - A build that changes nothing writes nothing (R3): the same file twice, a body of white space, an empty body (REST) and a file of only
 *   statements the mapping does not take answer `written: false`, move no version, push no history snapshot, and their audit row claims no
 *   change of the schema.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-writes-only-what-it-changes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const OP = 'schema.rdf.import';
const SRC = 'srdfwrsrc';
const LINKED = { rest: 'srdfwrlinkr', mcp: 'srdfwrlinkm' };
const TWICE = { rest: 'srdfwrtwicer', mcp: 'srdfwrtwicem' };
const BLANK = { rest: 'srdfwrblankr', mcp: 'srdfwrblankm' };
const NOT_TAKEN = { rest: 'srdfwrnotr', mcp: 'srdfwrnotm' };
const ENTRY = 'srdfwrlibperson';
const SOURCE_TYPES = {
  entity: {
    person: { propertySchemas: { age: { type: 'number' } } },
    place: { propertySchemas: { city: { type: 'string' } } },
  },
};
const ENTRY_SCHEMA = { propertySchemas: { name: { type: 'string' } } };
/** A statement no schema construct is: the mapping takes nothing of it. */
const NOT_A_SCHEMA = '<urn:srdfwr:a> <urn:srdfwr:b> <urn:srdfwr:c> .\n';

describe('the schema-from-RDF door writes only what the file changes (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin;
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'schema_rdf_writes_only_changes',
      spaces: [
        spaceWith(SRC, SOURCE_TYPES),
        ...Object.values(LINKED).map(id => spaceWith(id, { entity: { person: { $ref: `library:${ENTRY}` } } })),
        ...[...Object.values(TWICE), ...Object.values(BLANK), ...Object.values(NOT_TAKEN)].map(id => spaceWith(id, undefined)),
      ],
    });
    d.loader.saveSchemaLibrary([{ name: ENTRY, knowledgeType: 'entity', typeName: 'person', schema: structuredClone(ENTRY_SCHEMA) }]);
    admin = await d.mint('schema-rdf-writes-admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  const versionOf = (id) => d.heldMeta(id).version ?? 0;
  const snapshotsOf = (id) => (d.heldMeta(id).previousVersions ?? []).length;

  it('an expand that names a library-linked type keeps its $ref, and the other types it adds are written', async () => {
    const file = await d.exportTurtle(admin.key, SRC);
    const { rest, mcp } = await d.both(admin.key, [LINKED.rest, LINKED.mcp], file, { mode: 'expand', sourceBase: baseOf(SRC) });
    assert.equal(rest.status, 200, `REST: ${rest.text.slice(0, 400)}`);
    assert.equal(mcp.isError, false, `MCP: ${mcp.text.slice(0, 400)}`);
    for (const [door, id] of Object.entries(LINKED)) {
      const held = d.heldTypes(id).entity;
      assert.deepEqual(held.person, { $ref: `library:${ENTRY}` }, `${door}: the linked type was rewritten: ${JSON.stringify(held.person)}`);
      assert.deepEqual(held.place, SOURCE_TYPES.entity.place, `${door}: the type the file adds is written`);
    }
    for (const answer of [rest, mcp]) {
      assert.match(JSON.stringify(answer.body.notTaken), /library reference/, `${answer.door}: the answer does not say the linked type was kept whole`);
    }
  });

  it('the same file twice: the second build answers written: false, and the schema, its version and its history are as the first left them', async () => {
    const file = await d.exportTurtle(admin.key, SRC);
    for (const [door, id] of Object.entries(TWICE)) {
      const first = door === 'rest'
        ? await d.buildRest(admin.key, id, file, { params: { mode: 'generate', sourceBase: baseOf(SRC) } })
        : await d.buildMcp(admin.key, { space: id, document: file, format: 'turtle', mode: 'generate', sourceBase: baseOf(SRC) });
      assert.ok(first.body?.written === true, `${door}: the first build wrote nothing: ${first.text.slice(0, 300)}`);
      const was = { types: d.heldTypes(id), version: versionOf(id), snapshots: snapshotsOf(id) };
      const second = door === 'rest'
        ? await d.buildRest(admin.key, id, file, { params: { mode: 'expand', sourceBase: baseOf(SRC) } })
        : await d.buildMcp(admin.key, { space: id, document: file, format: 'turtle', mode: 'expand', sourceBase: baseOf(SRC) });
      assert.ok(second.body, `${door}: the second build was refused: ${second.text.slice(0, 300)}`);
      assert.equal(second.body.written, false, `${door}: a build that changes nothing says it wrote`);
      assert.equal(second.body.counts.changes, 0, `${door}: the file changes nothing`);
      assert.equal(versionOf(id), was.version, `${door}: the version moved for a build that changed nothing`);
      assert.equal(second.body.version, was.version, `${door}: the answer names another version than the space holds`);
      assert.equal(snapshotsOf(id), was.snapshots, `${door}: a history snapshot was pushed for a build that changed nothing`);
      assert.deepEqual(d.heldTypes(id), was.types, `${door}: the schema changed`);
    }
  });

  it('a body of white space (both doors) and an empty body (REST) change nothing and write nothing', async () => {
    const bodies = [[' \n', 'white space'], ['', 'an empty body']];
    for (const [door, id] of Object.entries(BLANK)) {
      for (const [text, what] of bodies) {
        if (door === 'mcp' && text === '') continue; // the tool's `document` is at least one character
        const was = { types: d.heldTypes(id), version: versionOf(id), snapshots: snapshotsOf(id) };
        const answer = door === 'rest'
          ? await d.buildRest(admin.key, id, text, { params: { mode: 'expand' } })
          : await d.buildMcp(admin.key, { space: id, document: text, format: 'turtle', mode: 'expand' });
        assert.ok(answer.body && (door === 'rest' ? answer.status === 200 : answer.isError === false), `${door}, ${what}: ${answer.text.slice(0, 300)}`);
        assert.equal(answer.body.written, false, `${door}, ${what}: says it wrote`);
        assert.equal(versionOf(id), was.version, `${door}, ${what}: the version moved`);
        assert.equal(snapshotsOf(id), was.snapshots, `${door}, ${what}: a history snapshot was pushed`);
        assert.deepEqual(d.heldTypes(id), was.types, `${door}, ${what}: the schema changed`);
      }
    }
  });

  it('a file of only statements the mapping does not take writes nothing, takes none of them, and its audit row claims no schema change', async () => {
    const tokens = {};
    for (const door of ['rest', 'mcp']) tokens[door] = await d.mint(`schema-rdf-writes-${door}`, {}, { admin: true });
    for (const [door, id] of Object.entries(NOT_TAKEN)) {
      const was = { types: d.heldTypes(id), version: versionOf(id), snapshots: snapshotsOf(id) };
      const answer = door === 'rest'
        ? await d.buildRest(tokens[door].key, id, NOT_A_SCHEMA, { params: { mode: 'expand' } })
        : await d.buildMcp(tokens[door].key, { space: id, document: NOT_A_SCHEMA, format: 'turtle', mode: 'expand' });
      assert.ok(answer.body, `${door}: ${answer.text.slice(0, 300)}`);
      assert.equal(answer.body.written, false, `${door}: says it wrote`);
      assert.deepEqual([answer.body.counts.statements, answer.body.counts.taken], [1, 0], `${door}: the statement was read and taken: ${JSON.stringify(answer.body.counts)}`);
      assert.equal(versionOf(id), was.version, `${door}: the version moved`);
      assert.equal(snapshotsOf(id), was.snapshots, `${door}: a history snapshot was pushed`);
      assert.deepEqual(d.heldTypes(id), was.types, `${door}: the schema changed`);
      await untilAuditWritesLanded();
      const rows = await d.col('audit_log').find({ tokenId: tokens[door].id, operation: OP }).toArray();
      assert.equal(rows.length, 1, `${door}: ${rows.length} rows`);
      const claimed = (rows[0].changes ?? []).filter(c => /^typeSchemas/.test(c.field));
      assert.deepEqual(claimed, [], `${door}: the row of a build that changed nothing claims a schema change`);
    }
  });
});

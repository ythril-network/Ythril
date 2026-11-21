/**
 * An RDF import that infers its schema from its data is bounded, judged and refused alike on both doors (bundle-270, Q-755, tests 8, 9, 11, 20,
 * 22, 24, 28, 31 and 38 of its plan): `POST /api/brain/spaces/:spaceId/import/rdf` and MCP `import_rdf`, and the schema door that does not infer.
 *
 * ## What it holds
 *
 * - 8: a file with more distinct predicates than the inference's bound answers 413 `rdf_bound_exceeded` (`schemaInferMaxPredicates`) before
 *   anything is proposed, on both doors.
 * - 9: a dry run with `from: data` answers the schema the write builds and writes nothing.
 * - 11: `import_schema_rdf` refuses `from: data`, its REST refusal naming `import_rdf`.
 * - 20: the door's record bound counts the edges of declared and inferred labels, before the act is registered.
 * - 22: the type cap counts declared and inferred types together.
 * - 24: the networked refusal's `proposed` lists hold no statement the file does not hold.
 * - 28, 38: `inferFunctional`, `inferMinSupport` and `inferMinConfidence` without `data` in `from` are refused 400 on both doors.
 * - 31: the audit row of an inferring import carries `schemaInferred` and the sources asked, and no name the file chose.
 *
 * Run: node --test testing/standalone/an-rdf-import-inferring-a-schema-is-bounded-and-judged-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openRdfImportSchemaDoors, spaceWith } from './_rdf-import-schema-doors.mjs';
import { ttl, people, TICKET_FILE, TICKET_TYPES, stepOf } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const id = (n) => `rdfinfd${n}`;
const PLAIN = ['8r', '8m', '9', '11', '20a', '20b', '24', '28r', '28m', '31'];
const MANY = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [`held${i}`, {}]));

describe('an RDF import inferring a schema is bounded and judged on both doors (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act;
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_infer_doors',
      spaces: [...PLAIN.map(n => spaceWith(id(n), undefined, STRICT)), spaceWith(id('22'), { entity: MANY }, { validationMode: 'warn' })],
    });
    writer = await d.mint('rdf-import-infer-doors-writer', Object.fromEntries([...PLAIN, '22'].map(n => [id(n), d.row({ knowledge: 'write', schema: 'write' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  async function withKnobs(k, fn) {
    act.setRdfImportKnobsForTest(k);
    try { return await fn(); } finally { act.setRdfImportKnobsForTest(null); }
  }
  const DATA = { schema: 'generate', from: ['data'] };

  it('8: more predicates than the bound answers 413 before anything is proposed, on both doors', async () => {
    const file = ttl(people(2, { extra: (i) => `ex:a "${i}" ; ex:b "${i}" ; ex:c "${i}" ; ex:d "${i}"` }));
    const { rest, mcp } = await withKnobs({ schemaInferMaxPredicates: 3 }, () => d.importBoth(writer.key, [id('8r'), id('8m')], file, DATA));
    assert.equal(rest.status, 413, rest.text.slice(0, 400));
    assert.equal(rest.code, 'rdf_bound_exceeded');
    assert.equal(rest.body?.bound, 'schemaInferMaxPredicates', rest.text.slice(0, 400));
    assert.equal(mcp.code, 'rdf_bound_exceeded', mcp.text.slice(0, 400));
    for (const space of [id('8r'), id('8m')]) {
      assert.deepEqual(d.heldTypes(space), {}, space);
      assert.deepEqual(await d.records(space, 'entities'), [], space);
    }
  });

  it('9: a dry run with from: data answers the schema the write builds and writes nothing', async () => {
    const dry = await d.importRestOne(writer.key, id('9'), TICKET_FILE, { ...DATA, dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 400));
    assert.deepEqual(d.heldTypes(id('9')), {}, 'the dry run writes no schema');
    assert.deepEqual(await d.records(id('9'), 'entities'), [], 'the dry run writes no record');
    const real = await d.importRestOne(writer.key, id('9'), TICKET_FILE, DATA);
    assert.equal(real.status, 200, real.text.slice(0, 400));
    assert.deepEqual(stepOf(dry)?.typesAdded, stepOf(real)?.typesAdded, 'the dry run names the types the write adds');
    assert.deepEqual(stepOf(dry)?.inferred?.types, stepOf(real)?.inferred?.types);
    assert.deepEqual(d.heldTypes(id('9')), TICKET_TYPES);
  });

  it('11: import_schema_rdf refuses from: data, its refusal naming import_rdf', async () => {
    const { rest, mcp } = await d.both(writer.key, id('11'), TICKET_FILE, { mode: 'generate', from: ['data'] });
    assert.equal(rest.status, 400, rest.text.slice(0, 400));
    assert.equal(rest.code, 'schema_rdf_bad_param');
    assert.match(rest.body?.error ?? '', /import_rdf/, `the refusal points at the door that infers: ${rest.text.slice(0, 400)}`);
    assert.equal(mcp.isError, true, `MCP: ${mcp.text.slice(0, 400)}`);
    assert.match(mcp.text, /data|from/, mcp.text.slice(0, 400));
    assert.deepEqual(d.heldTypes(id('11')), {});
  });

  it('20: the door\'s record bound counts edges of declared and inferred labels before the act is registered', async () => {
    const declared = ttl('ex:knows a owl:ObjectProperty .', 'ex:Person a owl:Class .', people(2, { extra: (i) => `ex:knows p:person${1 - i}` }));
    for (const [space, file, from] of [[id('20a'), declared, ['declared']], [id('20b'), TICKET_FILE, ['data']]]) {
      let registered = 0;
      const r = await withKnobs({ maxRecords: 3, hooks: { beforeRegister: () => { registered += 1; } } },
        () => d.importRestOne(writer.key, space, file, { schema: 'generate', from }));
      assert.equal(r.status, 413, `${from}: ${r.text.slice(0, 400)}`);
      assert.equal(r.code, 'rdf_bound_exceeded');
      assert.equal(registered, 0, `${from}: the bound is the door's, met before the act is registered`);
    }
  });

  it('22: the type cap counts declared and inferred types together', async () => {
    const declaredOnly = ttl('ex:Declared a owl:Class .', people(2, { cls: 'ex:Declared', prefix: 'dc' }));
    const ok = await d.importRestOne(writer.key, id('22'), declaredOnly, { schema: 'expand', from: ['declared'], dryRun: true });
    assert.equal(ok.status, 200, `the declared type alone fits: ${ok.text.slice(0, 400)}`);
    const both = ttl('ex:Declared a owl:Class .', people(2, { cls: 'ex:Declared', prefix: 'dc' }), people(2, { cls: 'ex:Inferred', prefix: 'in' }));
    const r = await d.importRestOne(writer.key, id('22'), both, { schema: 'expand', from: ['declared', 'data'], dryRun: true });
    assert.equal(r.status, 422, r.text.slice(0, 400));
    assert.equal(r.code, 'schema_rdf_refused');
    assert.equal(r.body?.reasons?.[0]?.code, 'type-cap', r.text.slice(0, 400));
  });

  it('24: the networked refusal\'s proposed lists hold no statement the file does not hold', async () => {
    const r = await withKnobs({ hooks: { beforeSchemaWrite: () => d.joinNetwork('rdfinfdnet', id('24')) } },
      () => d.importRestOne(writer.key, id('24'), TICKET_FILE, DATA));
    assert.equal(r.code, 'schema_rdf_networked', r.text.slice(0, 400));
    const proposed = r.body?.proposed;
    assert.ok(proposed, r.text.slice(0, 400));
    assert.equal(proposed.counts?.statements, 0, `the file holds no schema statement: ${JSON.stringify(proposed.counts)}`);
    assert.deepEqual([...(proposed.taken ?? []), ...(proposed.notTaken ?? [])], [], 'no synthetic statement is listed');
    assert.ok(!/shacl#|owl#Class|owl#DatatypeProperty/.test(JSON.stringify(proposed)), 'no declaration the file never held');
    assert.ok((proposed.changes ?? []).some(c => c.source === 'data'), `the changes name their source: ${JSON.stringify(proposed.changes)}`);
  });

  it('28, 38: inferFunctional, inferMinSupport and inferMinConfidence without data in from are refused on both doors', async () => {
    for (const extra of [{ inferFunctional: true }, { inferMinSupport: 1 }, { inferMinConfidence: 0.5 }]) {
      for (const from of [undefined, ['declared']]) {
        const params = { schema: 'generate', ...(from ? { from } : {}), ...extra };
        const { rest, mcp } = await d.importBoth(writer.key, [id('28r'), id('28m')], TICKET_FILE, params);
        assert.equal(rest.status, 400, `${JSON.stringify(params)}: ${rest.text.slice(0, 300)}`);
        assert.equal(rest.code, 'rdf_import_bad_param', `${JSON.stringify(params)}: ${rest.text.slice(0, 300)}`);
        assert.equal(mcp.code, 'rdf_import_bad_param', `MCP ${JSON.stringify(params)}: ${mcp.text.slice(0, 300)}`);
      }
    }
    for (const space of [id('28r'), id('28m')]) assert.deepEqual(d.heldTypes(space), {});
  });

  it('31: the audit row of an inferring import carries schemaInferred and the sources, and no name from the file', async () => {
    const r = await d.importRestOne(writer.key, id('31'), TICKET_FILE, DATA);
    assert.equal(r.status, 200, r.text.slice(0, 400));
    await untilAuditWritesLanded();
    const rows = await d.col('audit_log').find({ tokenId: writer.id, operation: 'rdf.import', spaceId: id('31') }).toArray();
    assert.equal(rows.length, 1, JSON.stringify(rows.map(x => x.operation)));
    const changes = rows[0].changes ?? [];
    assert.equal(changes.find(c => c.field === 'schemaInferred')?.to, 3, `a type, a property, an edge label: ${JSON.stringify(changes)}`);
    assert.equal(changes.find(c => c.field === 'schemaFrom')?.to, 'data', JSON.stringify(changes));
    assert.ok(!/Person|knows|data\.example|people\.example/.test(JSON.stringify(changes)), `a name the file chose: ${JSON.stringify(changes)}`);
  });
});

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
 * - 22: declared and inferred types together take a kind past 200 types and are written: no count of types refuses a schema (Q-981).
 * - 24: the networked refusal's `proposed` lists hold no statement the file does not hold.
 * - 28, 38: `inferFunctional`, `inferMinSupport` and `inferMinConfidence` without `data` in `from` are refused 400 on both doors.
 * - 31: the audit row of an inferring import carries `schemaInferred` and the sources asked, and no name the file chose.
 * - I1: a file whose subjects are typed with more distinct classes than the inference's bound answers 413 `rdf_bound_exceeded`
 *   (`schemaInferMaxClasses`) on both doors, writes nothing and leaves no import folder; a file at the bound is let through.
 * - I2: a file whose subjects of several graphs add more distinct (subject, predicate) pairs than the pair bound answers 413
 *   (`schemaInferMaxPairs`) the same way; a file at the bound is let through.
 * - I3: an edge label whose built definition is invalid releases its name and is not written: a file with such a label beside a valid one is
 *   written with the valid one, never answered 500.
 * - R1: the released name's open sides go with it: an edge that takes the name afterwards is reported with the sides it has, not the released one's.
 * - R2: a space holding more than 200 types of one kind still receives types of another kind.
 *
 * Run: node --test testing/standalone/an-rdf-import-inferring-a-schema-is-bounded-and-judged-on-both-doors-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openRdfImportSchemaDoors, spaceWith, baseOf } from './_rdf-import-schema-doors.mjs';
import { ttl, people, TICKET_FILE, TICKET_TYPES, stepOf } from './_rdf-import-infer.mjs';

const skip = await mongoSkipReason();
const STRICT = { validationMode: 'strict' };
const id = (n) => `rdfinfd${n}`;
const PLAIN = ['8r', '8m', '9', '11', '20a', '20b', '24', '28r', '28m', '31', 'i1r', 'i1m', 'i1ok', 'i2r', 'i2m', 'i2ok'];
const MANY = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [`held${i}`, {}]));
/** A space holding 201 edge types: more than the per-kind count limit this release removed (Q-981). */
const PAST_CAP = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`old${i}`, {}]));

describe('an RDF import inferring a schema is bounded and judged on both doors (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act;
  before(async () => {
    d = await openRdfImportSchemaDoors({
      suite: 'rdf_import_infer_doors',
      spaces: [...PLAIN.map(n => spaceWith(id(n), undefined, STRICT)), spaceWith(id('22'), { entity: MANY }, { validationMode: 'warn' }), spaceWith(id('i3'), { edge: MANY }, { validationMode: 'warn' }), spaceWith(id('r2'), { edge: PAST_CAP }, { validationMode: 'warn' }), spaceWith(id('r1'), undefined, { validationMode: 'warn' })],
    });
    writer = await d.mint('rdf-import-infer-doors-writer', Object.fromEntries([...PLAIN, '22', 'i3', 'r2', 'r1'].map(n => [id(n), d.row({ knowledge: 'write', schema: 'write' })])));
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
      const r = await withKnobs({ bounds: { memoryBytes: 300 }, hooks: { beforeRegister: () => { registered += 1; } } },
        () => d.importRestOne(writer.key, space, file, { schema: 'generate', from }));
      assert.equal(r.status, 413, `${from}: ${r.text.slice(0, 400)}`);
      assert.equal(r.code, 'rdf_bound_exceeded');
      assert.equal(registered, 0, `${from}: the bound is the door's, met before the act is registered`);
    }
  });

  it('22: declared and inferred types together take a kind past 200 types, and are written', async () => {
    const both = ttl('ex:Declared a owl:Class .', people(2, { cls: 'ex:Declared', prefix: 'dc' }), people(2, { cls: 'ex:Inferred', prefix: 'in' }));
    const r = await d.importRestOne(writer.key, id('22'), both, { schema: 'expand', from: ['declared', 'data'] });
    assert.equal(r.status, 200, r.text.slice(0, 400));
    const held = Object.keys(d.heldTypes(id('22')).entity ?? {});
    assert.equal(held.length, 201, `the 199 held types, the declared one and the inferred one: ${held.filter(n => !n.startsWith('held')).join()}`);
    assert.ok(held.includes('Declared') && held.includes('Inferred'), held.filter(n => !n.startsWith('held')).join());
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

  const folders = () => { const dir = path.join(d.loader.getDataRoot(), 'rdf-import'); return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; };
  /** A refused import wrote no schema, no record and no file: `spaces` hold nothing and the import folders are as they were. */
  async function assertNothingKept(spaces, before) {
    for (const space of spaces) {
      assert.deepEqual(d.heldTypes(space), {}, space);
      assert.deepEqual(await d.records(space, 'entities'), [], space);
    }
    assert.deepEqual(folders(), before, 'the refused import left its spool and step file behind');
  }

  it('I1: one class more than the bound answers 413 on both doors, writes nothing and removes the import\'s files; a file at the bound is let through', async () => {
    const classes = (n) => ttl(...Array.from({ length: n }, (_, c) => people(2, { cls: `ex:Kind${c}`, prefix: `k${c}x` })));
    const before = folders();
    const { rest, mcp } = await withKnobs({ schemaInferMaxClasses: 3 }, () => d.importBoth(writer.key, [id('i1r'), id('i1m')], classes(4), DATA));
    assert.equal(rest.status, 413, rest.text.slice(0, 400));
    assert.equal(rest.code, 'rdf_bound_exceeded');
    assert.equal(rest.body?.bound, 'schemaInferMaxClasses', rest.text.slice(0, 400));
    assert.equal(rest.body?.limit, 3, rest.text.slice(0, 400));
    assert.equal(mcp.code, 'rdf_bound_exceeded', mcp.text.slice(0, 400));
    await assertNothingKept([id('i1r'), id('i1m')], before);
    const at = await withKnobs({ schemaInferMaxClasses: 3 }, () => d.importRestOne(writer.key, id('i1ok'), classes(3), { ...DATA, dryRun: true }));
    assert.equal(at.status, 200, `a file with exactly as many classes as the bound is inferred from: ${at.text.slice(0, 400)}`);
  });

  it('I2: one counted (subject, predicate) pair more than the bound answers 413 on both doors and writes nothing; a file at the bound is let through', async () => {
    // Three subjects stated in the default graph and in a named graph, two predicates each: six pairs, each counted once.
    const lines = (n) => Array.from({ length: n }, (_, i) => `p:s${i} a ex:Person ; ex:a "1" ; ex:b "2" .`);
    const file = ttl(lines(3), '<http://g.example/one> {', lines(3), '}');
    const before = folders();
    const opts = { format: 'trig' };
    const { rest, mcp } = await withKnobs({ schemaInferMaxPairs: 5 }, () => d.importBoth(writer.key, [id('i2r'), id('i2m')], file, DATA, opts));
    assert.equal(rest.status, 413, rest.text.slice(0, 400));
    assert.equal(rest.code, 'rdf_bound_exceeded');
    assert.equal(rest.body?.bound, 'schemaInferMaxPairs', rest.text.slice(0, 400));
    assert.equal(rest.body?.limit, 5, rest.text.slice(0, 400));
    assert.equal(mcp.code, 'rdf_bound_exceeded', mcp.text.slice(0, 400));
    await assertNothingKept([id('i2r'), id('i2m')], before);
    const at = await withKnobs({ schemaInferMaxPairs: 6 }, () => d.importRestOne(writer.key, id('i2ok'), file, { ...DATA, dryRun: true }, opts));
    assert.notEqual(at.status, 413, `a file with exactly as many pairs as the bound is inferred from: ${at.text.slice(0, 400)}`);
  });

  it('I3: an edge label whose definition turns out invalid is not written, and the valid label beside it is, never a 500', async () => {
    // The space holds 199 edge types. `knows` is the 200th; the other label's address is past the schema's IRI length, so its definition is refused
    // after its name was claimed. Sorted by address it is claimed first, and its name is given back.
    const LONG = `http://data.example/${'a'.repeat(2100)}`;
    const file = ttl(`<${LONG}> rdfs:label "linkedTo" .`, people(2, { extra: (i) => `ex:knows p:person${1 - i} ; <${LONG}> p:person${1 - i}` }));
    const r = await d.importRestOne(writer.key, id('i3'), file, { schema: 'expand', from: ['data'] });
    assert.equal(r.status, 200, r.text.slice(0, 600));
    const edges = Object.keys(d.heldTypes(id('i3')).edge ?? {});
    assert.equal(edges.length, 200, 'the 199 held edge types and `knows`');
    assert.ok(edges.includes('knows') && !edges.includes('linkedTo'), edges.filter(e => !e.startsWith('held')).join());
    const left = (stepOf(r)?.inferred?.notInferred ?? []).find(n => n.iri === LONG);
    assert.equal(left?.why, 'invalid', JSON.stringify(stepOf(r)?.inferred?.notInferred ?? []).slice(0, 600));
  });

  it('R1: the open side of an edge label whose definition turned out invalid is not carried to the edge that takes its released name', async () => {
    // A (an address past the schema's IRI length, labelled `rel`) has an end the space stores, so its `to` side is open, and its definition is invalid.
    // B (`http://z.example/rel`) is claimed after it and takes the released `rel`, with both ends typed.
    const LONG = `http://data.example/${'b'.repeat(2100)}`;
    await d.seed(id('r1'), 'entity', [{ _id: 'stored1', name: 'Stored', type: null, properties: {} }]);
    const file = ttl(
      `<${LONG}> rdfs:label "rel" .`,
      people(2, { extra: (i) => `<${LONG}> <${baseOf(id('r1'))}entity/stored1> ; <http://z.example/rel> p:org${i}` }),
      people(2, { cls: 'ex:Org', prefix: 'org' }),
    );
    const r = await d.importRestOne(writer.key, id('r1'), file, { schema: 'expand', from: ['data'] });
    assert.equal(r.status, 200, r.text.slice(0, 600));
    const inferred = stepOf(r)?.inferred ?? {};
    assert.equal((inferred.notInferred ?? []).find(n => n.iri === LONG)?.why, 'invalid', JSON.stringify(inferred.notInferred ?? []).slice(0, 600));
    assert.deepEqual(d.heldTypes(id('r1')).edge?.rel?.endpoints, { from: ['Person'], to: ['Org'] }, JSON.stringify(d.heldTypes(id('r1')).edge ?? {}));
    assert.deepEqual((inferred.openEndpoints ?? []).filter(o => o.type === 'rel'), [], `the released name's open side: ${JSON.stringify(inferred.openEndpoints ?? [])}`);
  });

  it('R2: a space holding more than 200 types of one kind still receives types of another kind', async () => {
    // 201 edge types are stored; the file adds one entity type and no edge.
    const r = await d.importRestOne(writer.key, id('r2'), ttl(people(2)), { schema: 'expand', from: ['data'] });
    assert.equal(r.status, 200, r.text.slice(0, 600));
    assert.deepEqual(Object.keys(d.heldTypes(id('r2')).entity ?? {}), ['Person'], 'the entity type the file adds is written');
    assert.equal(Object.keys(d.heldTypes(id('r2')).edge ?? {}).length, 201, 'the stored edge types are untouched');
  });
});

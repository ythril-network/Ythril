/**
 * Every address an RDF export or a schema RDF export writes under a space's base dereferences under `/ld/` to at least the statements those
 * exports write about it (bundle-271, Q-758; design §3, r2 R1.3, R1.4; S3b).
 *
 * ## The rule
 *
 * The quad source's fixture (`_quad-source-fixture.mjs`: two spaces whose bases are `https://rdf.example.org/ld/<space>/`, records of every
 * kind, a file row, an edge with a property, an agent that wrote rows in both; chrono entries of types the schema does not declare) gets
 * one more record here, an edge in space B whose label B's schema does not declare. Each space is then exported whole by the records
 * export (N-Quads, description graph included) and by the schema RDF export (Turtle). Every named node of either document that lies under
 * a space's base, as a subject or as an object, is an address; its path is read (a fragment never travels, so `#start`, `#end`, a
 * property `#<prop>` and a property shape's `#<prop>` are read at their document's address). With the instance's public URL at
 * `https://rdf.example.org`, a `GET` of each path by a token with knowledge, files and schema read answers `200` with a body holding
 * every statement either export writes with a subject at that document. The namespace prefixes `vocab/` and `vocab/<kind>/` are no
 * address and are excepted by rule. The addresses fall into groups, each one case, each asserted non-empty so the rule cannot pass over
 * an export that lost a group:
 *
 * - records, files, agents and schema versions;
 * - the base root `<base>`, the graph the description writes `dcterms:isPartOf` and `sh:shapesGraph` about;
 * - `vocab/...`: a declared type answers what the schema export writes; a type records use and the schema does not declare answers the
 *   definition the schema act writes for it (`rdf:type rdfs:Class`, `owl:ObjectProperty` for an edge label, and `rdfs:label` its name);
 * - `schema` (the ontology) and `schema/shape/<kind>/<type>` (a shape with its property shapes).
 *
 * A predicate under the base is an address as well (lens round): a record with no type, and a file, write their properties as fragments of the
 * kind's own document (`<vocab>file#owner`), so `vocab/file` answers each property the records use, `rdf:type rdf:Property` and `rdfs:label`
 * (the schema act's `usedPropertiesDefinition`), read with schema read and, for the usage probe, knowledge read.
 *
 * A type no record uses has no address an export writes: `vocab/<kind>/<type>` of it answers 404, as does an undeclared type that is used
 * when the token reads the schema but not the records.
 *
 * ## Seen red
 *
 * On c647bd24f every address under `/ld/` answered the 404 placeholder. On c0cf1c35e (S3) the records group passes and the other three
 * are red: the base root, `vocab/chrono/event` and `vocab/edge/likes`, `schema` and every `schema/shape/...` answer 404. Mutations: the
 * record body without the chrono entry's `#start` and `#end` subjects; the vocab door without the usage probe (a type no record uses then
 * answers 200).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/every-address-an-export-writes-dereferences-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openQuadSourceFixture, A, B, baseOf } from './_quad-source-fixture.mjs';
import { exportText } from './_rdf-source-fixture.mjs';
import { parseRdf, termText } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
/** The public URL the fixture's bases are under: the default base of a space is `<public URL>/ld/<space>/`. */
const PUBLIC = 'https://rdf.example.org';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class';
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const KINDS = ['entity', 'fact', 'chrono', 'edge', 'file'];

let f, readerKey, schemaOnlyKey;
/** Path (no fragment) to the set of statements the exports write with a subject at that document. */
const expected = new Map();
const previousPublic = process.env['PUBLIC_BASE_URL'];

/** The path an address is read at: the address under the public URL, without its fragment. */
const pathOf = (address) => address.slice(PUBLIC.length).replace(/#.*$/, '');
const tripleText = (q) => `${termText(q.subject)} ${termText(q.predicate)} ${termText(q.object)}`;
const bases = () => [baseOf(A), baseOf(B)];
const underBase = (t) => t.termType === 'NamedNode' && bases().some(b => t.value.startsWith(b));
/** A namespace prefix (`<base>vocab/`, `<base>vocab/<kind>/`): no address, excepted by rule. */
const isNamespace = (path) => bases().some(b => {
  const rest = PUBLIC.concat(path).slice(b.length);
  return PUBLIC.concat(path).startsWith(b) && (rest === 'vocab/' || KINDS.some(k => rest === `vocab/${k}/`));
});
/** The group of a path: `root`, `vocab`, `schema-graph` (ontology and shapes) or `records` (records, files, agents, schema versions). */
function groupOf(path) {
  const base = bases().find(b => PUBLIC.concat(path).startsWith(b));
  const rest = PUBLIC.concat(path).slice(base.length);
  if (rest === '') return 'root';
  if (rest.startsWith('vocab/')) return 'vocab';
  if (rest === 'schema' || rest.startsWith('schema/shape/')) return 'schema-graph';
  return 'records';
}

/** Read each path of `group` and name every statement the exports write about it that its answer lacks. */
async function missingOf(group) {
  const paths = [...expected.keys()].filter(p => groupOf(p) === group);
  assert.ok(paths.length > 0, `the exports hold no address of group ${group}`);
  const missing = [];
  for (const path of paths) {
    const r = await f.d.restGet(readerKey, path, { Accept: 'application/n-quads' });
    if (r.status !== 200) { missing.push(`${path}: ${r.status} ${r.text.slice(0, 160)}`); continue; }
    const got = new Set((await parseRdf('nquads', r.text)).map(tripleText));
    for (const t of expected.get(path)) if (!got.has(t)) missing.push(`${path}: ${t}`);
  }
  return { paths, missing };
}

describe('every address an export writes dereferences', { skip }, () => {
  before(async () => {
    f = await openQuadSourceFixture('ld-deref');
    // An edge whose label B's schema does not declare: its vocab address is a type used and not declared, of the edge kind.
    await f.d.seed(B, 'edge', [{ _id: 'b-edge-likes', from: 'b-1', to: 'b-1', label: 'likes', createdAt: '2026-03-04T05:06:07.000Z' }]);
    const reads = { knowledge: 'read', files: 'read', schema: 'read' };
    readerKey = (await f.d.mint('ld-deref-key', { [A]: f.d.row(reads), [B]: f.d.row(reads) })).key;
    schemaOnlyKey = (await f.d.mint('ld-deref-schema-key', { [A]: f.d.row({ schema: 'read' }), [B]: f.d.row({ schema: 'read' }) })).key;
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
    for (const space of [A, B]) {
      const records = await parseRdf('nquads', await exportText(f.d, readerKey, space, 'nquads'));
      const schema = await f.d.restGet(readerKey, `/api/spaces/${encodeURIComponent(space)}/schema-rdf`, { Accept: 'text/turtle' });
      assert.equal(schema.status, 200, `schema export of ${space}: ${schema.text.slice(0, 200)}`);
      for (const q of [...records, ...await parseRdf('turtle', schema.text)]) {
        // A predicate under the base is an address too: a property of an untyped kind is a fragment of the kind's own document (`vocab/file#owner`).
        for (const t of [q.subject, q.predicate, q.object]) {
          if (!underBase(t)) continue;
          const path = pathOf(t.value);
          if (!isNamespace(path) && !expected.has(path)) expected.set(path, new Set());
        }
        if (underBase(q.subject) && !isNamespace(pathOf(q.subject.value))) expected.get(pathOf(q.subject.value)).add(tripleText(q));
      }
    }
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await f?.d.close();
  });

  it('each record, file, agent and schema version answers at least the statements the export writes about it', async () => {
    const kinds = new Set([...expected.keys()].filter(p => groupOf(p) === 'records').map(p => p.split('/')[3]));
    for (const k of ['entity', 'fact', 'chrono', 'edge', 'file', 'agent', 'schema']) assert.ok(kinds.has(k), `the export holds no ${k} address: ${[...kinds].join(', ')}`);
    const { missing } = await missingOf('records');
    assert.deepEqual(missing, [], `statements the exports write that the address does not answer (${missing.length} of them)`);
  });

  it('the base root answers the statements the export writes about the graph', async () => {
    const { paths, missing } = await missingOf('root');
    assert.ok(paths.every(p => expected.get(p).size > 0), 'the export writes no statement about a base root');
    assert.deepEqual(missing, [], `statements the exports write that the base root does not answer (${missing.length} of them)`);
  });

  it('a vocabulary address answers its term, a type records use and the schema does not declare included', async () => {
    const { paths, missing } = await missingOf('vocab');
    for (const used of [`/ld/${A}/vocab/chrono/event`, `/ld/${B}/vocab/edge/likes`]) assert.ok(paths.includes(used), `the export writes no ${used}`);
    assert.deepEqual(missing, [], `statements the exports write that the vocabulary address does not answer (${missing.length} of them)`);
    for (const [path, cls] of [[`/ld/${A}/vocab/chrono/event`, RDFS_CLASS], [`/ld/${B}/vocab/edge/likes`, OWL_OBJECT_PROPERTY]]) {
      const r = await f.d.restGet(readerKey, path, { Accept: 'application/n-quads' });
      const got = new Set((await parseRdf('nquads', r.text)).map(tripleText));
      const name = path.slice(path.lastIndexOf('/') + 1);
      assert.ok(got.has(`<${PUBLIC}${path}> <${RDF_TYPE}> <${cls}>`), `${path} is not answered as a ${cls}: ${r.text.slice(0, 300)}`);
      assert.ok(got.has(`<${PUBLIC}${path}> <${RDFS_LABEL}> "${name}"^^<http://www.w3.org/2001/XMLSchema#string>`), `${path} has no label ${name}`);
    }
  });

  it('the document of an untyped kind answers its properties, each rdf:type rdf:Property with its label (vocab/file, vocab/entity)', async () => {
    const { paths } = await missingOf('vocab');
    const untyped = paths.filter(p => /\/vocab\/(file|entity|fact|chrono)$/.test(p));
    assert.ok(untyped.includes(`/ld/${A}/vocab/file`), `the exports write no property of an untyped kind in ${A}: ${paths.join(', ')}`);
    for (const path of untyped) {
      const r = await f.d.restGet(readerKey, path, { Accept: 'application/n-quads' });
      assert.equal(r.status, 200, `${path}: ${r.status} ${r.text.slice(0, 200)}`);
      const got = (await parseRdf('nquads', r.text)).map(tripleText);
      const properties = got.filter(t => t.includes(`<${RDF_TYPE}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#Property>`));
      assert.ok(properties.length > 0, `${path} answers no rdf:Property: ${r.text.slice(0, 300)}`);
      for (const t of properties) {
        const subject = t.slice(1, t.indexOf('>'));
        assert.ok(subject.startsWith(`${PUBLIC}${path}#`), `${path} answers a property that is no fragment of it: ${subject}`);
        const name = decodeURIComponent(subject.slice(subject.indexOf('#') + 1));
        assert.ok(got.includes(`<${subject}> <${RDFS_LABEL}> "${name}"^^<http://www.w3.org/2001/XMLSchema#string>`), `${subject} has no label ${name}`);
      }
    }
  });

  it('the ontology and every shape answer what the schema export writes about them', async () => {
    const { paths, missing } = await missingOf('schema-graph');
    assert.ok(paths.includes(`/ld/${A}/schema`) && paths.some(p => p.startsWith(`/ld/${A}/schema/shape/`)), `no ontology or shape address: ${paths.join(', ')}`);
    assert.deepEqual(missing, [], `statements the schema export writes that the address does not answer (${missing.length} of them)`);
  });

  it('a type no record uses, or one read without the records, answers 404', async () => {
    // The namespace prefix of a kind (`vocab/file/`, trailing slash) is no address, and a kind with no property in use answers 404 too.
    for (const path of [`/ld/${A}/vocab/entity/Nobody`, `/ld/${A}/vocab/edge/nobody`, `/ld/${B}/vocab/fact/nothing`, `/ld/${A}/vocab/file/`, `/ld/${B}/vocab/file`]) {
      const r = await f.d.restGet(readerKey, path, { Accept: 'application/n-quads' });
      assert.equal(r.status, 404, `${path}: ${r.status} ${r.text.slice(0, 200)}`);
    }
    const r = await f.d.restGet(schemaOnlyKey, `/ld/${A}/vocab/chrono/event`, { Accept: 'application/n-quads' });
    assert.equal(r.status, 404, `a token without knowledge read learned a type is used: ${r.status} ${r.text.slice(0, 200)}`);
    const declared = await f.d.restGet(schemaOnlyKey, `/ld/${A}/vocab/entity/Person`, { Accept: 'application/n-quads' });
    assert.equal(declared.status, 200, `a declared type is the schema's, read with schema read: ${declared.status}`);
  });
});

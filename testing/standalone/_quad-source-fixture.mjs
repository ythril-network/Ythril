/**
 * The fixture the quad source's database tests share (bundle-271, Q-756): two RDF-on spaces through the real application, their records
 * exported as N-Quads by the export door, and the readers the tests compare the source with.
 *
 * ## What it holds, and why each part is there
 *
 * Space `A` is the RDF import's source space (`_rdf-source-fixture.mjs`, written through the REST doors) with a schema that adds what the
 * narrowing rules can get wrong (design r2, R1.1 and R4.3):
 *
 * - a **shared property address**: `Person.nick` and `Org.alias` both name {@link SHARED_IRI}, so a property rule must read both types;
 * - an **edge label with an explicit address** (`about`, {@link ABOUT_IRI}): its statements use that address and its reifiers keep the
 *   space's own class, so a class rule that reads the class through the label's address misses them;
 * - an **edge property** (`knows.since`) on a seeded edge;
 * - a **file row** (inserted directly, as the export tests do), an edge whose end is that file and a link whose start is it;
 * - an **untyped entity** (`ythril:Untyped`), a **fork row** and a **deleted file**, which no answer may carry.
 *
 * Space `B` holds one entity by the same agent as `A`'s seeded rows: the agent's statements are written once per space, in that space's graph,
 * so a source that remembers agents across members drops `B`'s.
 *
 * Run inside a file that imports it: the doors start the application in this process, so the server modules it loads read the same config
 * and database.
 */
import { openRdfImportDoors } from './_rdf-import-doors.mjs';
import { sourceMeta, writeSource, exportText, baseOf } from './_rdf-source-fixture.mjs';
import { rdfMeta, parseRdf, termText } from './_rdf-export-doors.mjs';

export const A = 'qsrca';
export const B = 'qsrcb';
export { baseOf };

/** The address `Person.nick` and `Org.alias` share. */
export const SHARED_IRI = 'https://terms.example.org/q756/nickname';
/** The explicit address of the `about` edge label. */
export const ABOUT_IRI = 'https://terms.example.org/q756/about';
/** The file row's path, which is its id. */
export const FILE_PATH = 'docs/plan.txt';

const SCHEMA = {
  entity: {
    Person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string', iri: SHARED_IRI } } },
    Org: { propertySchemas: { size: { type: 'number' }, alias: { type: 'string', iri: SHARED_IRI } } },
  },
  fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
  edge: { knows: { propertySchemas: { since: { type: 'string' } } }, about: { iri: ABOUT_IRI } },
};

const STAMP = '2026-03-04T05:06:07.000Z';

/**
 * Open the doors over both spaces, write and seed the fixture, and export both.
 * @returns the doors `d`, the ids by name, an admin-like reader's token record (`reader`: knowledge and files read on both), a
 *   knowledge-only one (`knowledgeOnly`), and the export quads each of them may read (`exported`, `exportedKnowledgeOnly`): the record
 *   statements only, the description graph and the statements about a graph left out.
 */
export async function openQuadSourceFixture(suite) {
  const d = await openRdfImportDoors({
    suite,
    spaces: [
      { id: A, meta: sourceMeta(A, { typeSchemas: SCHEMA }) },
      { id: B, meta: rdfMeta(B, { typeSchemas: { entity: { Person: {} } } }) },
    ],
  });
  const writer = await d.mint(`${suite}-writer`, { [A]: d.row({ knowledge: 'write', schema: 'admin', files: 'read' }), [B]: d.row({ knowledge: 'write', files: 'read' }) });
  const ids = await writeSource(d, writer.key, A);
  await d.seed(A, 'entity', [
    { _id: 'org-2', name: 'Difference Works', type: 'Org', properties: { alias: 'DW', size: 3 }, createdAt: STAMP, updatedAt: STAMP },
    { _id: 'untyped-1', name: 'Nobody in particular', createdAt: STAMP, updatedAt: STAMP },
    { _id: 'fork-1', name: 'Ada (fork)', type: 'Person', forkOf: ids.ada },
  ]);
  await d.seed(A, 'edge', [
    { _id: 'edge-since', from: ids.charles, to: ids.ada, label: 'knows', properties: { since: '1833' } },
    { _id: 'edge-file', from: ids.ada, to: FILE_PATH, toKind: 'file', label: 'about' },
  ]);
  await d.seed(A, 'link', [{ _id: 'link-file', from: FILE_PATH, fromKind: 'file', to: ids.engines, toKind: 'entity' }]);
  await d.seed(A, 'file', [
    { _id: FILE_PATH, path: FILE_PATH, sizeBytes: 42, sha256: 'ab'.repeat(32), description: 'a plan', tags: ['plan'], properties: { owner: 'ada' }, createdAt: STAMP, updatedAt: STAMP },
    { _id: 'old.txt', path: 'old.txt', sizeBytes: 1, deletedAt: STAMP },
  ]);
  await d.seed(B, 'entity', [{ _id: 'b-1', name: 'Bea', type: 'Person', createdAt: STAMP, updatedAt: STAMP }]);
  ids.org2 = 'org-2';

  const reader = await d.mint(`${suite}-reader`, { [A]: d.row({ knowledge: 'read', files: 'read' }), [B]: d.row({ knowledge: 'read', files: 'read' }) });
  const knowledgeOnly = await d.mint(`${suite}-knowledge`, { [A]: d.row({ knowledge: 'read' }), [B]: d.row({ knowledge: 'read' }) });
  const exportOf = async (key) => {
    const quads = [];
    for (const space of [A, B]) quads.push(...recordStatements(await parseRdf('nquads', await exportText(d, key, space, 'nquads')), space));
    return quads;
  };
  return {
    d, ids, reader: reader.record, knowledgeOnly: knowledgeOnly.record,
    exported: await exportOf(reader.key), exportedKnowledgeOnly: await exportOf(knowledgeOnly.key),
  };
}

/**
 * The record statements of one space's export: the quads in its graph, without the description graph's (the report node and every
 * statement about the graph itself), which is not a record and is never served (design §0).
 */
function recordStatements(quads, space) {
  const graph = baseOf(space);
  const report = (t) => t.termType === 'NamedNode' && t.value.startsWith('urn:ythril:export-report:');
  return quads.filter(q => q.graph.value === graph && !report(q.subject) && !report(q.object) && q.subject.value !== graph);
}

/** A quad as one comparable string, its graph included. */
export const quadText = (q) => `${termText(q.subject)} ${termText(q.predicate)} ${termText(q.object)} ${termText(q.graph)}`;

/** The pattern of `q` under `mask`: bit 8 keeps the subject, 4 the predicate, 2 the object, 1 the graph; a cleared bit is unbound. */
export const patternOf = (q, mask) => [mask & 8 ? q.subject : undefined, mask & 4 ? q.predicate : undefined, mask & 2 ? q.object : undefined, mask & 1 ? q.graph : undefined];

/** Every quad a stream gives, or its error. */
export function drain(stream) {
  return new Promise((resolve, reject) => {
    const out = [];
    stream.on('data', q => out.push(q));
    stream.on('error', reject);
    stream.on('end', () => resolve(out));
  });
}

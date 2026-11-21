/**
 * The doors the tests of the RDF data import's schema option drive (bundle-270, Q-955): the schema-from-RDF doors (`_schema-rdf-import-doors.mjs`,
 * which carry the data import's doors too) and one call that sends the same import through `POST /api/brain/spaces/:spaceId/import/rdf` and MCP
 * `import_rdf`, answered in one shape.
 *
 * ## The contract it encodes, written before the change
 *
 * - Both doors take `schema` (`none`, `generate`, `expand`, `update`) and `from` (`declared`, `shacl`, `data`; REST repeats it) beside the
 *   import's own parameters. With `schema` set the file's classes and shapes build or extend the space's type schemas, the data is judged by that
 *   schema, the schema is written once from inside the import's act, and every record carries the written schema's fingerprint.
 * - The report of an import with `schema` carries `schema` (`{ written, typesAdded, typesChanged, fingerprintBefore, fingerprintAfter, notice }`).
 * - The act's knobs: `setRdfImportKnobsForTest({ schemaMaxQuads, hooks: { beforeSchemaWrite, afterSchemaWrite } })` in
 *   `server/dist/spaces/rdf-import-act.js`.
 */
import { openSchemaRdfImportDoors, spaceWith, baseOf, mcpCode, rdfMeta } from './_schema-rdf-import-doors.mjs';

export { spaceWith, baseOf, mcpCode, rdfMeta };

const PREFIXES = [
  '@prefix sh: <http://www.w3.org/ns/shacl#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix ex: <http://shapes.example/> .',
  '',
].join('\n');

/** An ontology header, a class and its shape, whose one property is a blank-node property shape (`sh:property [ ... ]`). */
export const SCHEMA_PART = [
  'ex:onto a owl:Ontology .',
  'ex:Person a owl:Class .',
  'ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ; sh:property [ sh:path ex:age ; sh:datatype xsd:decimal ] .',
  '',
].join('\n');

/** A literal no answer may repeat. */
export const SECRET = 'SECRET-VALUE-q955';

/** Two people of the class; `bad`: Alice's age is a language-tagged string, which the built schema (a number) refuses. */
export function dataPart({ bad = false } = {}) {
  return [
    `<http://people.example/alice> a ex:Person ; rdfs:label "Alice" ; ex:age ${bad ? `"${SECRET}"@en` : '"41"^^xsd:decimal'} .`,
    '<http://people.example/bob> a ex:Person ; rdfs:label "Bob" .',
    '',
  ].join('\n');
}

/** The schema and the data in one Turtle file. */
export const fileOf = (opts = {}) => PREFIXES + SCHEMA_PART + dataPart(opts);
/** The data alone, in Turtle. */
export const dataFile = (opts = {}) => PREFIXES + dataPart(opts);
/** The schema alone, in Turtle. */
export const schemaFile = () => PREFIXES + SCHEMA_PART;

/** The type the file builds, as the schema door stores it. */
export const BUILT_PERSON = { iri: 'http://shapes.example/Person', propertySchemas: { age: { iri: 'http://shapes.example/age', type: 'number' } } };

/** Open the doors over `spaces` (`[{ id, meta }]`). */
export async function openRdfImportSchemaDoors({ suite, spaces }) {
  const d = await openSchemaRdfImportDoors({ suite, spaces });

  /** One import through REST, answered as `{ door, status, code, body, text }`. */
  async function importRestOne(key, space, text, params = {}, { format = 'turtle' } = {}) {
    const r = await d.importRest(key, space, text, { format, params });
    return { door: 'rest', status: r.status, code: r.body?.code ?? null, body: r.body, text: r.text };
  }

  /** One import through MCP, answered as REST's shape: `status` 200 for a result, else the refusal's status where the tool carries it. */
  async function importMcpOne(key, space, text, params = {}, { format = 'turtle' } = {}) {
    const a = await d.importMcp(key, { space, document: text, format, ...params });
    const code = a.isError ? mcpCode(a) : null;
    return { door: 'mcp', status: a.isError ? (a.structured?.status ?? null) : 200, isError: a.isError, code, body: a.structured, text: a.text };
  }

  /** The same import through both doors, REST into the first space and MCP into the second: `{ rest, mcp }`. */
  async function importBoth(key, spaces_, text, params = {}, opts = {}) {
    const [restSpace, mcpSpace] = Array.isArray(spaces_) ? spaces_ : [spaces_, spaces_];
    return { rest: await importRestOne(key, restSpace, text, params, opts), mcp: await importMcpOne(key, mcpSpace, text, params, opts) };
  }

  const versionOf = (space) => d.heldMeta(space).version ?? 0;

  return { ...d, importRestOne, importMcpOne, importBoth, versionOf };
}

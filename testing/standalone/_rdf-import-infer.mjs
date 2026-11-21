/**
 * The files and calls the tests of an RDF import that infers its schema from its data drive (bundle-270, Q-755).
 *
 * ## The contract it encodes, written before the change
 *
 * - `from` takes `data` beside `declared` and `shacl` on `POST /api/brain/spaces/:spaceId/import/rdf` and MCP `import_rdf`; three parameters
 *   need `data` in `from`: `inferFunctional` (boolean), `inferMinSupport` (integer, at least 1, default 2) and `inferMinConfidence` (0 to 1,
 *   default 0). Without `data` each is refused 400 `rdf_import_bad_param`.
 * - The report's schema step (`report.schema`) carries `changes` (each with `source`: `declared`, `shacl` or `data`) and `inferred`:
 *   `{ types, properties, edges, mixed, multiValued, renamed, openEndpoints, notInferred, multiTyped, counts }`. Every entry of `types`,
 *   `properties` and `edges` carries `support` (subjects) and `confidence` (a share); `notInferred` entries carry `iri`, `why` and the numbers a
 *   threshold pruned them by.
 * - A statement of a predicate the inference names and does not infer is left out of the data, counted under `notTaken['not-inferred']`.
 * - With `schema` set, a declaring group of a kind `from` does not ask for is not a record either, counted under `notTaken['schema-not-asked']`.
 */
export const P = [
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix sh: <http://www.w3.org/ns/shacl#> .',
  '@prefix schema: <http://schema.org/> .',
  '@prefix ythril: <https://w3id.org/ythril/ns#> .',
  '@prefix ex: <http://data.example/> .',
  '@prefix p: <http://people.example/> .',
  '',
].join('\n');

export const EX = 'http://data.example/';
export const PEOPLE = 'http://people.example/';

/** A Turtle file of the prefixes and `lines`. */
export const ttl = (...lines) => P + lines.flat().join('\n') + '\n';

/** `n` people of `cls` (`p:<prefix>0` ...), each with a label and the statements `extra(i)` gives. */
export function people(n, { prefix = 'person', cls = 'ex:Person', extra = () => '' } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const more = extra(i);
    out.push(`p:${prefix}${i} a ${cls} ; rdfs:label "${prefix} ${i}"${more ? ` ; ${more}` : ''} .`);
  }
  return out;
}

/** The ticket's file: two people with an age and an edge each way. */
export const TICKET_FILE = ttl(
  'p:alice a ex:Person ; rdfs:label "Alice" ; ex:age "41"^^xsd:decimal ; ex:knows p:bob .',
  'p:bob a ex:Person ; rdfs:label "Bob" ; ex:age "37"^^xsd:decimal ; ex:knows p:alice .',
);

/** The schema the ticket's file infers, as it is stored. */
export const TICKET_TYPES = {
  entity: { Person: { iri: `${EX}Person`, propertySchemas: { age: { iri: `${EX}age`, type: 'number' } } } },
  edge: { knows: { iri: `${EX}knows`, endpoints: { from: ['Person'], to: ['Person'] } } },
};

/** An import's schema step as the report carries it, or a failing message naming what is missing. */
export function stepOf(r) {
  return r.body?.report?.schema ?? r.body?.schema ?? null;
}

/** The inferred block of an answer (`{}` when there is none, so a test's own assertion names what is missing). */
export const inferredOf = (r) => stepOf(r)?.inferred ?? {};

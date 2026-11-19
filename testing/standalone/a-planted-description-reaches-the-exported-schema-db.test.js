/**
 * Every description a space's schema states reaches the exported schema, through every door (Q-751, design r4 §6 [O3], §8).
 *
 * ## What it holds
 *
 * A space with an own-vocabulary type, a type mapped to `schema:Person` and a property mapped to `schema:email`, each with a distinctive
 * description, and a distinctive purpose. Through REST `schema-rdf` in Turtle, REST in JSON-LD and MCP `space_schema_rdf`, the parsed graph
 * holds each description as `sh:description` on its shape; the own term also carries `rdfs:comment`; the purpose is the ontology's
 * `rdfs:comment`; every one is a plain literal (`xsd:string`, no language tag); and the outside terms are the subject of no statement.
 *
 * Run: node --test testing/standalone/a-planted-description-reaches-the-exported-schema-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfdesc';
const BASE = baseOf(SPACE);
const SH = 'http://www.w3.org/ns/shacl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const META = rdfMeta(SPACE, {
  purpose: 'PURPOSE-of-the-space-4711',
  typeSchemas: { entity: {
    Pet: { description: 'DESC-own-type-pet', propertySchemas: { nick: { type: 'string', description: 'DESC-own-prop-nick' } } },
    Human: { iri: 'http://schema.org/Person', description: 'DESC-outside-type-human',
      propertySchemas: { mail: { type: 'string', iri: 'http://schema.org/email', description: 'DESC-outside-prop-mail' } } },
  } },
});

describe('a planted description reaches the exported schema', { skip }, () => {
  let d, admin;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_schema_desc', spaces: [{ id: SPACE, meta: META }] });
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  const graphs = async () => {
    const turtle = await d.schemaRest(admin.key, SPACE, { format: 'turtle' });
    assert.equal(turtle.status, 200, turtle.text.slice(0, 300));
    const json = await d.schemaRest(admin.key, SPACE, {}, { Accept: 'application/ld+json' });
    assert.equal(json.status, 200, json.text.slice(0, 300));
    const mcp = await d.schemaMcp(admin.key, { space: SPACE });
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    return {
      'REST Turtle': await parseRdf('turtle', turtle.text),
      'REST JSON-LD': await parseRdf('jsonld', json.text),
      'MCP space_schema_rdf': await parseRdf(mcp.structured.format, mcp.document),
    };
  };

  it('each description is sh:description on its shape, a plain literal, through every door', async () => {
    for (const [door, quads] of Object.entries(await graphs())) {
      const literalOn = (subject, predicate, value) => quads.find(q => q.subject.value === subject && q.predicate.value === predicate && q.object.value === value);
      for (const [shape, text] of [
        [`${BASE}schema/shape/entity/Pet`, 'DESC-own-type-pet'],
        [`${BASE}schema/shape/entity/Pet#nick`, 'DESC-own-prop-nick'],
        [`${BASE}schema/shape/entity/Human`, 'DESC-outside-type-human'],
        [`${BASE}schema/shape/entity/Human#mail`, 'DESC-outside-prop-mail'],
      ]) {
        const q = literalOn(shape, `${SH}description`, text);
        assert.ok(q, `${door}: ${text} on ${shape}`);
        assert.equal(q.object.datatype.value, XSD_STRING, `${door}: a plain literal`);
        assert.equal(q.object.language, '', `${door}: no language tag`);
      }
      assert.ok(literalOn(`${BASE}vocab/entity/Pet`, `${RDFS}comment`, 'DESC-own-type-pet'), `${door}: the own term has rdfs:comment`);
      assert.ok(literalOn(`${BASE}schema`, `${RDFS}comment`, 'PURPOSE-of-the-space-4711'), `${door}: the purpose on the ontology`);
      for (const outside of ['http://schema.org/Person', 'http://schema.org/email']) {
        assert.ok(!quads.some(q => q.subject.value === outside), `${door}: nothing is stated about ${outside}`);
      }
    }
  });
});

/**
 * A space whose records the server accepted conforms to the shapes its own schema export writes, and a record that breaks a rule does not
 * (Q-751 faithfulness, design r4 §6, §8 [S7]): the records export (REST, each format) validated with the schema export (REST) by an
 * independent SHACL validator (`rdf-validate-shacl`, offline), found by the address the description graph names (`sh:shapesGraph`).
 *
 * Run: node --test testing/standalone/a-conforming-space-conforms-to-its-own-shapes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import datasetFactory from '@rdfjs/dataset';
import SHACLValidator from 'rdf-validate-shacl';
import { DataFactory } from 'n3';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf, reportGraphs } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfconform';
const BIG = 5_000_000;
const META = rdfMeta(SPACE, { typeSchemas: {
  entity: { Person: { propertySchemas: { name2: { type: 'string', required: true }, age: { type: 'number', minimum: 0, maximum: 150 } } } },
  edge: { knows: {} },
} });

describe('a conforming space conforms to its own shapes', { skip }, () => {
  let d, admin, vocab;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_conform', spaces: [{ id: SPACE, meta: META }] });
    await d.seed(SPACE, 'entity', [
      { _id: 'p1', name: 'Ada', type: 'Person', properties: { name2: 'Ada L.', age: 36 } },
      { _id: 'p2', name: 'Bob', type: 'Person', properties: { name2: 'Bob', age: 150 } },
    ]);
    await d.seed(SPACE, 'edge', [{ _id: 'k1', from: 'p1', to: 'p2', label: 'knows' }]);
    admin = await d.mint('admin', {}, { admin: true });
    vocab = await import('../../server/dist/rdf/ythril-vocabulary.js');
  });
  after(async () => { await d?.close(); });

  const shapes = async () => {
    const s = await d.schemaRest(admin.key, SPACE, { format: 'turtle' });
    assert.equal(s.status, 200, s.text.slice(0, 300));
    return datasetFactory.dataset(await parseRdf('turtle', s.text));
  };
  const validate = async (format, edgeDetails) => {
    const r = await d.exportRest(admin.key, SPACE, { format, edgeDetails, maxChars: BIG });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const quads = await parseRdf(format, r.text);
    const reports = reportGraphs(quads, vocab.YTHRIL_NS);
    // The member graphs read as one data graph: the shapes target classes, whichever graph a record sits in.
    const data = datasetFactory.dataset(quads.filter(q => !reports.has(q.graph.value)).map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const validator = new SHACLValidator(await shapes());
    return validator.validate(data);
  };

  it('the records the server accepted conform, in every format the shapes can read', async () => {
    for (const [format, edgeDetails] of [['turtle', 'reification'], ['trig', 'reification'], ['nquads', 'reification'], ['jsonld', 'reification']]) {
      const report = await validate(format, edgeDetails);
      assert.equal(report.conforms, true, `${format}: ${JSON.stringify(report.results.map(x => [x.focusNode?.value, x.path?.value, x.message?.map(m => m.value)]))}`);
    }
  });

  it('the description graph names the shapes the schema export answers at its version', async () => {
    const r = await d.exportRest(admin.key, SPACE, { format: 'trig', maxChars: BIG });
    const quads = await parseRdf('trig', r.text);
    const named = quads.find(q => q.predicate.value === 'http://www.w3.org/ns/shacl#shapesGraph')?.object.value;
    const mcp = await d.schemaMcp(admin.key, { space: SPACE });
    assert.equal(named, mcp.structured.version, 'the shapes graph named is the schema export\'s version address');
    assert.ok(named.startsWith(`${baseOf(SPACE)}schema/`));
  });

  it('a record that breaks a rule does not conform', async () => {
    await d.seed(SPACE, 'entity', [{ _id: 'p3', name: 'Old', type: 'Person', properties: { age: 151 } }]);
    try {
      const report = await validate('turtle', 'reification');
      assert.equal(report.conforms, false);
      assert.ok(report.results.some(x => x.focusNode?.value === `${baseOf(SPACE)}entity/p3`));
    } finally {
      await d.col(d.spaceCollection(SPACE, 'entities')).deleteOne({ _id: 'p3' });
    }
  });
});

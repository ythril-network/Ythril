/**
 * What an RDF export says about itself reads alike in every format, and the tools refuse what they do not take (bundle-269 drive,
 * finding 12, the items that were defects).
 *
 * ## What it holds
 *
 * - One page has one report address in TriG, N-Quads and JSON-LD: the address is derived from the scope, the schema versions and the page's
 *   place in the walk, never from the bytes (the drive: a hash of the page, so it differed per format).
 * - A page with more after it says `ythril:complete true` (the document is whole) and states `ythril:nextAfter` (the drive: `complete
 *   false`, which a consumer reads as a broken file).
 * - Every format answers the same `Vary` (the drive: `Accept-Encoding` for Turtle and JSON-LD only, the compression layer's types).
 * - `export_rdf` and `space_schema_rdf` refuse an argument they do not take, as every tool does (the drive: `foo` went through silently),
 *   while a wrong value of one they take still gets the act's code.
 *
 * Run: node --test testing/standalone/an-rdf-export-reads-alike-in-every-format-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf, reportGraphs } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfalike';
const YT = 'https://w3id.org/ythril/ns#';

describe('an RDF export reads alike in every format', { skip }, () => {
  let d, admin;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_alike', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 5 }, (_, i) => ({ _id: `e${i}`, name: `Alike ${i}` })));
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  it('one page has one report address in every format that carries a report, and says complete true with nextAfter', async () => {
    const reports = [];
    for (const format of ['trig', 'nquads', 'jsonld']) {
      const r = await d.exportRest(admin.key, SPACE, { format, limit: 2 });
      assert.equal(r.status, 200, r.text.slice(0, 200));
      const quads = await parseRdf(format, r.text);
      const graph = [...reportGraphs(quads, YT)][0];
      assert.ok(graph, `${format}: a report node`);
      reports.push(graph);
      const value = (p) => quads.find(q => q.graph.value === graph && q.predicate.value === `${YT}${p}`)?.object.value;
      assert.equal(value('complete'), 'true', `${format}: a page with more after it is whole as a page`);
      assert.ok(value('nextAfter'), `${format}: and says there is more`);
    }
    assert.equal(new Set(reports).size, 1, `one address: ${reports.join(' ')}`);
  });

  it('every format answers the same Vary, the schema export too', async () => {
    const vary = [];
    for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
      const r = await d.exportRest(admin.key, SPACE, { format }, { 'Accept-Encoding': 'gzip' });
      vary.push(String(r.headers['vary']).split(/,\s*/).sort().join(', '));
    }
    vary.push(String((await d.schemaRest(admin.key, SPACE, {}, { 'Accept-Encoding': 'gzip' })).headers['vary']).split(/,\s*/).sort().join(', '));
    assert.equal(new Set(vary).size, 1, vary.join(' | '));
    assert.equal(vary[0], 'Accept, Accept-Encoding');
  });

  it('the two tools refuse an argument they do not take, and still answer a wrong value with the act\'s code', async () => {
    const unknown = await d.exportMcp(admin.key, { space: SPACE, foo: 1 });
    assert.equal(unknown.isError, true, 'export_rdf with foo');
    assert.match(unknown.text, /foo/);
    const schemaUnknown = await d.schemaMcp(admin.key, { space: SPACE, foo: 1 });
    assert.equal(schemaUnknown.isError, true, 'space_schema_rdf with foo');
    assert.match(schemaUnknown.text, /foo/);
    const badLimit = await d.exportMcp(admin.key, { space: SPACE, limit: 0 });
    assert.equal(badLimit.isError, true);
    assert.match(badLimit.text, /rdf_bad_limit/);
    const badFormat = await d.schemaMcp(admin.key, { space: SPACE, format: 'nquads' });
    assert.equal(badFormat.isError, true);
    assert.match(badFormat.text, /rdf_bad_format/);
  });
});

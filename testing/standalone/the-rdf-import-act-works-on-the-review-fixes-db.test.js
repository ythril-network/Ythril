/**
 * The RDF import's act passes the planners what the review fixes made them need (bundle-270 slice S6, findings H1 to H6 of the round after the
 * rebase onto those fixes; plan amendments A1, A2, A4).
 *
 * ## What it holds, one case per finding, each driving the act through the real doors
 *
 * - H2: in a warn space a record the dry plan refuses is not present for the records planned before it (a fact that links it) or after it (an
 *   edge to it): every one of them is refused and named in the report, and nothing lands.
 * - H3: a file whose subjects pass the record bound but whose bare edges (each an index record) do not is answered 413 by the door, naming the
 *   bound, before any act is registered: no report is kept, no importId is answered.
 * - H5: a stored record whose link rows are over the bound cannot be converged onto: the import ends refused with its reason in the report,
 *   no act is left owed, and the space takes writes again. Both doors answer alike.
 * - H1: a stored record the file names only inside the triple term of an edge's reifier is a known end, however the file's groups fall into
 *   windows: the edge lands.
 * - H4: a converge of a chrono whose type the space does not allow is refused (the type list is asked of every item the act plans).
 * - H6: a JSON-LD document over the reader's unparsed bound whose top level is `@graph` is refused on both doors with its code.
 *
 * Run: node --test testing/standalone/the-rdf-import-act-works-on-the-review-fixes-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const H1 = 'rdfimph1';
const H2 = 'rdfimph2';
const H3 = 'rdfimph3';
const H4 = 'rdfimph4';
const H5 = 'rdfimph5';
const H6 = 'rdfimph6';
const SPACES = [H1, H2, H3, H4, H5, H6];

const RDFS_LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DECIMAL = '<http://www.w3.org/2001/XMLSchema#decimal>';
const YTHRIL = 'https://w3id.org/ythril/ns#';
const SCHEMA_TEXT = '<http://schema.org/text>';
const REFERENCES = '<http://purl.org/dc/terms/references>';
const PERSON = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FACT = '33333333-3333-4333-8333-333333333333';
const CHRONO = '44444444-4444-4444-8444-444444444444';

/** The people of these tests are `person` entities and the edge label is `knows`; `strictLinkage` so an edge to nothing is refused. */
const meta = (id) => ({ ...personMeta(id, 'warn'), strictLinkage: true });

const refusedKinds = (report) => (report?.reasons ?? []).filter(x => x.outcome === 'refused' && x.kind).map(x => x.kind);

describe('the RDF import act works on top of the review fixes (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, act, runner;
  const reportsDir = () => path.join(d.loader.getDataRoot(), 'rdf-import-reports');
  const reportCount = () => { try { return fs.readdirSync(reportsDir()).length; } catch { return 0; } };
  const takesWrites = async (space) => {
    const save = await d.rest(writer.key, 'POST', `/api/brain/spaces/${space}/entities`, { name: `After ${space}`, type: 'person' });
    assert.ok(save.status < 300, `the space takes writes again: ${save.status} ${save.text?.slice(0, 200)}`);
  };

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_fixes', spaces: SPACES.map(id => ({ id, meta: meta(id) })) });
    writer = await d.mint('rdf-import-fixes-writer', Object.fromEntries(SPACES.map(s => [s, d.row({ knowledge: 'write', schema: 'admin' })])));
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  it('H2: a record the dry plan refuses is absent for the records planned before it and after it, in a warn space', async () => {
    const v = `${baseOf(H2)}vocab/`;
    // `nameless` states no label, so its entity has no name: refused by the record checks in every mode. `note` (a fact, planned before the
    // entities) links it and `alice` has an edge to it (an edge, planned after).
    const file = [
      `<http://people.example/nameless> a <${v}entity/person> ; <${v}entity/person#age> "5"^^${DECIMAL} .`,
      `<http://people.example/alice> a <${v}entity/person> ; ${RDFS_LABEL} "Alice" .`,
      `<http://people.example/alice> <${v}edge/knows> <http://people.example/nameless> .`,
      `<http://people.example/note> a <${YTHRIL}Fact> ; ${SCHEMA_TEXT} "a note" ; ${REFERENCES} <http://people.example/nameless> .`,
      '',
    ].join('\n');
    const r = await d.importRest(writer.key, H2, file);
    assert.equal(r.status, 409, r.text.slice(0, 500));
    assert.equal(r.body?.code, 'rdf_import_refused');
    const kinds = refusedKinds(r.body?.report);
    assert.ok(kinds.includes('entity'), `the nameless entity is refused: ${kinds}`);
    assert.ok(kinds.includes('edge'), `the edge to the refused record is refused too (it was judged with the record present): ${kinds}`);
    assert.ok(kinds.includes('fact'), `the fact planned before the refused record is refused too: ${kinds}`);
    assert.deepEqual(await d.records(H2, 'entities'), [], 'nothing landed');
    assert.deepEqual(await d.records(H2, 'edges'), []);
    assert.deepEqual(await d.records(H2, 'facts'), []);
    assert.deepEqual(d.actsOf(H2), [], 'the act ended');
    await takesWrites(H2);
    const mcp = await d.importMcp(writer.key, { space: H2, document: file, format: 'turtle' });
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.deepEqual(refusedKinds(mcp.structured?.report).sort(), kinds.sort(), 'the tool answers the same refusals');
  });

  it('H3: records past the index bound through bare edges are a 413 at the door, before an act is registered', async () => {
    // Two subjects pass the door's subject bound; the bare edge is the third record of an index bound of two.
    act.setRdfImportKnobsForTest({ maxRecords: 2 });
    const before = reportCount();
    try {
      const r = await d.importRest(writer.key, H3, goodTurtle(H3));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body?.bound, 'RDF_IMPORT_MAX_RECORDS');
      assert.equal(r.body?.importId, undefined, `no import was registered, so none is named: ${r.text.slice(0, 300)}`);
      assert.equal(reportCount(), before, 'no report was kept: the answer came from the door, with no act behind it');
      const m = await d.importMcp(writer.key, { space: H3, document: goodTurtle(H3), format: 'turtle' });
      assert.equal(m.isError, true, m.text.slice(0, 200));
      assert.match(m.text, /RDF_IMPORT_MAX_RECORDS/);
      assert.equal(reportCount(), before);
    } finally { act.setRdfImportKnobsForTest(null); }
    assert.deepEqual(d.actsOf(H3), []);
    assert.deepEqual(await d.records(H3, 'entities'), []);
    await takesWrites(H3);
  });

  it('H5: a stored record over its link bound refuses the import with its reason in the report, and leaves no act owed', async () => {
    const at = (kind, id) => `${baseOf(H5)}${kind}/${id}`;
    await d.seed(H5, 'fact', [{ _id: FACT, fact: 'a stored fact' }]);
    // More link rows than an import reads (synced rows are not held to the cap): 1000 per class in each of the four classes, and one more.
    const { MAX_LINKS_PER_KIND } = await import('../../server/dist/util/request-bounds.js');
    const { REF_KINDS } = await import('../../server/dist/config/types-knowledge.js');
    await d.seed(H5, 'link', Array.from({ length: MAX_LINKS_PER_KIND * REF_KINDS.length + 1 }, (_, k) => ({
      _id: `over-${k}`, spaceId: H5, from: FACT, fromKind: 'fact', to: `target-${k}`, toKind: 'entity',
    })));
    const file = `<${at('fact', FACT)}> a <${YTHRIL}Fact> ; ${SCHEMA_TEXT} "a stored fact, said again" .\n`;
    const r = await d.importRest(writer.key, H5, file);
    assert.equal(r.status, 409, r.text.slice(0, 500));
    assert.equal(r.body?.code, 'rdf_import_refused');
    const reasons = (r.body?.report?.reasons ?? []).filter(x => x.outcome === 'refused');
    assert.ok(reasons.some(x => x.kind === 'fact'), `the report names the refused fact: ${JSON.stringify(reasons)}`);
    assert.equal(r.body?.report?.status, 'refused');
    assert.deepEqual(d.actsOf(H5), [], 'no act is left owed');
    const status = await d.statusRest(writer.key, H5, r.body.report.importId);
    assert.equal(status.body?.status, 'refused', status.text.slice(0, 300));
    assert.equal((await d.records(H5, 'facts'))[0]?.fact, 'a stored fact', 'the stored fact is untouched');
    await takesWrites(H5);
    const mcp = await d.importMcp(writer.key, { space: H5, document: file, format: 'turtle' });
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.match(mcp.text, /rdf_import_refused/);
    assert.deepEqual(refusedKinds(mcp.structured?.report), refusedKinds(r.body.report));
    assert.deepEqual(d.actsOf(H5), []);
  });

  it('H1: a stored record the file names only inside an edge reifier\'s triple term is a known end, whatever window it falls in', async () => {
    const at = (kind, id) => `${baseOf(H1)}${kind}/${id}`;
    const v = `${baseOf(H1)}vocab/`;
    await d.seed(H1, 'entity', [{ _id: PERSON, name: 'Stored one', type: 'person' }, { _id: OTHER, name: 'Stored two', type: 'person' }]);
    // The asserted triple sits in the from record's group; the reifier's group names both ends only inside its triple term. One group per window.
    const file = [
      `<${at('entity', PERSON)}> <${v}edge/knows> <${at('entity', OTHER)}> .`,
      `<http://edges.example/e1> a <${v}edge/knows> ; <${RDF}reifies> <<( <${at('entity', PERSON)}> <${v}edge/knows> <${at('entity', OTHER)}> )>> ; <http://schema.org/keywords> "kept" .`,
      '',
    ].join('\n');
    act.setRdfImportKnobsForTest({ window: 1 });
    try {
      const r = await d.importRest(writer.key, H1, file, { params: { sourceBase: baseOf(H1) } });
      assert.equal(r.status, 200, r.text.slice(0, 600));
      assert.deepEqual((r.body?.reasons ?? []).map(x => x.code), [], 'no end is unknown');
      assert.equal(r.body?.kinds?.edge?.inserted, 1);
    } finally { act.setRdfImportKnobsForTest(null); }
    const edges = await d.records(H1, 'edges');
    assert.equal(edges.length, 1, 'the edge landed');
    assert.deepEqual([edges[0].from, edges[0].to, edges[0].label], [PERSON, OTHER, 'knows']);
    assert.deepEqual(edges[0].tags, ['kept'], 'with the details its reifier states');
  });

  it('H4: a converge onto a chrono whose type the space does not allow is refused', async () => {
    await d.seed(H4, 'chrono', [{ _id: CHRONO, title: 'Odd one', type: 'zzz-not-allowed', startsAt: '2026-01-01T00:00:00Z', status: 'upcoming' }]);
    const exported = await d.exportRest(writer.key, H4, { format: 'trig' });
    assert.equal(exported.status, 200, exported.text.slice(0, 300));
    const r = await d.importRest(writer.key, H4, exported.text, { format: 'trig' });
    assert.equal(r.status, 409, `the stored type is not one the space allows: ${r.text.slice(0, 500)}`);
    assert.ok(refusedKinds(r.body?.report).includes('chrono'), JSON.stringify(r.body?.report?.reasons));
    assert.equal((await d.records(H4, 'chrono'))[0]?.type, 'zzz-not-allowed', 'the stored chrono is untouched');
    assert.deepEqual(d.actsOf(H4), []);
    await takesWrites(H4);
  });

  it('H6: a large JSON-LD document whose top level is @graph is refused with its code on both doors', async () => {
    const graph = Array.from({ length: 30_000 }, (_, i) => ({ '@id': `http://graph.example/s${i}`, 'http://graph.example/p': `value number ${i} of the graph` }));
    // A root of only an array under @graph is the export's shape and is read as a stream (the JSON-LD round); a root with a property of its own is read whole.
    const text = JSON.stringify({ 'http://graph.example/about': 'a root with a property of its own', '@graph': graph });
    assert.ok(text.length > 2_097_152, 'the document is over the reader\'s unparsed bound');
    const r = await d.importRest(writer.key, H6, text, { format: 'jsonld' });
    assert.equal(r.body?.code, 'rdf_jsonld_not_streamable', `${r.status} ${r.text.slice(0, 400)}`);
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    const m = await d.importMcp(writer.key, { space: H6, document: text, format: 'jsonld' });
    assert.equal(m.isError, true, m.text.slice(0, 300));
    assert.match(m.text, /rdf_jsonld_not_streamable/);
    assert.deepEqual(d.actsOf(H6), []);
    assert.deepEqual(await d.records(H6, 'entities'), []);
  });
});

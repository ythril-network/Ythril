/**
 * A personal view exports the members its caller reads, one named graph each, and nothing of the rest (Q-750, design r4 §5.4 [S11][N11];
 * owner 2026-11-19: several spaces at once are exported through a personal view; parent 2026-11-19: an export never reveals what the
 * caller could not read through the product's other doors).
 *
 * ## What it holds
 *
 * - A view over two readable members: TriG by default, one graph per member, `Ythril-View-Members` naming both and exposed to browsers;
 *   `format=turtle` is 406 `rdf_format_not_acceptable`. The description graph says the export has each member graph as a part.
 * - A one-member view answers the member's own export (the same body; only the attachment's name differs).
 * - **A member the caller may not read leaves no trace**: a view whose second member the caller lost the right to read answers the same
 *   bytes as a view holding only the readable member (body, report node, closing comment, trailers, `Ythril-View-Members`), on both doors,
 *   and the audit row names only the readable member. This is how `recall` and `filter` over a view already answer: the guard narrows the
 *   members once (`viewReadMembers`) and `viewMembers` lists only those read.
 * - A member with RDF off that the caller does read is left out and named (`membersWithoutRdf`; on REST `Ythril-View-Members-Without-Rdf`
 *   and the document's ending, bundle-269 drive finding 11); a view none of whose read members has RDF on is 409 `rdf_not_enabled`.
 * - A view with no member the caller reads answers an empty document whose ending (and report node, `rdfs:comment`) says why.
 * - **File triples need the files rung**: a caller without it gets the export without file triples and is told so
 *   (`Ythril-File-Triples: withheld`, `fileTriplesWithheld: true`), and the note says nothing of how many or which.
 *
 * Run: node --test testing/standalone/an-rdf-export-reads-a-view-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf, reportGraphs } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const A = 'rdfviewa';
const B = 'rdfviewb';
const OFF = 'rdfviewoff';
const BIG = 5_000_000;

describe('an RDF export reads a view', { skip }, () => {
  let d, vocab;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_view', spaces: [
      { id: A, meta: rdfMeta(A) }, { id: B, meta: rdfMeta(B) }, { id: OFF, meta: { suppressEmbeddings: true } },
    ] });
    await d.seed(A, 'entity', [{ _id: 'a1', name: 'In A' }]);
    await d.seed(A, 'file', [{ _id: 'notes.txt', path: 'notes.txt', sizeBytes: 3, description: 'a file of A' }]);
    await d.seed(B, 'entity', [{ _id: 'b1', name: 'Secret in B' }]);
    await d.seed(OFF, 'entity', [{ _id: 'o1', name: 'In a space with RDF off' }]);
    vocab = await import('../../server/dist/rdf/ythril-vocabulary.js');
  });
  after(async () => { await d?.close(); });

  const reads = (...spaces) => Object.fromEntries(spaces.map(s => [s, d.row({ knowledge: 'read', files: 'read' })]));
  const view = async (key, name, members) => {
    const r = await d.rest(key, 'POST', '/api/views', { name, members });
    assert.ok(r.status < 300, r.text.slice(0, 300));
    return `@${name}`;
  };
  const withoutName = (text, ...names) => names.reduce((t, n) => t.replaceAll(n, '<VIEW>'), text);

  it('two readable members: TriG, a graph each, the header naming both', async () => {
    const t = await d.mint('both', reads(A, B));
    const id = await view(t.key, 'ab', [A, B]);
    const r = await d.exportRest(t.key, id, { maxChars: BIG });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.match(String(r.headers['content-type']), /^application\/trig/);
    assert.equal(r.headers['ythril-view-members'], `${A}, ${B}`);
    assert.match(String(r.headers['access-control-expose-headers']), /Ythril-View-Members/);
    const quads = await parseRdf('trig', r.text);
    assert.ok(quads.some(q => q.graph.value === baseOf(A) && q.subject.value === `${baseOf(A)}entity/a1`));
    assert.ok(quads.some(q => q.graph.value === baseOf(B) && q.subject.value === `${baseOf(B)}entity/b1`));
    const graph = [...reportGraphs(quads, vocab.YTHRIL_NS)][0];
    const parts = quads.filter(q => q.graph.value === graph && q.predicate.value === 'http://purl.org/dc/terms/hasPart').map(q => q.object.value).sort();
    assert.deepEqual(parts, [baseOf(A), baseOf(B)]);
    const turtle = await d.exportRest(t.key, id, { format: 'turtle' });
    assert.equal(turtle.status, 406);
    assert.equal(turtle.body?.code, 'rdf_format_not_acceptable');
    const mcp = await d.exportMcp(t.key, { space: id, maxChars: BIG });
    assert.equal(mcp.isError, false, mcp.text.slice(0, 300));
    assert.deepEqual(mcp.structured.members, [A, B]);
    assert.equal(mcp.structured.format, 'trig');
  });

  it('a one-member view answers the member\'s own export', async () => {
    const t = await d.mint('one', reads(A));
    const id = await view(t.key, 'justa', [A]);
    const v = await d.exportRest(t.key, id, { maxChars: BIG });
    const s = await d.exportRest(t.key, A, { maxChars: BIG });
    assert.equal(v.status, 200, v.text.slice(0, 300));
    assert.equal(v.headers['content-type'], s.headers['content-type']);
    assert.equal(v.text, s.text, 'the same body');
  });

  it('a member the caller may not read leaves no trace: the same bytes as a view of the readable member alone', async () => {
    const t = await d.mint('lost', reads(A, B));
    const wide = await view(t.key, 'wide', [A, B]);
    const narrow = await view(t.key, 'narrow', [A]);
    await d.setRights(t.id, r => { delete r.perSpace[B]; });
    const started = new Date().toISOString();
    for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
      const w = await d.exportRest(t.key, wide, { format, maxChars: BIG });
      const n = await d.exportRest(t.key, narrow, { format, maxChars: BIG });
      assert.equal(w.status, 200, `${format}: ${w.text.slice(0, 300)}`);
      assert.equal(withoutName(w.text, wide), withoutName(n.text, narrow), `${format}: the body is the same`);
      assert.ok(!w.text.includes(B) && !w.text.includes('Secret'), `${format}: no word of the unreadable member`);
      assert.equal(w.headers['ythril-view-members'], A);
      assert.equal(w.headers['ythril-view-members'], n.headers['ythril-view-members']);
      assert.deepEqual(w.trailers, n.trailers);
      assert.equal(w.headers['link'], n.headers['link']);
    }
    const mw = await d.exportMcp(t.key, { space: wide, maxChars: BIG });
    const mn = await d.exportMcp(t.key, { space: narrow, maxChars: BIG });
    assert.equal(mw.document, mn.document);
    assert.equal(withoutName(JSON.stringify(mw.structured), wide), withoutName(JSON.stringify(mn.structured), narrow));
    assert.ok(!JSON.stringify(mw.structured).includes(B));
    // A view's row names no space (a view is not one, as on every view read) and carries the members exported: the rows of this case's
    // exports are those written since it began.
    const rows = await d.col('audit_log').find({ operation: 'rdf.export', timestamp: { $gte: started } }).toArray();
    assert.ok(rows.length >= 10, `the exports are audited: ${rows.length}`);
    assert.ok(rows.every(row => !JSON.stringify(row).includes(B)), 'the audit row names only what the caller read');
  });

  it('a read member with RDF off is left out and named; a view of only such members is 409 rdf_not_enabled', async () => {
    const t = await d.mint('withoff', reads(A, OFF));
    const mixed = await view(t.key, 'mixed', [A, OFF]);
    const r = await d.exportMcp(t.key, { space: mixed, maxChars: BIG });
    assert.equal(r.isError, false, r.text.slice(0, 300));
    assert.deepEqual(r.structured.members, [A]);
    assert.deepEqual(r.structured.membersWithoutRdf, [OFF]);
    // REST says it too (bundle-269 drive, finding 11: only MCP named them), in a header a browser may read and in the document's ending.
    for (const params of [{}, { maxChars: BIG }]) {
      const rest = await d.exportRest(t.key, mixed, params);
      assert.equal(rest.status, 200, rest.text.slice(0, 300));
      assert.equal(rest.headers['ythril-view-members-without-rdf'], OFF, JSON.stringify(rest.headers));
      assert.match(String(rest.headers['access-control-expose-headers']), /Ythril-View-Members-Without-Rdf/);
      assert.match(rest.text, new RegExp(`members left out, RDF off: ${OFF}`));
    }
    const head = await d.rest(t.key, 'HEAD', `/api/brain/spaces/${encodeURIComponent(mixed)}/export/rdf`);
    assert.equal(head.status, 200);
    const onlyOff = await view(t.key, 'onlyoff', [OFF]);
    const refused = await d.exportRest(t.key, onlyOff, {});
    assert.equal(refused.status, 409, refused.text.slice(0, 300));
    assert.equal(refused.body?.code, 'rdf_not_enabled');
    const mcp = await d.exportMcp(t.key, { space: onlyOff });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /rdf_not_enabled/);
  });

  it('a view with no member the caller reads says in its report why it is empty (the drive: 200 and an empty file)', async () => {
    const t = await d.mint('nomember', reads(A));
    const id = await view(t.key, 'gone', [A]);
    await d.setRights(t.id, r => { delete r.perSpace[A]; r.perSpace[B] = d.row({ knowledge: 'read' }); });
    for (const format of ['turtle', 'trig']) {
      const r = await d.exportRest(t.key, id, { format });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.match(r.text, /no member of this view is one you may read/, `${format}: the ending says why it is empty`);
      assert.ok(!r.text.includes(A), `${format}: and names no member`);
    }
    const trig = await d.exportRest(t.key, id, { format: 'trig' });
    const quads = await parseRdf('trig', trig.text);
    const report = [...reportGraphs(quads, vocab.YTHRIL_NS)][0];
    assert.ok(quads.some(q => q.graph.value === report && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#comment'
      && /no member of this view is one you may read/.test(q.object.value)), 'the report node says it in standard terms (rdfs:comment)');
    const m = await d.exportMcp(t.key, { space: id });
    assert.equal(m.isError, false, m.text.slice(0, 300));
    assert.deepEqual(m.structured.members, []);
    assert.match(m.document, /no member of this view is one you may read/);
  });

  it('file triples need the files rung, and the note says nothing of how many or which', async () => {
    const t = await d.mint('nofiles', { [A]: d.row({ knowledge: 'read' }) });
    const r = await d.exportRest(t.key, A, { format: 'nquads', maxChars: BIG });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.text.includes('notes.txt') || !r.text.includes('schema.org/MediaObject'), 'no file triple');
    assert.doesNotMatch(r.text, /MediaObject/);
    assert.equal(r.headers['ythril-file-triples'], 'withheld');
    assert.match(String(r.headers['access-control-expose-headers']), /Ythril-File-Triples/);
    const mcp = await d.exportMcp(t.key, { space: A, maxChars: BIG });
    assert.equal(mcp.structured.fileTriplesWithheld, true);
    assert.doesNotMatch(mcp.document, /MediaObject/);
    assert.doesNotMatch(JSON.stringify(mcp.structured), /notes\.txt|files?Count/);
    const full = await d.mint('withfiles', reads(A));
    const f = await d.exportRest(full.key, A, { format: 'nquads', maxChars: BIG });
    assert.match(f.text, /MediaObject/);
    assert.equal(f.headers['ythril-file-triples'], undefined);
  });
});

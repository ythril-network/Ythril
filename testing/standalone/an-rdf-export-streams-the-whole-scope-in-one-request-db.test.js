/**
 * A plain `GET …/export/rdf` gives a standard RDF tool the whole space in one request, streamed, and a stream that cannot finish is never
 * taken for a whole file (Q-750, design r4 §5.4; the parent's correction of 2026-11-19: Jena, RDF4J, rdflib and curl follow no `Link` and
 * read no trailer, so a first page handed to them as the answer would be a silently short export).
 *
 * ## What it holds
 *
 * - With no `limit`, `after` or size ceiling, a space several store pages large comes back complete in one answer: every record once, the
 *   same records the paged walk reads, no `Link`, the report saying `complete true`, the trailer `Ythril-Export-Complete: true`.
 * - Never the whole space in memory: the stream hands out one store page per chunk (many chunks, none near the whole).
 * - A store that fails mid-stream ends the document so that the independent parser REFUSES it in Turtle, TriG and N-Quads (a last line no
 *   grammar allows), JSON-LD is left unterminated (no JSON parser accepts it), TriG and N-Quads still say `complete false` in the report,
 *   the trailer says `Ythril-Export-Complete: false`, and the audit row says `complete: false`.
 * - A store that fails before the first byte is the clean 503 `rdf_export_incomplete`, nothing of a document sent.
 * - A reader that leaves mid-stream frees its slot.
 *
 * Run: node --test testing/standalone/an-rdf-export-streams-the-whole-scope-in-one-request-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor, waitForValue } from '../_shared/wait-for.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { openRdfExportDoors, rdfMeta, baseOf, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfwhole';
/** Records: several store pages (the act reads 200 a page) of entities, and a few facts after them. */
const ENTITIES = 1_100;
const id = (i) => `w${String(i).padStart(5, '0')}`;

describe('an RDF export streams the whole scope in one request', { skip, timeout: 300_000 }, () => {
  let d, act, idKeysetPage, admin, other;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_whole', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: ENTITIES }, (_, i) => ({ _id: id(i), name: `Whole ${i}` })));
    await d.seed(SPACE, 'fact', [{ _id: 'f1', fact: 'one' }, { _id: 'f2', fact: 'two' }]);
    act = await import('../../server/dist/rdf/export-act.js');
    ({ idKeysetPage } = await import('../../server/dist/db/id-keyset-page.js'));
    admin = await d.mint('admin', {}, { admin: true });
    other = await d.mint('other', { [SPACE]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { act?.setRdfExportPageReaderForTest?.(null); act?.setRdfExportChunkObserverForTest?.(null); await d?.close(); });

  const record = new RegExp(`^${escapeRegExp(baseOf(SPACE))}(?:entity|fact)/[^/#]+$`);
  const subjects = (quads) => quads.filter(q => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && record.test(q.subject.value)).map(q => q.subject.value);

  it('the whole space in one answer: every record once, as the paged walk reads it, no Link', async () => {
    const sizes = [];
    assert.equal(typeof act.setRdfExportChunkObserverForTest, 'function', 'export-act.ts exports setRdfExportChunkObserverForTest');
    act.setRdfExportChunkObserverForTest((n) => sizes.push(n));
    let r;
    try { r = await d.exportRest(admin.key, SPACE, { format: 'nquads' }); } finally { act.setRdfExportChunkObserverForTest(null); }
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.headers['link'], undefined, 'there is no next page');
    assert.equal(r.trailers['ythril-export-complete'], 'true');
    const quads = await parseRdf('nquads', r.text);
    const whole = [...new Set(subjects(quads))];
    assert.equal(whole.length, ENTITIES + 2, 'every record of the space');
    // Each once: an entity states its one `ythril:Entity` type once; a record written twice would state it twice in N-Quads.
    const { ythrilIri } = await import('../../server/dist/rdf/ythril-vocabulary.js');
    assert.equal(quads.filter(q => q.object.value === ythrilIri('Entity')).length, ENTITIES, 'each once');
    assert.match(r.text, /ythril\/ns#complete> "true"/);
    // The paged walk reads the same records.
    const paged = [];
    let path = `/api/brain/spaces/${SPACE}/export/rdf?format=nquads&limit=300`;
    while (path) {
      const p = await d.restGet(admin.key, path);
      paged.push(...new Set(subjects(await parseRdf('nquads', p.text))));
      path = /^<([^>]*)>;\s*rel="next"$/.exec(String(p.headers['link'] ?? ''))?.[1] ?? null;
    }
    assert.deepEqual([...paged].sort(), [...whole].sort());
    // One store page per chunk: many chunks, none near the whole.
    assert.ok(sizes.length >= Math.floor(ENTITIES / 200), `the stream was handed out in ${sizes.length} chunks`);
    assert.ok(Math.max(...sizes) < r.text.length / 3, 'no chunk holds the whole export');
  });

  for (const format of ['turtle', 'trig', 'nquads', 'jsonld']) {
    it(`${format}: a store that fails mid-stream gives a file the independent parser refuses`, async () => {
      let calls = 0;
      act.setRdfExportPageReaderForTest(async (spec, after) => {
        calls++;
        if (calls >= 3) { const err = new Error('operation exceeded time limit'); err.name = 'MongoServerError'; err.code = 50; err.codeName = 'MaxTimeMSExpired'; throw err; }
        return idKeysetPage(spec, after);
      });
      let r;
      try { r = await d.exportRest(admin.key, SPACE, { format }); } finally { act.setRdfExportPageReaderForTest(null); }
      assert.equal(r.status, 200, 'the status line was sent before the store failed');
      assert.equal(r.trailers['ythril-export-complete'], 'false');
      await assert.rejects(parseRdf(format, r.text), `${format}: a short file must not parse as whole`);
      if (format === 'trig' || format === 'nquads') assert.match(r.text, /ythril\/ns#complete>? "false"|ythril:complete "false"/, 'the report says complete false');
    });
  }

  it('the audit row of a stream that could not finish says complete: false', async () => {
    await untilAuditWritesLanded();
    await d.col('audit_log').deleteMany({ operation: 'rdf.export' });
    let calls = 0;
    act.setRdfExportPageReaderForTest(async (spec, after) => {
      calls++;
      if (calls >= 3) { const err = new Error('operation exceeded time limit'); err.name = 'MongoServerError'; err.code = 50; err.codeName = 'MaxTimeMSExpired'; throw err; }
      return idKeysetPage(spec, after);
    });
    try { await d.exportRest(admin.key, SPACE, { format: 'nquads' }); } finally { act.setRdfExportPageReaderForTest(null); }
    const row = await waitForValue(async () => {
      await untilAuditWritesLanded();
      return (await d.col('audit_log').find({ operation: 'rdf.export' }).toArray())[0];
    }, 10_000, 100, () => 'no rdf.export row');
    const changes = Object.fromEntries(row.changes.map(c => [c.field, c.to]));
    assert.equal(changes.complete, false);
  });

  it('a store that fails before the first byte is the clean 503', async () => {
    act.setRdfExportPageReaderForTest(async () => { const err = new Error('operation exceeded time limit'); err.name = 'MongoServerError'; err.code = 50; err.codeName = 'MaxTimeMSExpired'; throw err; });
    let r;
    try { r = await d.exportRest(admin.key, SPACE, { format: 'turtle' }); } finally { act.setRdfExportPageReaderForTest(null); }
    assert.equal(r.status, 503, r.text.slice(0, 200));
    assert.equal(r.body?.code, 'rdf_export_incomplete');
  });

  it('a reader that leaves mid-stream frees its slot', async () => {
    await new Promise((resolve, reject) => {
      const req = http.get(`${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads`, { headers: { Authorization: `Bearer ${other.key}` } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    await waitFor(async () => (await d.exportRest(other.key, SPACE, { format: 'nquads', limit: 3 })).status === 200, 15_000, 200,
      () => 'the slot of the reader that left was not freed');
  });
});

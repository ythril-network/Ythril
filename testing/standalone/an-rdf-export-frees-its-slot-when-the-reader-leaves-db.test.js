/**
 * An RDF export holds a slot only while it is read, and a store that fails ends it cleanly (Q-750, design r4 §5.4 [B5][N13]).
 *
 * ## What it holds
 *
 * - At most two exports run on the instance and one per token: a second export by a token whose first is still being sent is 429
 *   `rdf_export_busy` with `Retry-After`, alike on MCP; a third token while two are held is 429 too.
 * - A reader that goes away frees its slot at once; a reader that stops reading is cut after the idle bound and frees its slot.
 * - Never the whole space in memory: a page is held to the byte budget (here 5 000 000 characters over about 7 MB of records), and the
 *   rest is linked.
 * - A page read the store times out is a 503 with a named code and no document: a truncated file that looks whole is never sent.
 *
 * Run: node --test testing/standalone/an-rdf-export-frees-its-slot-when-the-reader-leaves-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfslots';
const BIG = 5_000_000;
const LONG = 'x'.repeat(2_000);

describe('an RDF export frees its slot when the reader leaves', { skip }, () => {
  let d, act, t1, t2, t3;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_slots', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 3_500 }, (_, i) => ({ _id: `s${String(i).padStart(5, '0')}`, name: `Slot ${i}`, description: LONG })));
    act = await import('../../server/dist/rdf/export-act.js');
    t1 = await d.mint('t1', { [SPACE]: d.row({ knowledge: 'read' }) });
    t2 = await d.mint('t2', { [SPACE]: d.row({ knowledge: 'read' }) });
    t3 = await d.mint('t3', { [SPACE]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { act?.setRdfExportIdleMsForTest?.(null); act?.setRdfExportPageReaderForTest?.(null); await d?.close(); });

  /** Open an export and read only its head: the response stays open, unread, holding its slot. */
  const holdOpen = (key) => new Promise((resolve, reject) => {
    const req = http.get(`${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads&maxChars=${BIG}`, { headers: { Authorization: `Bearer ${key}` } }, (res) => {
      res.pause();
      resolve({ status: res.statusCode, headers: res.headers, res, req, closed: new Promise(r => res.once('close', r)) });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });

  it('one per token, two on the instance, 429 with Retry-After; a reader that leaves frees its slot', async () => {
    assert.equal(typeof act.setRdfExportIdleMsForTest, 'function', 'export-act.ts exports setRdfExportIdleMsForTest');
    act.setRdfExportIdleMsForTest(60_000);
    const first = await holdOpen(t1.key);
    assert.equal(first.status, 200);
    const again = await d.exportRest(t1.key, SPACE, { format: 'nquads' });
    assert.equal(again.status, 429, again.text.slice(0, 200));
    assert.equal(again.body?.code, 'rdf_export_busy');
    assert.ok(Number(again.headers['retry-after']) > 0);
    const mcp = await d.exportMcp(t1.key, { space: SPACE });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /rdf_export_busy/);
    const second = await holdOpen(t2.key);
    assert.equal(second.status, 200, 'another token has its own slot');
    const third = await d.exportRest(t3.key, SPACE, { format: 'nquads' });
    assert.equal(third.status, 429, 'two on the instance');
    first.req.destroy();
    second.req.destroy();
    await Promise.all([first.closed, second.closed]);
    await new Promise(r => setTimeout(r, 200));
    const after = await d.exportRest(t3.key, SPACE, { format: 'nquads', limit: 5 });
    assert.equal(after.status, 200, 'the slots were freed when their readers left');
  });

  it('a reader that stops reading is cut after the idle bound, and its slot is freed', async () => {
    act.setRdfExportIdleMsForTest(300);
    const stalled = await holdOpen(t1.key);
    assert.equal(stalled.status, 200);
    await stalled.closed;
    const next = await d.exportRest(t1.key, SPACE, { format: 'nquads', limit: 5 });
    assert.equal(next.status, 200, 'the idle reader no longer holds the token\'s slot');
    act.setRdfExportIdleMsForTest(null);
  });

  it('a page is held to the byte budget and the rest is linked', async () => {
    const r = await d.exportRest(t2.key, SPACE, { format: 'nquads', maxChars: BIG });
    assert.equal(r.status, 200);
    assert.ok(r.text.length <= BIG + 10_000, `a page is held to its budget (${r.text.length} characters)`);
    assert.match(String(r.headers['link']), /rel="next"/);
  });

  it('a page read the store times out is a 503 with a named code and no document', async () => {
    assert.equal(typeof act.setRdfExportPageReaderForTest, 'function', 'export-act.ts exports setRdfExportPageReaderForTest');
    act.setRdfExportPageReaderForTest(async () => {
      const err = new Error('operation exceeded time limit');
      err.name = 'MongoServerError';
      err.code = 50;
      err.codeName = 'MaxTimeMSExpired';
      throw err;
    });
    try {
      const r = await d.exportRest(t3.key, SPACE, { format: 'nquads' });
      assert.equal(r.status, 503, r.text.slice(0, 200));
      assert.equal(typeof r.body?.code, 'string', 'the 503 names its code');
      assert.doesNotMatch(r.text, /<https?:/, 'no part of a document');
      const m = await d.exportMcp(t3.key, { space: SPACE });
      assert.equal(m.isError, true);
    } finally {
      act.setRdfExportPageReaderForTest(null);
    }
    const ok = await d.exportRest(t3.key, SPACE, { format: 'nquads', limit: 3 });
    assert.equal(ok.status, 200, 'a failed export frees its slot');
  });
});

/**
 * An RDF export holds a slot only while it is read, and a store that fails ends it cleanly (Q-750, design r4 §5.4 [B5][N13]).
 *
 * ## What it holds
 *
 * - At most two exports run on the instance and one per token: a second export by a token whose first is still being sent is 429
 *   `rdf_export_busy` with `Retry-After`, alike on MCP; a third token while two are held is 429 too.
 * - A reader that goes away frees its slot at once; a reader that stops reading the whole stream frees its slot after the idle bound and is
 *   cut once the incomplete ending had its wait, so what it can still take ends aborted, never complete (review finding 8: the cut itself is proven; a page fits in the loopback
 *   buffers, so its write never waits there).
 * - Never the whole space in memory: a page is held to the byte budget (here 5 000 000 characters over about 14 MB of records), and the
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
import { waitFor } from '../_shared/wait-for.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfslots';
const BIG = 5_000_000;
// Long enough that a page (5 MB) and the whole export (about 14 MB) outgrow what the loopback socket buffers absorb, so a reader that stops
// reading really leaves the server's write waiting.
const LONG = 'x'.repeat(4_000);

describe('an RDF export frees its slot when the reader leaves', { skip, timeout: 180_000 }, () => {
  let d, act, idKeysetPage, t1, t2, t3;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_slots', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 3_500 }, (_, i) => ({ _id: `s${String(i).padStart(5, '0')}`, name: `Slot ${i}`, description: LONG })));
    act = await import('../../server/dist/rdf/export-act.js');
    ({ idKeysetPage } = await import('../../server/dist/db/id-keyset-page.js'));
    t1 = await d.mint('t1', { [SPACE]: d.row({ knowledge: 'read' }) });
    t2 = await d.mint('t2', { [SPACE]: d.row({ knowledge: 'read' }) });
    t3 = await d.mint('t3', { [SPACE]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { act?.setRdfExportIdleMsForTest?.(null); act?.setRdfExportPageReaderForTest?.(null); await d?.close(); });

  /** Open an export and read only its head: the response stays open, unread, holding its slot. `query` names a page, or none (the stream). */
  const holdOpen = (key, query = `&maxChars=${BIG}`) => new Promise((resolve, reject) => {
    const req = http.get(`${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads${query}`, { headers: { Authorization: `Bearer ${key}` } }, (res) => {
      res.pause();
      // Cut by the server or by us: whichever event the socket's end reaches first. An error is the cut, not a fault of the test.
      res.on('error', () => {});
      const closed = new Promise(r => { res.once('close', r); res.once('aborted', r); req.once('close', r); });
      resolve({ status: res.statusCode, headers: res.headers, res, req, closed });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });

  it('one per token, two on the instance, 429 with Retry-After; a reader that leaves frees its slot', async () => {
    assert.equal(typeof act.setRdfExportIdleMsForTest, 'function', 'export-act.ts exports setRdfExportIdleMsForTest');
    act.setRdfExportIdleMsForTest(60_000);
    // A planted reader holds every page read until released, so an export provably holds its slot while the others are asked.
    let entered = 0;
    let release;
    const gate = new Promise(r => { release = r; });
    act.setRdfExportPageReaderForTest(async (spec, after) => { entered++; await gate; return idKeysetPage(spec, after); });
    let first, second;
    try {
      const firstP = holdOpen(t1.key);
      await waitFor(() => entered >= 1, 15_000, 50, () => 'the first export never began to read');
      const again = await d.exportRest(t1.key, SPACE, { format: 'nquads' });
      assert.equal(again.status, 429, again.text.slice(0, 200));
      assert.equal(again.body?.code, 'rdf_export_busy');
      assert.ok(Number(again.headers['retry-after']) > 0);
      const mcp = await d.exportMcp(t1.key, { space: SPACE });
      assert.equal(mcp.isError, true);
      assert.match(mcp.text, /rdf_export_busy/);
      const secondP = holdOpen(t2.key);
      await waitFor(() => entered >= 2, 15_000, 50, () => 'another token was not given its own slot');
      const third = await d.exportRest(t3.key, SPACE, { format: 'nquads' });
      assert.equal(third.status, 429, 'two on the instance');
      release();
      [first, second] = await Promise.all([firstP, secondP]);
    } finally {
      release();
      act.setRdfExportPageReaderForTest(null);
    }
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    first.req.destroy();
    second.req.destroy();
    await Promise.all([first.closed, second.closed]);
    // The server sees each close on its own socket a moment later: the slot is free once it has.
    await waitFor(async () => (await d.exportRest(t3.key, SPACE, { format: 'nquads', limit: 5 })).status === 200, 15_000, 200,
      () => 'the slots of the readers that left were not freed');
  });

  // The whole stream only: a page (at most 5 000 000 characters) fits in what the loopback socket buffers absorb, so its write never waits and
  // an idle bound cannot be reached on loopback; the page path waits through the same `pacedWriter` (`export/export-reader-pace.ts`).
  for (const [path, query] of [['the whole stream', '']]) {
    it(`${path}: a reader that stops reading frees its slot after the idle bound, and is cut after the ending's wait`, async () => {
      act.setRdfExportIdleMsForTest(1_000);
      try {
        const stalled = await holdOpen(t1.key, query);
        assert.equal(stalled.status, 200);
        // The reader takes nothing; within the bound (and a margin for the answer to be built) its slot is free again.
        await waitFor(async () => (await d.exportRest(t1.key, SPACE, { format: 'nquads', limit: 5 })).status === 200, 15_000, 200,
          () => 'the idle reader still holds the token\'s slot');
        // And the connection is cut once the incomplete ending had its time (export/export-reader-pace.ts): what the reader can still take
        // then ends aborted, never complete.
        await elapse(act.rdfExportEndingWaitMs() + 2_000, 'ttl elapses: the ending\'s wait must run out before the reader takes anything');
        const ended = await new Promise((resolve) => {
          let done = false;
          const finish = (how) => { if (!done) { done = true; resolve(how); } };
          stalled.res.on('end', () => finish(stalled.res.complete ? 'complete' : 'aborted'));
          stalled.res.on('aborted', () => finish('aborted'));
          stalled.res.on('error', () => finish('aborted'));
          stalled.res.on('close', () => finish(stalled.res.complete ? 'complete' : 'aborted'));
          stalled.res.resume();
        });
        assert.equal(ended, 'aborted', 'the idle reader\'s answer was cut by the server, not finished');
      } finally {
        act.setRdfExportIdleMsForTest(null);
      }
    });
  }

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

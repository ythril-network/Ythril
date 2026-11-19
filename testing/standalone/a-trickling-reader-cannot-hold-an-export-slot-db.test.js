/**
 * A whole export whose reader is slower than the stated bound is ended, truthfully, and frees its slot; one whose reader keeps up is not
 * (bundle-269 review, finding 9; the first drive, finding 7).
 *
 * ## What the drive found
 *
 * The bound was an average since the start of the bytes `res.write` had taken. Those include what the operating system's send buffer holds
 * (about 3 MB at once in the drive), so it measured nothing of the reader for minutes, and readers at 1.5 KB/s and 5 KB/s were cut instead by
 * the idle bound (a store page of buffered text took longer than it to drain): the final chunk missing and no incomplete ending.
 *
 * ## The rule it holds
 *
 * The bound is asked only while the export waits on its reader (a write the connection did not take at once), and measures what the
 * connection accepted during those waits: over each `windowMs` of waiting, at least `minBytesPerSecond` on average. A reader below it is
 * cut with the incomplete ending (`INCOMPLETE ... too slowly`, then the line no parser accepts), which it still receives after what its
 * connection already holds; its slot is free at once. A reader above it, however long the export, is never cut. Set short here through the
 * product's own setter; the text is written a slice at a time, so little waits above the connection when the cut comes.
 *
 * Run: node --test testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdftrickle';
/** Enough text to fill every buffer between the server and a reader that stops (loopback send and receive buffers are a few MiB). */
const TOTAL = 6_000;
const BLOB = 'x'.repeat(4_000);
/** The bound in force here: a reader taking under 2 MiB a second while the export waits on it, over 300 ms of waiting, is too slow. */
const RATE = { windowMs: 300, minBytesPerSecond: 2 * 1024 * 1024 };

/** A planted store: `TOTAL` large entities, pages of the size asked; every other collection is empty. */
function bigStore(spec, afterId) {
  if (!String(spec.collection).endsWith('entities')) return Promise.resolve({ rows: [], end: true });
  const start = afterId === undefined ? 0 : Number(String(afterId).slice(1)) + 1;
  const n = Math.max(0, Math.min(spec.size, TOTAL - start));
  const rows = Array.from({ length: n }, (_, i) => ({ _id: `b${String(start + i).padStart(6, '0')}`, name: `Big ${start + i}`, description: BLOB, tags: [] }));
  return Promise.resolve({ rows, ...(n > 0 ? { last: rows[n - 1]._id } : {}), end: start + n >= TOTAL });
}

/**
 * GET the whole export and read it as `pace` says: `'paused'` reads nothing until `release()` is called, `'throttled'` takes one chunk per
 * 100 ms until released, `'fast'` reads as fast as it can. Answers the text, the trailers and whether the transfer completed.
 */
function read(url, key, pace) {
  let release;
  let started;
  const released = new Promise(r => { release = r; });
  // The status line has arrived: the export holds its slot from here (a probe of the slot before it could find it free, never taken).
  const headed = new Promise(r => { started = r; });
  const done = new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Authorization: `Bearer ${key}` } }, (res) => {
      started();
      const chunks = [];
      let free = pace === 'fast';
      void released.then(() => { free = true; res.resume(); });
      res.on('data', (c) => {
        chunks.push(c);
        if (free || pace !== 'throttled') return;
        res.pause();
        setTimeout(() => { if (!free) res.resume(); }, 100);
      });
      if (pace === 'paused') res.pause();
      const finish = (complete) => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), trailers: res.trailers, complete });
      res.on('end', () => finish(true));
      res.on('aborted', () => finish(false));
      res.on('error', () => finish(false));
    });
    req.on('error', reject);
  });
  return { release: () => release(), headed, done };
}

describe('a trickling reader cannot hold an export slot', { skip, timeout: 300_000 }, () => {
  let d, act, tok, url;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_trickle', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    act = await import('../../server/dist/rdf/export-act.js');
    tok = await d.mint('reader', { [SPACE]: d.row({ knowledge: 'read' }) });
    url = `${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads`;
    act.setRdfExportPageReaderForTest(bigStore);
    act.setRdfExportRateForTest(RATE);
    // The idle bound well past the rate's window: a cut here is the rate rule's.
    act.setRdfExportIdleMsForTest(30_000);
  });
  after(async () => {
    act?.setRdfExportPageReaderForTest?.(null);
    act?.setRdfExportRateForTest?.(null);
    act?.setRdfExportIdleMsForTest?.(null);
    await d?.close();
  });

  /** Whether this token's slot is free: a page of one record answers instead of 429. */
  const slotFree = async () => (await d.exportRest(tok.key, SPACE, { format: 'nquads', limit: 1 })).status === 200;

  for (const pace of ['paused', 'throttled']) {
    it(`a ${pace} reader below the bound is cut with the incomplete ending it still receives, and its slot is free at once`, async () => {
      const r = read(url, tok.key, pace);
      try {
        await r.headed;
        await waitFor(slotFree, 60_000, 100, () => 'the slow reader\'s slot was not freed by the rate rule');
      } finally { r.release(); }
      const got = await r.done;
      assert.equal(got.status, 200);
      assert.ok(got.complete, 'the transfer itself ends normally: the reader is told, not cut off');
      assert.match(got.text, /INCOMPLETE[^\n]*too slowly/, 'the drive: no incomplete ending, the final chunk missing');
      assert.ok(got.text.endsWith('!ythril-export-incomplete\n'), 'the last line is the one no parser accepts');
      assert.equal(got.trailers['ythril-export-complete'], 'false');
      await assert.rejects(parseRdf('nquads', got.text), 'a stream cut by the rate bound is never read as whole');
    });
  }

  it('a reader above the bound gets the whole export, however long it runs', async () => {
    const got = await read(url, tok.key, 'fast').done;
    assert.equal(got.status, 200);
    assert.equal(got.trailers['ythril-export-complete'], 'true', got.text.slice(-300));
    assert.match(got.text, new RegExp(`# ythril-export: ${TOTAL} records; complete, nothing is left`));
  });
});

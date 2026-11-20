/**
 * A whole export whose reader is under the stated bound ends, truthfully, in the incomplete ending that reader still receives, and frees its
 * slot; one whose reader keeps up with the bound is never cut; one whose reader takes nothing frees its slot and is cut (bundle-269 review,
 * finding 9; the first drive, finding 7; the second drive, finding A).
 *
 * ## What the drives found
 *
 * The first: the bound was an average of what `res.write` had taken since the start, which counts the operating system's send buffer (about
 * 3 MB at once), so it saw nothing of a slow reader. The second, after a fix whose test passed: readers at 1.5, 5 and 20 KiB/s were all cut
 * at 60 s with no ending, though 20 KiB/s is above the 16 KiB/s the guide called safe. Two causes, both on a real socket only: the bytes that
 * filled the buffers at the start still counted toward the first window (the wait on a burst of refills is a millisecond, its bytes a
 * megabyte), and the kernel wakes a full socket only once about a third of its send buffer is free, so a reader at 20 KiB/s showed no
 * progress at all for over 60 s and the idle bound (60 s, the same as the window) cut it, the ending still in the server's own buffer.
 * The test before held the idle bound at 30 s against a 300 ms window, so the second cause never showed.
 *
 * ## How the rule is tested
 *
 * Over a real loopback socket with readers throttled by their own reads (a token bucket over `res.read`), at the PRODUCTION numbers scaled
 * together: the window and the idle bound shortened by one factor and the rate raised by the same, so the bytes one window asks for, and
 * their size against the loopback buffers, are production's. Readers at a tenth of the bound, just under it, just over it and at twice it;
 * one that reads nothing for the first window (what the buffers took at the start is not what it took) and one that reads nothing at all.
 * A slow reader's last received line is the line no parser accepts, and its transfer ends whole (the ending reached it before the close).
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
/** About 25 MB of N-Quads: several windows for the reader just over the bound, and far more than the loopback buffers hold. */
const TOTAL = 6_000;
const BLOB = 'x'.repeat(4_000);
/** The window here; the production window, idle bound and rate are scaled by the factor that makes the window this. */
const WINDOW_MS = 3_000;
/** How often a throttled reader takes what its rate allows. */
const TICK_MS = 10;

/** A planted store: `TOTAL` large entities, pages of the size asked; every other collection is empty. */
function bigStore(spec, afterId) {
  if (!String(spec.collection).endsWith('entities')) return Promise.resolve({ rows: [], end: true });
  const start = afterId === undefined ? 0 : Number(String(afterId).slice(1)) + 1;
  const n = Math.max(0, Math.min(spec.size, TOTAL - start));
  const rows = Array.from({ length: n }, (_, i) => ({ _id: `b${String(start + i).padStart(6, '0')}`, name: `Big ${start + i}`, description: BLOB, tags: [] }));
  return Promise.resolve({ rows, ...(n > 0 ? { last: rows[n - 1]._id } : {}), end: start + n >= TOTAL });
}

/**
 * GET the whole export and take it at `bytesPerSecond` (a token bucket, so timer jitter does not lower the average; `Infinity` takes all
 * that arrives), after taking nothing for `holdMs`; `0` takes nothing until `release()`. Answers the text, the trailers and whether the
 * transfer ended whole.
 */
function readAt(url, key, { bytesPerSecond, holdMs = 0 }) {
  let release;
  let started;
  let fast = false;
  const released = new Promise(r => { release = r; });
  // The status line has arrived: the export holds its slot from here (a probe of the slot before it could find it free, never taken).
  const headed = new Promise(r => { started = r; });
  const done = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get(url, { headers: { Authorization: `Bearer ${key}` }, agent: false }, (res) => {
      started();
      const chunks = [];
      let got = 0;
      void released.then(() => { fast = true; });
      // Paused mode: the connection gives this reader only what `read` asks of it.
      res.on('readable', () => {});
      const tick = setInterval(() => {
        const since = Date.now() - t0 - holdMs;
        let allowed = fast ? Infinity : since <= 0 || bytesPerSecond === 0 ? 0
          : bytesPerSecond === Infinity ? Infinity : Math.floor(bytesPerSecond * since / 1_000) - got;
        while (allowed > 0 && res.readableLength > 0) {
          const c = res.read(Math.min(allowed, res.readableLength));
          if (!c) break;
          chunks.push(c);
          got += c.length;
          allowed -= c.length;
        }
        if (allowed > 0 && res.readableLength === 0) res.read(0);
      }, TICK_MS);
      let settled = false;
      const finish = (complete) => {
        if (settled) return;
        settled = true;
        clearInterval(tick);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), trailers: res.trailers, complete, ms: Date.now() - t0 });
      };
      res.on('end', () => finish(true));
      res.on('aborted', () => finish(false));
      res.on('error', () => finish(false));
      res.on('close', () => finish(res.complete));
    });
    req.on('error', reject);
  });
  return { release: () => release(), headed, done };
}

describe('a trickling reader cannot hold an export slot', { skip, timeout: 600_000 }, () => {
  let d, act, tok, url, pace, endingWaitMs;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_trickle', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    act = await import('../../server/dist/rdf/export-act.js');
    tok = await d.mint('reader', { [SPACE]: d.row({ knowledge: 'read' }) });
    url = `${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads`;
    act.setRdfExportPageReaderForTest(bigStore);
    // Production's numbers, then all three scaled by one factor: the bytes a window asks for stay production's.
    act.setRdfExportRateForTest(null);
    act.setRdfExportIdleMsForTest(null);
    const production = { ...act.rdfExportRate(), idleMs: act.rdfExportIdleMs() };
    const factor = production.windowMs / WINDOW_MS;
    pace = { windowMs: WINDOW_MS, minBytesPerSecond: production.minBytesPerSecond * factor, idleMs: production.idleMs / factor };
    act.setRdfExportRateForTest({ windowMs: pace.windowMs, minBytesPerSecond: pace.minBytesPerSecond });
    act.setRdfExportIdleMsForTest(pace.idleMs);
    // How long a reader judged too slow is given to take the ending (the build before this rule had none: the idle bound stood for it).
    endingWaitMs = act.rdfExportEndingWaitMs?.() ?? pace.idleMs;
  });
  after(async () => {
    act?.setRdfExportPageReaderForTest?.(null);
    act?.setRdfExportRateForTest?.(null);
    act?.setRdfExportIdleMsForTest?.(null);
    await d?.close();
  });

  /** Whether this token's slot is free: a page of one record answers instead of 429. */
  const slotFree = async () => (await d.exportRest(tok.key, SPACE, { format: 'nquads', limit: 1 })).status === 200;
  /** The longest a reader under the bound may hold its slot: the idle bound, or a window ending at the first full buffer after it. */
  const verdictWithin = () => pace.idleMs + 2 * pace.windowMs + 5_000;

  /** The ending a reader judged too slow receives last, with the transfer itself ended whole. */
  async function assertToldTooSlow(got) {
    assert.equal(got.status, 200);
    assert.ok(got.complete, `the transfer itself ends whole: the ending reached the reader before the close (last received: ${JSON.stringify(got.text.slice(-200))})`);
    assert.match(got.text, /INCOMPLETE[^\n]*too slowly/, 'the drive: no incomplete ending, the final chunk missing');
    assert.ok(got.text.endsWith('!ythril-export-incomplete\n'), 'the last line received is the one no parser accepts');
    assert.equal(got.trailers['ythril-export-complete'], 'false');
    // The cut falls inside a record; the ending still starts on a line of its own (the slice G drive: its first statement, the graph's
    // dcterms:isPartOf the report, was glued to the cut record's half line, so no line-wise reader could read it).
    assert.match(got.text, /^<[^<>\s]+> <http:\/\/purl\.org\/dc\/terms\/isPartOf> <urn:ythril:export-report:[0-9a-f]+>/m,
      'the ending of an export cut for its reader begins a line');
    await assert.rejects(parseRdf('nquads', got.text), 'a stream cut by the rate bound is never read as whole');
  }

  for (const [label, share] of [['at a tenth of the bound', 0.1], ['just under the bound', 0.9]]) {
    it(`a reader ${label} is judged too slow, frees its slot at once, and receives the incomplete ending as its last line`, async () => {
      const r = readAt(url, tok.key, { bytesPerSecond: pace.minBytesPerSecond * share });
      await r.headed;
      await waitFor(slotFree, verdictWithin(), 100, () => `the reader ${label} still holds its slot`);
      await assertToldTooSlow(await r.done);
    });
  }

  for (const [label, share] of [['just over the bound', 1.1], ['at twice the bound', 2]]) {
    it(`a reader ${label} gets the whole export, however long it runs`, async () => {
      const got = await readAt(url, tok.key, { bytesPerSecond: pace.minBytesPerSecond * share }).done;
      assert.equal(got.status, 200);
      assert.ok(got.complete, `the reader ${label} was cut after ${got.ms} ms (last received: ${JSON.stringify(got.text.slice(-200))})`);
      assert.equal(got.trailers['ythril-export-complete'], 'true', got.text.slice(-300));
      assert.match(got.text, new RegExp(`# ythril-export: ${TOTAL} records; complete, nothing is left`));
    });
  }

  it('a reader that takes nothing for the first window is judged by what it took, not by what the buffers took, and is told', async () => {
    const r = readAt(url, tok.key, { bytesPerSecond: Infinity, holdMs: verdictWithin() });
    await r.headed;
    await waitFor(slotFree, verdictWithin(), 100, () => 'a reader that took nothing still holds its slot: the buffers\' fill was counted as taken');
    await assertToldTooSlow(await r.done);
  });

  it('a reader that takes nothing at all frees its slot, and its connection is cut once the ending had its time', async () => {
    const r = readAt(url, tok.key, { bytesPerSecond: 0 });
    try {
      await r.headed;
      await waitFor(slotFree, verdictWithin(), 100, () => 'a reader that takes nothing still holds its slot');
      // What it still takes after the ending's time is what its connection held when the server closed it: never a whole transfer.
      await new Promise(resolve => setTimeout(resolve, endingWaitMs + 2_000));
    } finally { r.release(); }
    const got = await r.done;
    assert.equal(got.status, 200);
    assert.equal(got.complete, false, 'the connection of a reader that took nothing was not cut');
  });
});

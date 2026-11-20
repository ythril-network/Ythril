/**
 * The trickling readers of the RDF export and the set-up their three test files share (bundle-269 review, finding 9; the first drive,
 * finding 7; the second drive, finding A; cut into three files in bundle-356, Q-937).
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
 * their size against the loopback buffers, are production's. The window is not shortened further: the rows just under and just over the
 * bound sit at 10 % of it, and a stall of a loaded runner is a larger share of a shorter window. A slow reader's last received line is the
 * line no parser accepts, and its transfer ends whole (the ending reached it before the close).
 *
 * ## Releasing a slow reader once the server has closed its side
 *
 * A reader at a tenth of the bound frees its slot within `verdictWithin()`, and then still had several MB of loopback buffers to drain at
 * that rate (about 20 s a case). What it receives was decided by the server by then: {@link openTrickle}'s `releaseOnceServerClosed` waits,
 * after the verdict, until the server's answer to THAT reader has been handed to the operating system whole (`finish`) or destroyed
 * (`close` without it), and only then lets the reader take the rest at once. The reader's own last line still decides the case: a server
 * that destroys the connection instead of ending it, or never writes the ending, leaves a reader that receives no ending however fast it
 * drains.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

export const SPACE = 'rdftrickle';
/** About 25 MB of N-Quads: several windows for the reader just over the bound, and far more than the loopback buffers hold. */
export const TOTAL = 6_000;
const BLOB = 'x'.repeat(4_000);
/** The window here; the production window, idle bound and rate are scaled by the factor that makes the window this. */
const WINDOW_MS = 3_000;
/** The idle bound here: production's stands to its window as one to one (asserted in the set-up), so the scaled one is the window. */
const IDLE_MS = WINDOW_MS;
/** How often a throttled reader takes what its rate allows. */
const TICK_MS = 10;
/** The request header that names a reader to the server-side watch of its answer. */
const READER_HEADER = 'x-test-trickle-reader';

/** A planted store: `TOTAL` large entities, pages of the size asked; every other collection is empty. */
function bigStore(spec, afterId) {
  if (!String(spec.collection).endsWith('entities')) return Promise.resolve({ rows: [], end: true });
  const start = afterId === undefined ? 0 : Number(String(afterId).slice(1)) + 1;
  const n = Math.max(0, Math.min(spec.size, TOTAL - start));
  const rows = Array.from({ length: n }, (_, i) => ({ _id: `b${String(start + i).padStart(6, '0')}`, name: `Big ${start + i}`, description: BLOB, tags: [] }));
  return Promise.resolve({ rows, ...(n > 0 ? { last: rows[n - 1]._id } : {}), end: start + n >= TOTAL });
}

let readers = 0;

/**
 * GET the whole export and take it at `bytesPerSecond` (a token bucket, so timer jitter does not lower the average; `Infinity` takes all
 * that arrives), after taking nothing for `holdMs`; `0` takes nothing until `release()`. Answers the text, the trailers and whether the
 * transfer ended whole; `id` names the reader to the server-side watch.
 */
export function readAt(url, key, { bytesPerSecond, holdMs = 0, headers = {} }) {
  const id = `r${++readers}`;
  let release;
  let started;
  let fast = false;
  const released = new Promise(r => { release = r; });
  // The status line has arrived: the export holds its slot from here (a probe of the slot before it could find it free, never taken).
  const headed = new Promise(r => { started = r; });
  const done = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get(url, { headers: { Authorization: `Bearer ${key}`, [READER_HEADER]: id, ...headers }, agent: false }, (res) => {
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
        resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], text: Buffer.concat(chunks).toString('utf8'), trailers: res.trailers, complete, ms: Date.now() - t0 });
      };
      res.on('end', () => finish(true));
      res.on('aborted', () => finish(false));
      res.on('error', () => finish(false));
      res.on('close', () => finish(res.complete));
    });
    req.on('error', reject);
  });
  return { id, release: () => release(), headed, done };
}

/**
 * Open the export doors over one space of `TOTAL` large records at production's pace scaled to `WINDOW_MS`, with a token that reads it.
 * @param {string} suite the harness database of this file (each file its own, so the three can run side by side)
 * @returns the doors `d`, the server's export module `act`, `tok`, the N-Quads `url`, `pace`, `endingWaitMs`, and `slotFree`,
 *   `verdictWithin`, `assertToldTooSlow`, `releaseOnceServerClosed`, `close`
 */
export async function openTrickle(suite) {
  const d = await openRdfExportDoors({ suite, spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
  const act = await import('../../server/dist/rdf/export-act.js');
  /** reader id -> how the server's answer to it ended: `finished` (handed to the operating system whole) or `destroyed`. */
  const ended = new Map();
  const watch = (req, res) => {
    const id = req.headers[READER_HEADER];
    if (typeof id !== 'string') return;
    ended.set(id, undefined);
    res.once('finish', () => ended.set(id, 'finished'));
    res.once('close', () => { if (ended.get(id) === undefined) ended.set(id, res.writableFinished ? 'finished' : 'destroyed'); });
  };
  d.server.httpServer.on('request', watch);
  try {
    const tok = await d.mint('reader', { [SPACE]: d.row({ knowledge: 'read' }) });
    const url = `${d.server.url}/api/brain/spaces/${SPACE}/export/rdf?format=nquads`;
    act.setRdfExportPageReaderForTest(bigStore);
    // Production's numbers, then all three scaled by one factor: the bytes a window asks for stay production's.
    act.setRdfExportRateForTest(null);
    act.setRdfExportIdleMsForTest(null);
    const production = { ...act.rdfExportRate(), idleMs: act.rdfExportIdleMs() };
    const factor = production.windowMs / WINDOW_MS;
    assert.equal(production.idleMs / factor, IDLE_MS, 'the idle bound is scaled with the window, by the same factor (production\'s ratio)');
    const pace = { windowMs: WINDOW_MS, minBytesPerSecond: production.minBytesPerSecond * factor, idleMs: IDLE_MS };
    act.setRdfExportRateForTest({ windowMs: WINDOW_MS, minBytesPerSecond: pace.minBytesPerSecond });
    act.setRdfExportIdleMsForTest(IDLE_MS);
    // How long a reader judged too slow is given to take the ending (the build before this rule had none: the idle bound stood for it).
    const endingWaitMs = act.rdfExportEndingWaitMs?.() ?? pace.idleMs;

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

    /**
     * Call after the verdict (the slot is free): wait until the server's answer to reader `r` has ended, handed to the operating system
     * whole or destroyed, then let `r` take the rest at once. The server closes its side within the ending wait (`closeUnlessFinished`).
     */
    async function releaseOnceServerClosed(r) {
      await waitFor(() => ended.get(r.id) !== undefined, endingWaitMs + 5_000, 100,
        () => `the server's answer to reader ${r.id} ${ended.has(r.id) ? 'neither finished nor closed within the ending wait' : 'was never seen'}`);
      r.release();
    }

    async function close() {
      d.server.httpServer.off('request', watch);
      act.setRdfExportPageReaderForTest?.(null);
      act.setRdfExportRateForTest?.(null);
      act.setRdfExportIdleMsForTest?.(null);
      await d.close();
    }

    return { d, act, tok, url, pace, endingWaitMs, slotFree, verdictWithin, assertToldTooSlow, releaseOnceServerClosed, close };
  } catch (err) {
    d.server.httpServer.off('request', watch);
    await d.close();
    throw err;
  }
}

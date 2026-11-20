/**
 * A reader that accepts gzip is answered the export's own text and judged by the stated bound as any other reader (bundle-269 review,
 * finding 9, lens finding 2).
 *
 * The application compresses Turtle and JSON-LD for a client that accepts gzip, and an export that was compressed was judged on compressed
 * bytes (what the socket took) while the guide states the rate in the bytes of the export itself: a well-compressible export of a slow
 * reader was measured at a fraction of its size. The stream is not compressed, whatever the reader accepts, so the rate the guide states is
 * the rate measured. Readers at a tenth of the bound and at twice it, over a real loopback socket at production's numbers scaled together;
 * the drives, the scaling and why a slow reader is released once the server has closed its side are in `_rdf-trickle-readers.mjs`. The rate
 * rows and the idle and log rows are the two other files of the rule (`a-trickling-reader-cases-are-held-once-across-their-files` holds that
 * each case is in exactly one).
 *
 * Run: node --test testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-through-gzip-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { parseRdf } from './_rdf-export-doors.mjs';
import { openTrickle, readAt, TOTAL } from './_rdf-trickle-readers.mjs';

const skip = await mongoSkipReason();

describe('a trickling reader cannot hold an export slot, through gzip', { skip, timeout: 600_000 }, () => {
  let t;
  before(async () => { t = await openTrickle('rdf_export_trickle_gzip'); });
  after(async () => { await t?.close(); });

  /** A Turtle export (a format the application compresses; N-Quads is not a compressible type, so it never showed) read at `share` of the bound by a reader that accepts gzip. */
  const gzipReader = (share) => readAt(t.url.replace('format=nquads', 'format=turtle'), t.tok.key,
    { bytesPerSecond: t.pace.minBytesPerSecond * share, headers: { 'Accept-Encoding': 'gzip, deflate, br' } });

  it('a reader that accepts gzip at a tenth of the bound is answered the text itself and judged by the bound as any other', async () => {
    const r = gzipReader(0.1);
    await r.headed;
    await waitFor(t.slotFree, t.verdictWithin(), 100, () => 'the gzip reader at a tenth of the bound still holds its slot');
    await t.releaseOnceServerClosed(r);
    const got = await r.done;
    assert.equal(got.encoding, undefined, `the stream was sent as ${got.encoding}: the rate is then measured on compressed bytes`);
    assert.equal(got.status, 200);
    assert.ok(got.complete, `the transfer itself ends whole: the ending reached the reader before the close (last received: ${JSON.stringify(got.text.slice(-200))})`);
    assert.match(got.text, /INCOMPLETE[^\n]*too slowly/, 'a reader of compressed bytes was not told');
    assert.ok(got.text.endsWith('!ythril-export-incomplete\n'));
    assert.equal(got.trailers['ythril-export-complete'], 'false');
    await assert.rejects(parseRdf('turtle', got.text), 'a stream cut by the rate bound is never read as whole');
  });

  it('a reader that accepts gzip at twice the bound is answered the text itself and judged by the bound as any other', async () => {
    const got = await gzipReader(2).done;
    assert.equal(got.encoding, undefined, `the stream was sent as ${got.encoding}: the rate is then measured on compressed bytes`);
    assert.equal(got.status, 200);
    assert.ok(got.complete, `the gzip reader at twice the bound was cut after ${got.ms} ms`);
    assert.match(got.text, new RegExp(`# ythril-export: ${TOTAL} records; complete, nothing is left`));
  });
});

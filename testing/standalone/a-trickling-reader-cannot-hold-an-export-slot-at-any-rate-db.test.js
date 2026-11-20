/**
 * A whole export whose reader is under the stated bound ends, truthfully, in the incomplete ending that reader still receives, and frees its
 * slot; one whose reader keeps up with the bound is never cut (bundle-269 review, finding 9; the first drive, finding 7; the second drive,
 * finding A).
 *
 * Readers at a tenth of the bound, just under it, just over it and at twice it, over a real loopback socket at production's numbers scaled
 * together; the drives, the scaling and why a slow reader is released once the server has closed its side are in `_rdf-trickle-readers.mjs`.
 * The gzip rows and the idle and log rows are the two other files of the rule (`a-trickling-reader-cases-are-held-once-across-their-files`
 * holds that each case is in exactly one).
 *
 * Run: node --test testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-at-any-rate-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openTrickle, readAt, TOTAL } from './_rdf-trickle-readers.mjs';

const skip = await mongoSkipReason();

describe('a trickling reader cannot hold an export slot, at any rate', { skip, timeout: 600_000 }, () => {
  let t;
  before(async () => { t = await openTrickle('rdf_export_trickle_rate'); });
  after(async () => { await t?.close(); });

  /** A reader at `share` of the bound frees its slot within the verdict and receives the ending; `release` once the server has closed. */
  async function judgedTooSlow(label, share, { release }) {
    const r = readAt(t.url, t.tok.key, { bytesPerSecond: t.pace.minBytesPerSecond * share });
    await r.headed;
    await waitFor(t.slotFree, t.verdictWithin(), 100, () => `the reader ${label} still holds its slot`);
    if (release) await t.releaseOnceServerClosed(r);
    await t.assertToldTooSlow(await r.done);
  }

  /** A reader at `share` of the bound reads the whole export. */
  async function getsTheWhole(label, share) {
    const got = await readAt(t.url, t.tok.key, { bytesPerSecond: t.pace.minBytesPerSecond * share }).done;
    assert.equal(got.status, 200);
    assert.ok(got.complete, `the reader ${label} was cut after ${got.ms} ms (last received: ${JSON.stringify(got.text.slice(-200))})`);
    assert.equal(got.trailers['ythril-export-complete'], 'true', got.text.slice(-300));
    assert.match(got.text, new RegExp(`# ythril-export: ${TOTAL} records; complete, nothing is left`));
  }

  it('a reader at a tenth of the bound is judged too slow, frees its slot at once, and receives the incomplete ending as its last line', async () => {
    await judgedTooSlow('at a tenth of the bound', 0.1, { release: true });
  });

  it('a reader just under the bound is judged too slow, frees its slot at once, and receives the incomplete ending as its last line', async () => {
    // Read to its end at its own rate: at nine tenths of the bound the buffers drain in a few seconds.
    await judgedTooSlow('just under the bound', 0.9, { release: false });
  });

  it('a reader just over the bound gets the whole export, however long it runs', async () => {
    await getsTheWhole('just over the bound', 1.1);
  });

  it('a reader at twice the bound gets the whole export, however long it runs', async () => {
    await getsTheWhole('at twice the bound', 2);
  });
});

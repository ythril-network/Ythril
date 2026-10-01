/**
 * A duplicate edge triplet must never 500 an ingest — a non-ok push stalls that channel permanently.
 *
 * ## The mechanism, end to end
 *
 * A new edge gets a random `uuidv4()` id (`brain/edges.ts`), and every space carries a UNIQUE index on
 * `{ from, to, label }` (`spaces/lifecycle.ts`). So two peers creating the same relationship independently
 * produce one triplet under two ids. On ingest the incoming `_id` is unknown, the upsert inserts, and the
 * unique index rejects it.
 *
 * The PULL side already absorbs that: `sync/engine.ts` writes with `ordered: false` and swallows 11000 only.
 * **The push side did not**, and it is the worse half:
 *
 *   1. `POST /api/sync/edges` (or the `batch-upsert` edges loop) lets E11000 reach the route's catch → `500`.
 *   2. On the sender, `pushCollection` does `if (!resp.ok) { truncated = true; break; }` — **before**
 *      `seqCursor` is advanced.
 *   3. `resolveWatermark` caps a truncated transfer at `deliveredThrough`, i.e. the last batch that landed.
 *   4. Next cycle re-selects the identical batch and fails identically.
 *
 * The edges channel to that peer never advances again — the exact wedge the pull fix was written to remove,
 * still live on the other side of the same protocol. And in the batch case one duplicate anywhere in a
 * 500-record page discards the other 499 with it.
 *
 * ## Why the assertions are shaped this way
 *
 * The predicate is exercised as a FUNCTION against both real error shapes, because the two differ and a
 * predicate that knew only one would re-throw the very thing it exists to absorb: a single `replaceOne`
 * rejects with `code: 11000` at the top level, while a `bulkWrite` collects them into `writeErrors` and the
 * outer error carries no code at all.
 *
 * Run: node --test testing/standalone/an-edge-collision-never-stalls-the-channel.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, enclosingBlockMatching } from './_structural-window.mjs';

const { isDuplicateKeyOnly } = await import('../../server/dist/api/sync/_shared.js');

const DOCS = 'server/src/api/sync/docs.ts';
const docs = stripComments(readFileSync(DOCS, 'utf8'));

describe('the duplicate-key predicate knows both error shapes', () => {
  it('absorbs a single-write rejection', () => {
    // What `replaceOne` throws: the code is on the error itself.
    assert.equal(isDuplicateKeyOnly({ code: 11000, message: 'E11000 duplicate key' }), true);
  });

  it('absorbs a bulk rejection, where the OUTER error carries no code at all', () => {
    // The shape that catches a predicate written against only `err.code` — it is `undefined` here.
    assert.equal(isDuplicateKeyOnly({ writeErrors: [{ code: 11000 }, { err: { code: 11000 } }] }), true);
  });

  it('re-throws anything else, including a MIXED batch', () => {
    assert.equal(isDuplicateKeyOnly({ code: 121 }), false, 'a validation failure is not a duplicate');
    assert.equal(isDuplicateKeyOnly(new Error('connection reset')), false);
    assert.equal(isDuplicateKeyOnly(undefined), false, 'a thrown non-object must not read as a duplicate');
    assert.equal(
      isDuplicateKeyOnly({ writeErrors: [{ code: 11000 }, { code: 121 }] }), false,
      'ONE non-duplicate in the batch means the whole thing is re-thrown. Swallowing a mixed error would hide '
      + 'genuine corruption, which is the opposite defect and the harder one to find later.',
    );
  });

  it('an empty writeErrors array is not a duplicate', () => {
    // Reached when a driver reports the field but nothing in it. Reading that as "all duplicates" is how a
    // vacuous `.every()` on an empty array silently absorbs an unrelated failure.
    assert.equal(isDuplicateKeyOnly({ writeErrors: [] }), false);
  });
});

describe('every edge ingest absorbs a duplicate triplet', () => {
  /*
   * Re-anchored for `Q-107` part 1. The single-record route and the batch loop were two implementations of one
   * rule, each wrapping its own write in a `try` that absorbed E11000; both are now one page accept, and every
   * edge a push stores is written by the arrival writer (`writeArrivals`, `sync/arrivals.ts`), which absorbs the
   * duplicate PER OPERATION, reads it back and reports it by id (`outcome.duplicates`) — never as a throw. The
   * writer half (unordered, read back, a non-duplicate still throws) is `one-duplicate-key-does-not-wedge-a-member`;
   * this file holds the door half: every edge write is the writer's, a duplicate becomes the `duplicate` verdict,
   * and that verdict answers 200 on both doors.
   *
   * Seen red by mutation, restored by hand: the batch counter `duplicateTriplets` counting `skipped`; the single
   * route answering `ok` for a duplicate; the edges `writeArrivals` call replaced by a bare `bulkWrite`.
   */
  const ARRIVALS = stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8'));

  /** Every arrival-writer call in the push door that stores edges — derived, not named. */
  function edgeWrites() {
    return [...docs.matchAll(/writeArrivals\(\s*\w+\s*,\s*'edges'\s*,\s*'edge'\s*,/g)].map(m => m.index);
  }

  it('finds the ingest writes, so an empty sweep cannot pass', () => {
    assert.ok(edgeWrites().length >= 1, `found ${edgeWrites().length} edge write(s) through the arrival writer in ${DOCS}`);
    assert.doesNotMatch(docs, /\.(?:replaceOne|insertOne|updateOne|bulkWrite)\(/,
      `${DOCS} writes a record itself again, outside the writer that absorbs a duplicate per document`);
  });

  it('the writer absorbs a duplicate per document and hands it back by id', () => {
    const body = bodyOf(ARRIVALS, 'writeArrivals');
    assert.match(body, /code === DUPLICATE_KEY\)\s*dupes\.push\(d\)/, 'the writer does not set a duplicate apart');
    assert.match(body, /else out\.duplicates\.push\(d\._id\)/, 'a duplicate is not handed back by id');
  });

  it('a duplicate is REPORTED, not silently dropped', () => {
    // The owner's P-21 ruling: accept what you can, and hand back what you could not.
    assert.match(docs, /dup\.has\(id\) \? 'duplicate' : 'rejected'/,
      'the door does not turn a writer duplicate into the `duplicate` verdict');
    assert.match(docs, /duplicateTriplets: count\('edges', 'duplicate'\)/,
      'the batch stats must count the duplicate verdict as duplicateTriplets');
    assert.match(docs, /status: verdict === 'duplicate' \? 'duplicate' : 'ok'/,
      "the single-record route must answer 'duplicate' rather than 'ok' — a sender that cannot tell them "
      + 'apart advances its watermark believing it delivered a record that was refused');
    assert.match(ARRIVALS, /warnArrivalsNotStored\([^;]*out\.duplicates\)/, 'and the operator must get a line naming it');
  });

  it('the response still says 200, so the sender does not stall', () => {
    /*
     * `pushCollection` breaks on `!resp.ok` BEFORE advancing `seqCursor`, and `resolveWatermark` then caps
     * the watermark at the last batch that landed — so any non-2xx here is a permanent stall for that
     * channel, not a retry. Read BACKWARDS to the `res.status(` that opens this response: the nearest preceding
     * one IS the one that carries this body.
     */
    const at = docs.indexOf("status: verdict === 'duplicate' ? 'duplicate' : 'ok'");
    assert.notEqual(at, -1, 'the duplicate status is gone — re-point this gate');
    const statusAt = docs.lastIndexOf('res.status(', at);
    assert.notEqual(statusAt, -1, 'no res.status before the duplicate body — re-point this gate');
    assert.match(docs.slice(statusAt, at), /^res\.status\(200\)/,
      'a duplicate must answer 200. A 500 makes the pushing peer hold its watermark and re-send the identical '
      + 'batch every cycle, so the channel never advances again — which is the bug, not the symptom.');
  });
});

describe('the sender still treats a non-ok push as a stall', () => {
  // Pinned because it is the OTHER half of the mechanism and this fix relies on it staying true: if the push
  // loop ever advanced its cursor past a failed batch, a 500 would become silent data loss instead of a
  // visible stall — a different bug, and the reason the fix belongs on the receiving side.
  const engine = stripComments(readFileSync('server/src/sync/engine.ts', 'utf8'));

  it('breaks without advancing the cursor', () => {
    /*
     * Anchored on the push loop's OWN warning, not on `if (!resp.ok)`.
     *
     * There are five `if (!resp.ok)` guards in this file and `indexOf` finds the first — a pull guard several
     * hundred lines above the loop this test is about. It failed with "must mark the transfer truncated"
     * against code that does exactly that, which is the tell for an anchor that landed somewhere else.
     */
    const at = engine.indexOf('truncationWarn(`Batch push');
    assert.notEqual(at, -1, 'the batch-push truncation warning is gone — re-point this gate');
    const block = enclosingBlockMatching(engine, at, /if \(!resp\.ok\) \{/, 'the non-ok push branch');
    assert.ok(block, 'the batch-push warning is no longer inside a non-ok guard — re-point this gate');
    assert.match(block, /truncated = true/, 'a failed push must mark the transfer truncated');
    assert.doesNotMatch(
      block, /seqCursor\s*=/,
      'the cursor must NOT advance past a batch the peer refused — that would turn a visible stall into '
      + 'silent loss',
    );
  });
});

/**
 * A megabyte `seq` or `_id` from a peer or a backup makes a bounded log line AND a bounded answer (`Q-270`).
 *
 * ## The rule
 *
 * A refusal names what it refused — the id, and a reason built from the document (`seq "…" is not a non-negative
 * integer`). Nothing bounds either: a peer that sends a seq of a million digits gets a million-character warning in
 * the ring the log viewer reads, in the container log and in every aggregator downstream, once per page, every
 * cycle; and the same reason travels back in the answer — a 400 — so the flood is mirrored to
 * whoever sent it. The values are bounded where the reason is BUILT (`peerText`), so the server's own words always
 * reach the line and the answer whole, and the peer's part is cut and says by how much.
 *
 * Asserted per door a peer or a backup reaches with such a value, over every line the server emitted while it ran
 * (`_log-lines.mjs`) and over the answer as it would be serialised. Each case also checks that the refusal happened
 * at all, so a case that refused nothing cannot pass by logging nothing.
 *
 * `LIMIT` is 64 KiB for a line and for an answer: far above any honest line (the bound per value is at most 16 KiB,
 * which `a-peer-value-is-rendered-escaped-redacted-and-bounded` holds `LOG_VALUE_MAX` to, and each case refuses one
 * document), and far below the megabyte each case sends.
 *
 * The megabyte values are digits after a short prefix, never a long run of letters: redaction backtracks over a run
 * of scheme characters and that cost is its own case in the unit test — here it would only make a red run slow.
 *
 * ## Pins (green on the base, kept)
 *
 * The single push route answers a megabyte string seq with its wire schema's generic 400 — bounded today, and kept so
 * when the accept rule moves (`Q-204`), the refusal's own words do not start travelling back unbounded.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): the tombstone push and the batch push log a megabyte `_id` whole (`warnArrivalsNotStored`
 * escapes and never cuts); the fork-cap 400 quotes the `_id` whole. A megabyte string seq on the tombstone and batch
 * pushes is refused by a wire schema whose reason names only the field, so there it is the `_id` that floods.
 *
 * The import is a PIN on the release line, not a case: 5.6.3 stores an odd seq (`C7`) and refuses nothing, so there is
 * no refusal to quote; main's refusal of an implausible seq on a restore is a behaviour change the patch does not carry.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-megabyte-from-a-peer-makes-a-bounded-line-and-answer-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const S = 'peerflood';
const LIMIT = 64 * 1024;
const MEGA = 1 << 20;
const BIG_SEQ = '9'.repeat(MEGA);
const BIG_ID = `big-${'9'.repeat(MEGA)}`;
let door, MAX_INGEST_SEQ, CAP;

const kib = n => `${Math.round(n / 1024)} KiB`;

/** Every line `fn` emitted is under the limit; returns the lines and `fn`'s result. */
async function boundedLinesDuring(fn) {
  const { emitted, lines, result } = await logLinesDuring(fn);
  const long = emitted.filter(l => l.length > LIMIT).map(l => `${kib(l.length)}: ${l.slice(0, 120)}…`);
  assert.deepEqual(long, [], 'a log line carries what a peer sent unbounded');
  return { lines, result };
}

function assertBoundedAnswer(body, what) {
  const size = JSON.stringify(body).length;
  assert.ok(size <= LIMIT, `${what} is ${kib(size)}: the megabyte went back in the answer`);
}

describe('a megabyte from a peer makes a bounded line and a bounded answer', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'peerflood', spaces: [{ id: S, label: 'Flood', folders: [], meta: {} }] });
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
    ({ MAX_FORK_DEPTH: CAP } = await import('../../server/dist/api/sync/_shared.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  for (const [label, tombstone] of [
    ['refused by its seq (implausible)', () => build.tombstone(S, BIG_ID, 'fact', MAX_INGEST_SEQ + 1)],
    ['refused by its shape (a megabyte string seq)', () => build.tombstone(S, BIG_ID, 'fact', BIG_SEQ)],
  ]) {
    it(`a pushed tombstone under a megabyte _id, ${label}: the refusal line is bounded, and so is the answer`, async () => {
      const { lines, result: r } = await boundedLinesDuring(() =>
        door.push('/tombstones', { tombstones: [tombstone()] }, { spaceId: S }));
      assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.refused, 1, 'fixture check: the tombstone was not refused, so nothing was logged about it');
      assert.ok(lines.some(l => l.includes('big-999')), 'fixture check: the refusal was not logged at all');
      assertBoundedAnswer(r.body, 'the tombstone push answer');
    });
  }

  for (const [label, page] of [
    ['a document the arrival writer refuses (an implausible seq) under a megabyte _id',
      () => ({ facts: [build.fact(S, BIG_ID, MAX_INGEST_SEQ + 1)] })],
    ['a document the wire schema refuses (a megabyte string seq) under a megabyte _id',
      () => ({ facts: [build.fact(S, BIG_ID, BIG_SEQ)] })],
  ]) {
    it(`batch push, ${label}: the refusal line is bounded, and so is the answer`, async () => {
      const { lines, result: r } = await boundedLinesDuring(() => door.push('/batch-upsert', page(), { spaceId: S }));
      assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.facts.rejected, 1, 'fixture check: the document was not refused, so nothing was logged');
      assert.ok(lines.some(l => l.includes('big-999')), 'fixture check: the refusal was not logged at all');
      assertBoundedAnswer(r.body, 'the batch push answer');
    });
  }

  it('single push at the fork cap under a megabyte _id: the 400 is bounded', async () => {
    await door.coll(S, 'facts').insertOne(build.fact(S, BIG_ID, 5, { fact: 'root' }));
    await door.coll(S, 'facts').insertMany(Array.from({ length: CAP }, (_, i) =>
      build.fact(S, `old-fork-${i}`, 100 + i, { fact: `old ${i}`, forkOf: BIG_ID })));
    const { result: r } = await boundedLinesDuring(() =>
      door.push('/facts', build.fact(S, BIG_ID, 5, { fact: 'divergent at the cap' }), { spaceId: S }));
    assert.equal(r.code, 400, `fixture check: the fork was not refused at the cap: ${JSON.stringify(r.body).slice(0, 300)}`);
    assertBoundedAnswer(r.body, 'the fork-cap 400');
  });

  it('PIN: single push of a megabyte string seq answers a bounded 400', async () => {
    const { result: r } = await boundedLinesDuring(() => door.push('/facts', build.fact(S, 'flood-single', BIG_SEQ), { spaceId: S }));
    assert.equal(r.code, 400, JSON.stringify(r.body).slice(0, 300));
    assertBoundedAnswer(r.body, 'the single push 400');
  });

  it('a pushed tombstone of a megabyte TYPE this instance does not know: the held-page line is bounded', async () => {
    // `tombstone-apply.ts` names the unknown types a page carried — a joined list of what the sender wrote, five at most,
    // each of any length. The list is `peerList`'s question, and a type is as steerable as an id.
    const { lines, result: r } = await boundedLinesDuring(() =>
      door.push('/tombstones', { tombstones: [build.tombstone(S, 'doc-1', `t${'9'.repeat(MEGA)}`, 5)] }, { spaceId: S }));
    assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
    assert.ok(lines.some(l => l.includes('does not know') || l.includes('tombstone type')),
      `fixture check: the unknown type was not logged at all: ${JSON.stringify(r.body).slice(0, 300)}`);
    assertBoundedAnswer(r.body, 'the tombstone push answer');
  });

  it('a megabyte file path that names no file: the missing-reference refusal is bounded, and names it escaped', async () => {
    // A UUID reference is 36 characters whatever the caller sends (anything else is refused by SHAPE, not looked up), so
    // the reference kind that can be both well-formed and a megabyte long is a file path. This is the existence half of
    // `invalidRefsMessage`'s copy: the same `slice(0, 5)` + `(+N more)`, built a second time.
    const refs = await import('../../server/dist/brain/entity-refs.js');
    const long = `notes/${'a'.repeat(MEGA)}.md`;
    let refusal;
    try { await refs.assertRefsResolve(S, 'files', 'file', [long, 'notes/other.md']); } catch (err) { refusal = err; }
    assert.ok(refusal instanceof refs.ReferenceRefusal, `fixture check: nothing refused the missing paths: ${refusal}`);
    assert.ok(refusal.message.length <= LIMIT, `the refusal is ${kib(refusal.message.length)}: the path went back whole`);
    assert.match(refusal.message, /notes\/other\.md/, 'the second missing path is still named');
  });

  it('PIN: an import stores an odd seq as 5.6.3 does (cut C7), so it refuses nothing and quotes nothing', async () => {
    // Main's import refuses an implausible seq and quotes it; the release line stores it (`C7`, no seq refusal on a
    // restore). The case that asked "is the quote bounded" has nothing to ask here, and the thing that must stay is
    // that a restore keeps landing such a document: a backup is not refused by its own instance.
    const { importDocuments } = await import('../../server/dist/api/admin-import.js');
    const payload = { facts: [build.fact(S, 'flood-import', BIG_SEQ), build.fact(S, BIG_ID, MAX_INGEST_SEQ + 1)] };
    const { result } = await boundedLinesDuring(() => importDocuments(S, payload));
    assert.deepEqual({ ...result.results.facts }, { inserted: 2, updated: 0, errors: 0 },
      'the import now refuses a document 5.6.3 stored: a behaviour change, not a fix');
    assertBoundedAnswer(result, 'the import result');
  });
});

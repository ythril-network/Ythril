/**
 * A megabyte `seq` or `_id` from a peer or a backup makes a bounded log line AND a bounded answer (`Q-270`).
 *
 * ## The rule
 *
 * A refusal names what it refused — the id, and a reason built from the document (`seq "…" is not a non-negative
 * integer`). Nothing bounds either: a peer that sends a seq of a million digits gets a million-character warning in
 * the ring the log viewer reads, in the container log and in every aggregator downstream, once per page, every
 * cycle; and the same reason travels back in the answer — the import result, a 400 — so the flood is mirrored to
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
 * On 0b066822: the tombstone push and the batch push log a megabyte `_id` whole (`warnArrivalsNotStored` escapes
 * and never cuts); the import logs a megabyte seq whole (`seqRefusal` quotes it, and an import is validated by the
 * writer's shape rule, not a wire schema) and returns both in `refused[]`; the fork-cap 400 quotes the `_id` whole.
 * A megabyte string seq on the tombstone and batch pushes is refused by a wire schema whose reason names only the
 * field, so there it is the `_id` that floods.
 *
 * Q-624 re-anchor: the fork-cap 400 and the malformed-fork answers (`invalid_fork`, `invalidFork` counted) quote ids a peer chose, for every kind
 * that forks (`FORKING_FAMILIES`), so the bounded-answer and bounded-line rule is held over each. Seen red on the base (b857da8f): an entity, chrono
 * entry or edge at an equal seq is never forked, so no cap and no malformed-fork answer exists to be bounded.
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
import { FORK_FIXTURE, forkingFamilies } from './_fork-kinds.mjs';

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

  /*
   * Q-624 re-anchor: the fork paths a megabyte `_id` can reach are no longer the fact's alone. Every kind that forks (read from the
   * planner, never listed) has the cap's 400 and the malformed-fork answers (`invalid_fork`, with the id; the receiver's reporter line
   * and the counted `invalidFork`), and each quotes an id the peer chose: bounded where it is SHOWN, never where it is a key.
   */
  /** The identity an edge needs to be a fork's subject without a megabyte endpoint: its `from`/`to`/`label` are short on purpose. */
  const ofKind = (family, id, seq, extra = {}) => FORK_FIXTURE[family].build(S, id, seq, {
    ...(family === 'edges' ? { from: 'a', to: 'b', label: 'knows' } : {}), ...extra });
  const bodyOf = (family, text) => ({ [FORK_FIXTURE[family].field]: text });

  it('single push at the fork cap under a megabyte _id: the 400 is bounded, for every kind that forks', async () => {
    for (const family of await forkingFamilies()) {
      await door.wipe(S);
      await door.coll(S, family).insertOne(ofKind(family, BIG_ID, 5, bodyOf(family, 'root')));
      await door.coll(S, family).insertMany(Array.from({ length: CAP }, (_, i) =>
        ofKind(family, `old-fork-${i}`, 100 + i, { ...bodyOf(family, `old ${i}`), forkOf: BIG_ID })));
      const { result: r } = await boundedLinesDuring(() =>
        door.push(FORK_FIXTURE[family].single, ofKind(family, BIG_ID, 5, bodyOf(family, 'divergent at the cap')), { spaceId: S }));
      assert.equal(r.code, 400, `${family}: fixture check: the fork was not refused at the cap: ${JSON.stringify(r.body).slice(0, 300)}`);
      assertBoundedAnswer(r.body, `the ${family} fork-cap 400`);
    }
  });

  it('a malformed fork row under a megabyte _id: the single answer, the batch answer and every line are bounded, for every kind', async () => {
    for (const family of await forkingFamilies()) {
      await door.wipe(S);
      await door.coll(S, family).insertOne(ofKind(family, 'parent', 5, bodyOf(family, 'root')));
      // The id is a megabyte and derives from nothing: the row is malformed whatever else it says.
      const bad = () => ofKind(family, BIG_ID, 5, { ...bodyOf(family, 'theirs'), forkOf: 'parent' });
      const { result: one } = await boundedLinesDuring(() => door.push(FORK_FIXTURE[family].single, bad(), { spaceId: S }));
      assert.deepEqual([one.code, one.body?.code], [400, 'invalid_fork'], `${family}: single: ${JSON.stringify(one.body).slice(0, 300)}`);
      assertBoundedAnswer(one.body, `the ${family} invalid_fork 400`);
      const { result: many } = await boundedLinesDuring(() => door.push('/batch-upsert', { [family]: [bad()] }, { spaceId: S }));
      assert.equal(many.code, 200, JSON.stringify(many.body).slice(0, 300));
      assert.equal(many.body[family].invalidFork, 1, `${family}: batch: ${JSON.stringify(many.body[family]).slice(0, 300)}`);
      assertBoundedAnswer(many.body, `the ${family} batch answer`);
      assert.equal(await door.coll(S, family).countDocuments({ _id: BIG_ID }), 0, `${family}: a malformed fork row was stored`);
    }
  });

  it('PIN: single push of a megabyte string seq answers a bounded 400', async () => {
    const { result: r } = await boundedLinesDuring(() => door.push('/facts', build.fact(S, 'flood-single', BIG_SEQ), { spaceId: S }));
    assert.equal(r.code, 400, JSON.stringify(r.body).slice(0, 300));
    assertBoundedAnswer(r.body, 'the single push 400');
  });

  it('an import of a megabyte seq and a megabyte _id: the result and the lines are bounded', async () => {
    const { importDocuments } = await import('../../server/dist/sync/space-import.js');
    const payload = { facts: [build.fact(S, 'flood-import', BIG_SEQ), build.fact(S, BIG_ID, MAX_INGEST_SEQ + 1)] };
    const { lines, result } = await boundedLinesDuring(() => importDocuments(S, payload));
    assert.equal(result.results.facts.errors, 2, `fixture check: the import did not refuse both: ${JSON.stringify(result.results.facts).slice(0, 300)}`);
    assert.ok(lines.some(l => l.includes('flood-import')), 'fixture check: the refusal was not logged at all');
    assertBoundedAnswer(result, 'the import result');
  });
});

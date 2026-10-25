/**
 * The scan that sees what the vector index has not.
 *
 * `matchFreshWrites` is the half of `checkDuplicates` that reads the COLLECTION. It exists because every
 * path through `$vectorSearch` inherits the index's lag — including `exact: true`, which is an exhaustive
 * scan of the index rather than of the collection. Measured on this stack: ANN first saw a fresh write
 * after 1088 ms, ENN after 1083 ms.
 *
 * Two things need pinning, and only a real database can pin either.
 *
 *  1. **The score.** The pipeline computes `dot` and the document's norm in MQL; JS maps those through
 *     `atlasScoreFromParts`. That split only holds while the MQL arithmetic agrees with the JS arithmetic,
 *     and no fixture can check that — a hand-written expectation would just be the same belief twice.
 *  2. **The bounds.** A scan on a write path that is not bounded is a production incident waiting for a
 *     large space. The window and the cap are the bounds, and both are only observable against real data.
 *
 * No vector index and no embedding server here: this path uses neither, and a test that stood one up would
 * be slower and would say less.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/fresh-writes-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const COLL = `${SPACE}_entities`;
const DIMS = 16;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-fresh-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let mongo, fresh, score, FRESH_WINDOW_MS, FRESH_SCAN_CAP;

/** Deterministic pseudo-random vectors: reproducible failures, and no accidental structure. */
const vec = (seed, dims = DIMS) => {
  const out = new Array(dims);
  let x = seed * 2654435761 % 2147483647;
  for (let i = 0; i < dims; i++) { x = (x * 1103515245 + 12345) % 2147483648; out[i] = (x / 2147483648) - 0.5; }
  return out;
};

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const agoIso = (ms) => new Date(NOW - ms).toISOString();

/** Insert straight into the collection: the scan reads documents, so documents are what it needs. */
const put = async (id, seq, embedding, ageMs = 1000) => {
  await mongo.col(COLL).insertOne({
    // `pos` is where the record landed (a carried row's position is its seq): the scan reads the NEWEST landings, by position (bundle-81).
    _id: id, spaceId: SPACE, name: id, type: 'machine', seq, pos: seq, posAtSeq: seq,
    ...(embedding === null ? {} : { embedding }),
    createdAt: agoIso(ageMs), updatedAt: agoIso(ageMs),
  });
};

describe('scoring the records the index has not ingested', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('freshwrites');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    fresh = await import('../../server/dist/brain/fresh-writes.js');
    ({ FRESH_WINDOW_MS, FRESH_SCAN_CAP } = fresh);
    ({ atlasVectorScore: score } = await import('../../server/dist/brain/vector-score.js'));
    await mongo.col(COLL).createIndex({ pos: 1, _id: 1 });
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await mongo.col(COLL).deleteMany({}); });

  it('reproduces the JS score for every document it returns', async () => {
    // THE load-bearing case. If MQL and JS ever compute these differently, the duplicate threshold means
    // something different depending on which half of the check found the record — and nothing else in the
    // system would notice.
    for (let i = 0; i < 12; i++) await put(`e-${i}`, i, vec(i + 1));
    const q = vec(999);

    const rows = await fresh.matchFreshWrites(COLL, q, NOW);
    assert.equal(rows.length, 12);

    for (const r of rows) {
      const doc = await mongo.col(COLL).findOne({ _id: r._id });
      const expected = score(doc.embedding, q, 'cosine');
      assert.ok(Math.abs(r.score - expected) < 1e-9,
        `${r._id}: pipeline said ${r.score}, JS says ${expected} — the MQL arithmetic has drifted from the JS`);
    }
  });

  it('scores an exact copy at 1 and an orthogonal record at 0.5', async () => {
    // The endpoints of the cosine mapping, so a wrong-but-monotonic formula cannot pass the case above by
    // agreeing with itself.
    const q = vec(7);
    const orth = new Array(DIMS).fill(0);
    orth[0] = q[1]; orth[1] = -q[0];      // perpendicular to q in the first two components
    await put('twin', 1, [...q]);
    await put('perp', 2, orth);

    const byId = new Map((await fresh.matchFreshWrites(COLL, q, NOW)).map(r => [r._id, r.score]));
    assert.ok(Math.abs(byId.get('twin') - 1) < 1e-9, `an identical vector should score 1, got ${byId.get('twin')}`);
    assert.ok(Math.abs(byId.get('perp') - 0.5) < 1e-9, `an orthogonal vector should score 0.5, got ${byId.get('perp')}`);
  });

  it('ignores a record written before the window', async () => {
    await put('inside', 1, vec(1), FRESH_WINDOW_MS - 5_000);
    await put('outside', 2, vec(2), FRESH_WINDOW_MS + 5_000);

    const ids = (await fresh.matchFreshWrites(COLL, vec(999), NOW)).map(r => r._id);
    assert.deepEqual(ids, ['inside'],
      'the window is what keeps this off the critical path of a quiet space — without it every duplicate '
      + 'check pays for the newest FRESH_SCAN_CAP records forever');
  });

  it('caps the scan, and keeps the NEWEST records when it does', async () => {
    // Ordered by seq so the cap drops the oldest. A cap that dropped an arbitrary subset would still
    // satisfy a length assertion while checking the wrong records.
    const extra = 25;
    for (let i = 0; i < FRESH_SCAN_CAP + extra; i++) await put(`e-${i}`, i, vec(i + 1));

    const rows = await fresh.matchFreshWrites(COLL, vec(999), NOW);
    assert.equal(rows.length, FRESH_SCAN_CAP);

    const seqOf = id => Number(id.slice(2));
    const lowest = Math.min(...rows.map(r => seqOf(r._id)));
    assert.equal(lowest, extra, `the cap must drop the oldest ${extra}, not an arbitrary ${extra}`);
  });

  it('skips a record with no embedding rather than treating it as distant', async () => {
    // Two ways to have none: still queued for embedding, or excluded from vector search on purpose.
    // Either way it has no measurable similarity, and inventing one would be worse than omitting it.
    await put('vectorless', 1, null);
    await put('embedded', 2, vec(2));

    const ids = (await fresh.matchFreshWrites(COLL, vec(999), NOW)).map(r => r._id);
    assert.deepEqual(ids, ['embedded']);
  });

  it('skips a record embedded at a different width', async () => {
    // A corpus mid-migration between embedding models holds both shapes. `$zip` truncates to the shorter
    // input, so without the guard the short vector would be scored against a PREFIX of the query and land
    // at an arbitrary similarity — a wrong number, which is worse than no number.
    await put('narrow', 1, vec(1, DIMS - 4));
    await put('right', 2, vec(2));

    const ids = (await fresh.matchFreshWrites(COLL, vec(999), NOW)).map(r => r._id);
    assert.deepEqual(ids, ['right']);
  });

  it('returns nothing, rather than throwing, when the collection does not exist', async () => {
    // It sits on a write path. Every caller already holds the index result, so a failure here has to
    // degrade to the previous behaviour and never to a failed write.
    assert.deepEqual(await fresh.matchFreshWrites(`${SPACE}_nonexistent`, vec(1), NOW), []);
  });

  it('returns nothing for an empty query vector', async () => {
    await put('e-1', 1, vec(1));
    assert.deepEqual(await fresh.matchFreshWrites(COLL, [], NOW), []);
  });
});

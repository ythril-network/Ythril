/**
 * The one by-id reader (`db/read-by-id.ts`) keeps the guards a hand-written copy drops (`Q-211`).
 *
 * Every `_id: { $in }` read in the tree now goes through `readStoredById` / `readRowsById`
 * (`a-record-is-read-by-id-through-one-reader.test.js` holds that), so what this module guarantees is what every
 * one of those reads guarantees. Each case is one guard:
 *
 * - **A predicate narrows, it never replaces.** `walk-reads.ts readRecordsById` SPREAD its `extra` beside `_id`, so
 *   an `extra` naming `_id` replaced the id restriction and the read returned a record nobody asked for. The reader
 *   ANDs every predicate; `readRecordsById` now delegates to it.
 * - **Chunked, and the caller's order across chunks.** More ids than two `READ_CHUNK`s come back whole, each id
 *   once, in the order the caller named them, whatever chunk or index plan each row came from.
 * - **The deadline reaches every chunk.** A spent deadline throws rather than reading unbounded; a live one is
 *   asked once per chunk.
 * - **`'all'` never returns a never-returned field**, and an inclusion returns only what it names, plus `_id`.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/the-by-id-reader-keeps-its-guards-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-by-id-guards-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const COLL = 'byidguards_facts';
const N = 1_111;
const id = n => `f-${String(n).padStart(5, '0')}`;
const ROWS = Array.from({ length: N }, (_, i) => ({
  _id: id(i), spaceId: i % 3 === 0 ? 'other' : 'mine', fact: `fact ${i}`, seq: i + 1,
  embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: `fact ${i}`,
}));

let mongo, reader, walkReads, NEVER_RETURNED_FIELDS;

describe('the by-id reader keeps its guards', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('by-id-reader-guards');
    reader = await import('../../server/dist/db/read-by-id.js');
    walkReads = await import('../../server/dist/brain/walk-reads.js');
    ({ NEVER_RETURNED_FIELDS } = await import('../../server/dist/brain/recall-shape.js'));
    assert.ok(N > 2 * reader.READ_CHUNK, `the fixture must cross more than two reader chunks (${reader.READ_CHUNK})`);
    await mongo.col(COLL).insertMany(ROWS.map(d => ({ ...d })));
  });
  after(async () => {
    await closeTestMongo();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a predicate naming _id narrows the ids asked for, never replaces them', async () => {
    const asked = [id(1), id(2)];
    // The Map, not the rows: `readRowsById` lists only ids the caller named, which would hide a replaced restriction.
    const read = await reader.readStoredById(COLL, asked, { seq: 1 }, { filter: { _id: id(500) } });
    assert.deepEqual([...read.keys()], [], 'a predicate on an id NOT asked for returned it: the restriction was replaced');
    const narrowed = await reader.readStoredById(COLL, asked, { seq: 1 }, { filter: { _id: id(2) } });
    assert.deepEqual([...narrowed.keys()], [id(2)]);
  });

  it('readRecordsById: an extra naming _id narrows, never replaces (it used to spread)', async () => {
    const rows = await walkReads.readRecordsById(COLL, [id(1), id(2)], { _id: id(500) });
    assert.deepEqual(rows.map(r => r._id), [], 'readRecordsById returned a record whose id it was never handed');
  });

  it('several predicates are all held, two on one key included', async () => {
    const asked = ROWS.slice(0, 30).map(r => r._id);
    const rows = await reader.readRowsById(COLL, asked, { spaceId: 1, seq: 1 },
      { filter: [{ spaceId: 'mine' }, { seq: { $gte: 3 } }, { seq: { $lte: 10 } }] });
    assert.deepEqual(rows.map(r => r._id),
      ROWS.slice(2, 10).filter(r => r.spaceId === 'mine').map(r => r._id),
      'a later predicate on the same key replaced an earlier one');
  });

  it('more ids than two chunks come back whole, each once, in the caller\'s order', async () => {
    const asked = [...ROWS].reverse().map(r => r._id);
    asked.splice(3, 0, 'missing-a');
    asked.push(asked[10]);   // a repeat, after its first mention: the row stays where it was first named
    const rows = await reader.readRowsById(COLL, asked, { seq: 1 });
    assert.deepEqual(rows.map(r => r._id), [...ROWS].reverse().map(r => r._id));
    const map = await reader.readStoredById(COLL, asked, { seq: 1 });
    assert.equal(map.size, N);
    assert.ok(map instanceof Map);
  });

  it('the deadline is asked before every chunk, and a spent one throws rather than reading unbounded', async () => {
    let asked = 0;
    await reader.readStoredById(COLL, ROWS.map(r => r._id), { seq: 1 }, { timeLeft: () => { asked++; return 30_000; } });
    assert.equal(asked, Math.ceil(N / reader.READ_CHUNK), 'every chunk must take its bound from the deadline');
    await assert.rejects(
      reader.readStoredById(COLL, ROWS.map(r => r._id), { seq: 1 }, { timeLeft: () => { throw new Error('deadline spent'); } }),
      /deadline spent/);
  });

  it('\'all\' returns every field but the never-returned ones; an inclusion returns what it names and _id', async () => {
    const [all] = await reader.readRowsById(COLL, [id(4)], 'all');
    for (const f of NEVER_RETURNED_FIELDS) assert.ok(!(f in all), `'all' returned the never-returned field ${f}`);
    assert.equal(all.fact, 'fact 4');
    const [some] = await reader.readRowsById(COLL, [id(4)], { seq: 1 });
    assert.deepEqual(some, { _id: id(4), seq: 5 });
  });

  it('a read inside a session reads through it', async () => {
    const session = mongo.getMongo().startSession();
    try {
      const rows = await reader.readRowsById(COLL, ROWS.slice(0, 600).map(r => r._id), { seq: 1 }, { session });
      assert.equal(rows.length, 600);
    } finally {
      await session.endSession();
    }
  });
});

/**
 * A restore makes the database EQUAL the backup — not the backup laid over whatever was there (bundle-157, Q-554).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * `restoreDatabase` drops a collection before reloading it, so a collection the backup held WITH records comes back exactly. Two
 * kinds of collection escaped that:
 *
 * - one the dump recorded as EMPTY is only created (`db/restore.ts`, the `expectedCount === 0` branch), never dropped — what arrived
 *   after the backup stays in it;
 * - one the dump does not name at all (a space created after the backup) is never touched — its records stay.
 *
 * And `ythril_counters` is one collection like any other, so a space the backup did not hold keeps its records, and a space the
 * backup held gets the backup's counter back BELOW the seqs of the records that stayed: the next write takes a seq that is already
 * stored. Nothing errors; the database is a mix of two moments and every seq-paged reader of it is wrong.
 *
 * ## What is asserted, by identity
 *
 * Seed space `s1` (facts seq 1-3, entities present and EMPTY, counter 3), dump, then write `e5` at seq 5 into s1's empty entities
 * and `f4`, create space `s2` (facts `g1`@1, counter 1), and restore over the live database. Afterwards:
 *
 * - s1's facts are exactly f1..f3 (f4 gone) and s1's entities are exactly nothing (e5 gone);
 * - s2's records are gone (its collections absent or empty; `g1` is in no collection);
 * - EVERY space that holds a seq-carrying record has a counter doc, at or above the highest seq stored in that space.
 *
 * The spaces are DERIVED from the collection names present after the restore, so a third leaking space would still be seen.
 *
 * Run: `node --test testing/standalone/a-restore-makes-the-database-the-backup-db.test.js` (a Mongo the harness accepts; a prior
 * `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const DB = 'ythril_harness_restoreequalsbackup';
const SEQ_PARTS = ['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones'];

let mongo, dir, db;

/** The ids stored in a collection, sorted; [] for a collection that does not exist (absent and empty both mean "nothing there"). */
async function idsIn(name) {
  return (await db.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
}

describe('a restore makes the database the backup', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('restoreequalsbackup');
    db = mongo.getDb();
    const { dumpDatabase } = await import('../../server/dist/db/dump.js');
    const { restoreDatabase } = await import('../../server/dist/db/restore.js');
    const uri = testMongoUri(DB);
    dir = mkdtempSync(join(tmpdir(), 'ythril-restore-equals-'));

    // The backup's moment: s1 holds three facts, an entities collection that is present and EMPTY, and a counter at 3.
    await db.collection('s1_facts').insertMany([1, 2, 3].map(s => ({ _id: `f${s}`, spaceId: 's1', seq: s })));
    await db.createCollection('s1_entities');
    await db.collection('ythril_counters').insertOne({ _id: 's1', seq: 3 });
    const manifest = await dumpDatabase(uri, dir);
    assert.equal(manifest.collections.find(c => c.name === 's1_entities')?.count, 0, 'the fixture is wrong: the backup must record s1_entities as present and empty');

    // After the backup: a record in the collection the backup held empty, one more fact, a whole space the backup never saw.
    await db.collection('s1_facts').insertOne({ _id: 'f4', spaceId: 's1', seq: 4 });
    await db.collection('s1_entities').insertOne({ _id: 'e5', spaceId: 's1', seq: 5 });
    await db.collection('s2_facts').insertOne({ _id: 'g1', spaceId: 's2', seq: 1 });
    await db.collection('ythril_counters').updateOne({ _id: 's1' }, { $set: { seq: 5 } });
    await db.collection('ythril_counters').insertOne({ _id: 's2', seq: 1 });

    await restoreDatabase(uri, dir);
  });

  after(async () => {
    await closeTestMongo();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('control: what the backup held with records comes back exactly (f4, written after it, is gone)', async () => {
    assert.deepEqual(await idsIn('s1_facts'), ['f1', 'f2', 'f3']);
  });

  it('a collection the backup held EMPTY is empty after the restore: e5, written after the backup, is gone', async () => {
    assert.deepEqual(await idsIn('s1_entities'), [], 'a record written after the backup stayed in a collection the backup recorded as empty');
  });

  it('a space the backup did not hold has no records after the restore: g1 is in no collection', async () => {
    const names = (await db.listCollections().toArray()).map(c => c.name);
    const holding = [];
    for (const name of names.filter(n => n.startsWith('s2_'))) if ((await idsIn(name)).includes('g1')) holding.push(name);
    assert.deepEqual(holding, [], `g1, created after the backup, survived the restore in: ${holding.join(', ')}`);
  });

  it('every space that holds a seq-carrying record has a counter at or above its highest stored seq', async () => {
    const names = (await db.listCollections().toArray()).map(c => c.name);
    const spaces = new Set();
    for (const n of names) {
      const m = /^(.+)_([a-z]+)$/.exec(n);
      if (m && SEQ_PARTS.includes(m[2])) spaces.add(m[1]);
    }
    assert.ok(spaces.has('s1'), 'the derivation found no space at all: the fixture or the collection naming changed');
    const counters = new Map((await db.collection('ythril_counters').find({}).toArray()).map(c => [c._id, c.seq]));
    const failures = [];
    for (const space of [...spaces].sort()) {
      let highest = 0; let stored = 0;
      for (const part of SEQ_PARTS) {
        const docs = await db.collection(`${space}_${part}`).find({ seq: { $type: 'number' } }, { projection: { seq: 1 } }).toArray();
        stored += docs.length;
        for (const d of docs) highest = Math.max(highest, d.seq);
      }
      if (stored === 0) continue;   // a space with no records needs no counter above anything
      if (!counters.has(space)) failures.push(`${space}: records up to seq ${highest} and no counter doc`);
      else if (counters.get(space) < highest) failures.push(`${space}: counter ${counters.get(space)} is below its highest stored seq ${highest}`);
    }
    assert.deepEqual(failures, [], `the next write in these spaces would take a seq already stored: ${failures.join('; ')}`);
  });
});

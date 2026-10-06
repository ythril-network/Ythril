/**
 * A stalled-read fixture stalls the read the code under test makes — or it THROWS (`Q-358`, bundle-53 G25).
 *
 * ## The defect it closes
 *
 * `withStalledReads` makes a view whose read sleeps once per source document. Its docblock said every source document costs a read one
 * sleep *whatever the reader's filter*, and that is false: the server applies the reader's filter before the view's own stage wherever it
 * can (an `_id`, an indexed prefix), so a document the filter excludes never reaches the stall. Three groups met it from the outside, each
 * by finding that a bound test passed over a read that never hung — a reader asking for `{ _id: 'run' }` over seeds named
 * `__stall_seed_n` stalled nothing, and the guard (which read with `{}`) said the view stalled.
 *
 * ## What is held
 *
 * - the guard reads with the READER's filter (`readerFilter`), so a filter that matches nothing the fixture stalls throws, naming it, and
 *   the callback never runs;
 * - `readerFilter` is REQUIRED (bundle-53 G25b): it used to default to `{}`, so a caller that left it out was checked as a reader that asks
 *   for everything, and the guard that exists for this defect was the part a caller could forget. A call without it throws, naming the
 *   view, before anything is seeded; a reader that really asks for everything states `readerFilter: {}`;
 * - `seed` stalls over documents the reader's filter DOES match, and `collapseTo` stalls a reader that names one document;
 * - what the fixture put in the source is removed afterwards, and the view is put back as an ordinary collection, whether it threw or not.
 *
 * Each throw is seen against the exact fixture that used to pass (the default seeds with `{ _id: 'run' }`), so the guard is not asserted
 * only where it was always going to pass.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-stalled-read-guard-sees-the-readers-filter-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import * as faults from './_write-faults.mjs';

const skip = await mongoSkipReason();
const MS = 600;

let mongo;
let db;

/** How long one read of `name` with `filter` takes, ms, and what it found. */
async function timedFind(name, filter) {
  const started = Date.now();
  const rows = await db.collection(name).find(filter).toArray();
  return { ms: Date.now() - started, rows };
}

const kindOf = (name) => async () => (await db.listCollections({ name }).toArray())[0]?.type;

describe('a stalled-read fixture stalls the reader\'s read, or throws', { skip }, () => {
  before(async () => { mongo = await openTestMongo('stallfilter'); db = mongo.getDb(); });
  after(async () => { await closeTestMongo(); });

  it('a reader asking for one _id over the default seeds is refused, naming the filter, and the callback never runs', async () => {
    let ran = false;
    await assert.rejects(
      () => faults.withStalledReads(db, 'sf_view_a', 'sf_src_a', { ms: MS, readerFilter: { _id: 'run' } }, async () => { ran = true; }),
      /reader's filter \{"_id":"run"\}/);
    assert.equal(ran, false, 'the callback ran over a stall the reader\'s own read never meets');
    assert.equal(await db.collection('sf_src_a').countDocuments({}), 0, 'the seeds were left in the source after the throw');
    assert.equal(await kindOf('sf_view_a')(), 'collection', 'the view was not put back as an ordinary collection after the throw');
  });

  it('the same reader is stalled with `collapseTo`: the view answers the one document, after the whole stall', async () => {
    const found = await faults.withStalledReads(db, 'sf_view_b', 'sf_src_b', { ms: MS, readerFilter: { _id: 'run' }, collapseTo: { _id: 'run', f: 1 } }, async () => {
      const read = await timedFind('sf_view_b', { _id: 'run' });
      assert.ok(read.ms >= MS, `the reader's own read took ${read.ms} ms, less than the ${MS} ms stall`);
      return read.rows;
    });
    assert.deepEqual(found, [{ _id: 'run', f: 1 }]);
    assert.equal(await db.collection('sf_src_b').countDocuments({}), 0);
  });

  it('a reader that filters on a field is refused over the default seeds, and stalled over seeds it matches', async () => {
    await assert.rejects(
      () => faults.withStalledReads(db, 'sf_view_c', 'sf_src_c', { ms: MS, readerFilter: { kind: 'x' } }, async () => {}),
      /reader's filter \{"kind":"x"\}/);
    const seed = [{ _id: 'c1', kind: 'x' }, { _id: 'c2', kind: 'x' }, { _id: 'c3', kind: 'x' }];
    const read = await faults.withStalledReads(db, 'sf_view_c', 'sf_src_c', { ms: MS, readerFilter: { kind: 'x' }, seed },
      () => timedFind('sf_view_c', { kind: 'x' }));
    assert.ok(read.ms >= MS, `the reader's own read took ${read.ms} ms, less than the ${MS} ms stall`);
    assert.equal(read.rows.length, 3);
    assert.equal(await db.collection('sf_src_c').countDocuments({}), 0, 'the seeds this fixture was given were not removed');
  });

  it('a seed of one document is refused: the server interrupts a read between documents, so one cannot be ended by maxTimeMS', async () => {
    await assert.rejects(
      () => faults.withStalledReads(db, 'sf_view_d', 'sf_src_d', { ms: MS, readerFilter: {}, seed: [{ _id: 'only' }] }, async () => {}),
      /at least 2 documents/);
  });

  it('a reader that asks for everything says so (`readerFilter: {}`), and is stalled over the default seeds', async () => {
    const read = await faults.withStalledReads(db, 'sf_view_e', 'sf_src_e', { ms: MS, readerFilter: {} }, () => timedFind('sf_view_e', {}));
    assert.ok(read.ms >= MS, `the read took ${read.ms} ms, less than the ${MS} ms stall`);
  });

  it('a call with NO readerFilter is refused, naming the collection it was for: the guard is not a thing a caller can leave out', async () => {
    let ran = false;
    await assert.rejects(
      () => faults.withStalledReads(db, 'sf_view_f', 'sf_src_f', { ms: MS }, async () => { ran = true; }),
      (err) => /readerFilter/.test(err.message) && /sf_view_f/.test(err.message),
      'a stall with no stated reader was accepted, or refused without saying which collection it was for');
    assert.equal(ran, false, 'the callback ran over a stall nobody checked the reader against');
    assert.equal(await db.collection('sf_src_f').countDocuments({}), 0, 'the refusal came after seeding: the source was left holding documents');
    assert.equal(await kindOf('sf_view_f')(), undefined, 'the refusal came after the view was made');
  });

  it('a readerFilter that is not a plain object is refused the same way (an absent filter must not be spelt as a different nothing)', async () => {
    for (const readerFilter of [null, undefined, 'run', ['run'], 0]) {
      let ran = false;
      await assert.rejects(
        () => faults.withStalledReads(db, 'sf_view_g', 'sf_src_g', { ms: MS, readerFilter }, async () => { ran = true; }),
        (err) => /readerFilter/.test(err.message) && /sf_view_g/.test(err.message),
        `readerFilter ${JSON.stringify(readerFilter)} was accepted`);
      assert.equal(ran, false);
    }
  });
});

/**
 * The stray file-metadata drain walks every space on its own, and each of its steps is bounded and named — `Q-274`,
 * `Q-358`, bundle-53 G12.
 *
 * ## What it holds
 *
 * The drain (`sync/stray-filemeta-drain.ts`, `Q-219`) recovers `<space>_filemeta` into `<space>_files` and drops the stray
 * collection. Its work per space is five steps — LIST the collection, READ a page, WRITE it through the arrival writer,
 * SETTLE what was answered, DROP the collection once empty — and before this bundle:
 *
 *  - a space whose read HUNG held the drain, and with it the sweep cycle, until the driver gave up;
 *  - the two calls on the `Db` itself (`listCollections`, `dropCollection`) sat outside the one write bound, the drop
 *    even after its scope had closed, so a stuck drop was unbounded;
 *  - the failure line carried a hand-written `warnOnce` throttle of its own.
 *
 * So each case below makes ONE space fail at ONE step, sits it BEFORE the healthy space in the config (a walk that stops at
 * the first failure leaves exactly the spaces after it undrained) and holds: the failing space's collection is kept, one
 * line names the step and says when it is retried, the healthy space is drained, and the next cycle completes the failed
 * one. The hung case ends at the housekeeping bound. The two `Db`-level calls are asserted to carry the bound on the
 * command the proxy hands the driver: a recording patch of `Db.prototype`, because no fixture can stall `listCollections`
 * on the server (`P8`), so the figure it carries is the claim.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-stray-drain-ends-a-hung-space-and-goes-on-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { failWrites, setWriteBoundForTest, settleWithin, withCollectionAsView, withStalledReads } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const SUITE = 'strayhk';
const LOCAL = { instanceId: `${SUITE}-receiver`, instanceLabel: 'Receiver' };
const PEER = { instanceId: 'stray-hk-peer', instanceLabel: 'Peer' };
const STAMPED_AT = '2025-01-01T00:00:00.000Z';
/** One faulty space per step, each armed by exactly one case, all BEFORE the healthy one in the config. */
const LIST = 'hk-list';
const READ = 'hk-read';
const WRITE = 'hk-write';
const SETTLE = 'hk-settle';
const DROP = 'hk-drop';
const HUNG = 'hk-hung';
const HEALTHY = 'hk-healthy';
const BOUND_MS = 1_000;
const STEP = 'Stray file-metadata drain';

let door, drainStrayFileMeta, dbProto, restoreBound;
const originals = {};
/** Every `Db`-level call the drain made, with the `maxTimeMS` it reached the driver carrying. */
const seen = { listCollections: [], dropCollection: [] };
/** The collections whose `Db`-level call is made to throw, per method. */
const failing = { listCollections: new Set(), dropCollection: new Set() };

const stored = (space, id) => door.coll(space, 'files').findOne({ _id: id });
// Through the driver's own method, never the recording patch: this question is the test's, and a listing armed to fail must not fail it.
const strayExists = async (space) =>
  (await originals.listCollections.call(door.mongo.getDb(), { name: `${space}_filemeta` }).toArray()).length > 0;
/** The file row this instance made by default, and the stray record a 4.0-5.6.1 pull stored for it. */
const row = (space, id) => build.filemeta(space, id, 900, { author: LOCAL, createdAt: STAMPED_AT, updatedAt: STAMPED_AT, sizeBytes: 11, sha256: 'receiver-hash' });
const stray = (space, id) => ({ ...build.filemeta(space, id, 20, { author: PEER }), sizeBytes: 999, sha256: 'sender-hash', description: `recovered for ${id}`, tags: ['t'] });
const lineFor = (lines, sub, space) => lines.filter(l => l.includes(`${STEP} (${sub}) failed for space '${space}'`));

/** Seed the healthy space afresh: it is drained by every case and must be there for the next. */
async function seedHealthy() {
  await door.coll(HEALTHY, 'files').deleteMany({});
  await door.mongo.getDb().collection(`${HEALTHY}_filemeta`).drop().catch(() => {});
  await door.coll(HEALTHY, 'files').insertOne(row(HEALTHY, 'ok.md'));
  await door.coll(HEALTHY, 'filemeta').insertOne(stray(HEALTHY, 'ok.md'));
}
async function assertHealthyDrained(dropped) {
  assert.equal((await stored(HEALTHY, 'ok.md'))?.description, 'recovered for ok.md',
    'the healthy space sits after the faulty one in the config and was not drained: the walk stopped at the first failure');
  assert.equal(await strayExists(HEALTHY), false, 'and its stray collection is still there');
  assert.ok(dropped.includes(HEALTHY), `the drain says it dropped the healthy space's collection: ${JSON.stringify(dropped)}`);
}

describe('the stray file-metadata drain walks each space on its own, bounded, naming the step that failed', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [LIST, READ, WRITE, SETTLE, DROP, HUNG, HEALTHY].map(id => ({ id, label: id, folders: [] })) });
    ({ drainStrayFileMeta } = await import('../../server/dist/sync/stray-filemeta-drain.js'));
    const { Db } = await import('mongodb');
    // The driver's `Db` this process's server code runs on: a different copy would be patched for nothing.
    assert.ok(door.mongo.getDb() instanceof Db, 'the `mongodb` this test imports is not the one the server runs on: the recording patch would record nothing');
    dbProto = Db.prototype;
    originals.listCollections = dbProto.listCollections;
    originals.dropCollection = dbProto.dropCollection;
    dbProto.listCollections = function recording(filter, options, ...rest) {
      seen.listCollections.push({ name: filter?.name, maxTimeMS: options?.maxTimeMS });
      if (failing.listCollections.has(filter?.name)) throw new Error(`listing ${filter.name} failed`);
      return originals.listCollections.call(this, filter, options, ...rest);
    };
    dbProto.dropCollection = function recording(name, options, ...rest) {
      seen.dropCollection.push({ name, maxTimeMS: options?.maxTimeMS });
      if (failing.dropCollection.has(name)) return Promise.reject(new Error(`dropping ${name} failed`));
      return originals.dropCollection.call(this, name, options, ...rest);
    };
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
  });
  after(async () => {
    restoreBound?.();
    if (dbProto) { dbProto.listCollections = originals.listCollections; dbProto.dropCollection = originals.dropCollection; }
    await door?.close();
  });
  beforeEach(async () => {
    failing.listCollections.clear();
    failing.dropCollection.clear();
    await seedHealthy();   // its own `collection.drop()` goes through `Db.dropCollection` too, unbounded: not the drain's call
    seen.listCollections.length = 0;
    seen.dropCollection.length = 0;
  });

  it('a space whose LISTING fails keeps its collection, is named once under `list`, and the next space is drained', async () => {
    await door.coll(LIST, 'files').insertOne(row(LIST, 'l.md'));
    await door.coll(LIST, 'filemeta').insertOne(stray(LIST, 'l.md'));
    failing.listCollections.add(`${LIST}_filemeta`);
    const first = await logLinesDuring(() => drainStrayFileMeta());
    const second = await logLinesDuring(() => drainStrayFileMeta());

    await assertHealthyDrained(first.result);
    assert.equal(await strayExists(LIST), true, 'the space whose listing failed lost its collection');
    const said = lineFor(first.lines, 'list', LIST);
    assert.equal(said.length, 1, `one line, naming the step the failure was in: ${first.lines.join(' | ')}`);
    assert.match(said[0], /retried next cycle/, 'and when it is tried again');
    assert.equal(lineFor(second.lines, 'list', LIST).length, 0, 'a failure that repeats is a rate, not a line, inside the reporter\'s window');

    failing.listCollections.clear();
    const next = await drainStrayFileMeta();
    assert.deepEqual(next, [LIST], 'the next cycle drains the space the listing failed for');
    assert.equal((await stored(LIST, 'l.md'))?.description, 'recovered for l.md');
  });

  it('a space whose READ fails keeps its collection and is named once under `read`', async () => {
    const db = door.mongo.getDb();
    await db.collection(`${READ}_filemeta_src`).insertOne({ _id: 'r.md', f: 'not a number' });   // no `keptSince`: the drain's filter matches it
    let first;
    try {
      await withCollectionAsView(db, `${READ}_filemeta`, `${READ}_filemeta_src`, async () => {
        first = await logLinesDuring(() => drainStrayFileMeta());
      }, { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
    } finally {
      await db.collection(`${READ}_filemeta_src`).drop().catch(() => {});
    }
    await assertHealthyDrained(first.result);
    const said = lineFor(first.lines, 'read', READ);
    assert.equal(said.length, 1, `one line under \`read\`: ${first.lines.join(' | ')}`);
    assert.match(said[0], /retried next cycle/);
  });

  it('a space whose WRITE fails keeps its collection and is named once under `write`', async () => {
    const db = door.mongo.getDb();
    await door.coll(WRITE, 'filemeta').insertOne(stray(WRITE, 'w.md'));
    let first;
    // A view cannot be written: the arrival writer's update of the `files` collection fails.
    await withCollectionAsView(db, `${WRITE}_files`, `${WRITE}_files_source`, async () => {
      first = await logLinesDuring(() => drainStrayFileMeta());
    });
    await assertHealthyDrained(first.result);
    assert.equal(await strayExists(WRITE), true, 'the space whose write failed lost its collection');
    const said = lineFor(first.lines, 'write', WRITE);
    assert.equal(said.length, 1, `one line under \`write\`: ${first.lines.join(' | ')}`);
    assert.match(said[0], /retried next cycle/);
  });

  it('a space whose SETTLE fails keeps its collection and is named once under `settle`', async () => {
    await door.coll(SETTLE, 'files').insertOne(row(SETTLE, 's.md'));
    await door.coll(SETTLE, 'filemeta').insertOne(stray(SETTLE, 's.md'));
    const faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['deleteMany']);
    let first;
    try {
      faults.fail('deleteMany', `${SETTLE}_filemeta`, new Error('the settle delete failed'));
      first = await logLinesDuring(() => drainStrayFileMeta());
    } finally { faults.restore(); }
    await assertHealthyDrained(first.result);
    assert.equal(await strayExists(SETTLE), true, 'the space whose settle failed lost its collection');
    assert.equal((await stored(SETTLE, 's.md'))?.description, 'recovered for s.md', 'the record was written before the settle failed');
    const said = lineFor(first.lines, 'settle', SETTLE);
    assert.equal(said.length, 1, `one line under \`settle\`: ${first.lines.join(' | ')}`);

    const next = await drainStrayFileMeta();
    assert.deepEqual(next, [SETTLE], 'the next cycle settles it again and drops the collection');
  });

  it('a space whose DROP fails keeps its (empty) collection, is named once under `drop`, and the next cycle drops it', async () => {
    await door.coll(DROP, 'files').insertOne(row(DROP, 'd.md'));
    await door.coll(DROP, 'filemeta').insertOne(stray(DROP, 'd.md'));
    failing.dropCollection.add(`${DROP}_filemeta`);
    const first = await logLinesDuring(() => drainStrayFileMeta());

    await assertHealthyDrained(first.result);
    assert.equal(await strayExists(DROP), true, 'the collection a failed drop could not remove is gone');
    assert.equal(first.result.includes(DROP), false, 'the drain reports a drop that did not happen');
    const said = lineFor(first.lines, 'drop', DROP);
    assert.equal(said.length, 1, `one line under \`drop\`: ${first.lines.join(' | ')}`);
    assert.equal(await door.mongo.getDb().collection('audit_log').findOne({ spaceId: DROP, operation: 'file.stray_filemeta.drain' }), null,
      'a drop that did not happen is not audited');

    failing.dropCollection.clear();
    assert.deepEqual(await drainStrayFileMeta(), [DROP], 'the next cycle drops it');
  });

  it('the two `Db`-level calls reach the driver carrying the housekeeping bound', async () => {
    await drainStrayFileMeta();
    const listed = seen.listCollections.filter(c => c.name === `${HEALTHY}_filemeta`);
    const dropped = seen.dropCollection.filter(c => c.name === `${HEALTHY}_filemeta`);
    assert.ok(listed.length > 0 && dropped.length > 0, `the drain made both calls for the healthy space: ${JSON.stringify(seen)}`);
    assert.ok(seen.listCollections.length >= 7, `and listed every space: ${JSON.stringify(seen.listCollections)}`);
    for (const c of seen.listCollections) {
      assert.equal(c.maxTimeMS, BOUND_MS, `the listing of ${c.name} reached the driver with no bound: it can hang the cycle`);
    }
    for (const c of dropped) {
      assert.equal(c.maxTimeMS, BOUND_MS, `the drop of ${c.name} reached the driver with no bound (it ran after its scope had closed)`);
    }
  });

  it('a space whose READ hangs ends at the housekeeping bound, is reported once, and the next space is drained', async () => {
    const db = door.mongo.getDb();
    let outcome, lines;
    // The stall costs a sleep per source document the reader's filter lets through. The drain's first read is the fresh records, those
    // with no `keptSince` (`drainSpace`, `sync/stray-filemeta-drain.ts`), which the fixture's default seeds (`{ _id }` only) are.
    await withStalledReads(db, `${HUNG}_filemeta`, `${HUNG}_filemeta_src`, { ms: 3_000, readerFilter: { keptSince: { $exists: false } } }, async () => {
      ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(drainStrayFileMeta(), 2_800)));
      // Left unsettled, the stall's own end is waited for before the view is put back.
      if (!outcome.settled) await outcome.rest;
    });

    assert.ok(outcome.settled, `the drain was still waiting after ${outcome.elapsedMs}ms on a read that stalls for 3000ms: nothing ended it at the ${BOUND_MS}ms bound`);
    assert.equal(outcome.ok, true, `the drain returns for a hung space: ${outcome.error}`);
    await assertHealthyDrained(outcome.value);
    const said = lineFor(lines, 'read', HUNG);
    assert.equal(said.length, 1, `reported once, under \`read\`: ${lines.join(' | ')}`);
    assert.match(said[0], new RegExp(`time bound of ${BOUND_MS} ms`), 'in the words of the bound it ran into');
  });
});

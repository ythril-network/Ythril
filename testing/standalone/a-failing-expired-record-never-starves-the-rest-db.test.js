/**
 * A record that keeps failing to delete cannot starve the records behind it, and a collection whose read fails does not stop
 * the collections after it (`Q-359`, `Q-274`; bundle-53 G10). Against the real store, through the real sweep.
 *
 * ## The defect it prevents
 *
 * The TTL sweep read ONE page of 500 expired ids per collection per cycle and deleted them in order. When the head page's deletes
 * all failed (a refused write, a record the deleter could not remove), nothing was deleted, the next cycle read the same
 * page, and every expired record behind it waited for ever - with one log line per failed record every cycle. A read that
 * failed was swallowed as "the collection may not exist yet", so a collection whose read failed was never said.
 *
 * ## What is held
 *
 *  - 1 200 expired facts, the first 500 deletes refused: ONE cycle deletes the 500 behind the head (the throttle), leaves the
 *    failing 500, sweeps the other collection and the other space, says ONE line with `count: 500` and at most five ids that
 *    are still stored, and counts 500 records on `records-failed`;
 *  - two more cycles drain the rest (500, then 200), nothing counted twice, and no further failure line;
 *  - an expired record whose stored `spaceId` is another space's (the deleter answers false, the record is still there) ends
 *    the collection and is reported ONCE with its count, across two cycles;
 *  - a collection whose READ fails is reported under its own step, once, and the collections after it are still swept.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-expired-record-never-starves-the-rest-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { failWrites, withCollectionAsView } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const SUITE = 'ttlstarve';
const A = 'ttl-a';
const B = 'ttl-b';
const C = 'ttl-c';
const D = 'ttl-d';
const PAST = new Date('2020-01-01T00:00:00Z');
const HEAD = 500;
const TOTAL = 1200;

let door; let sweepExpired; let faults; let logMod; let signals;
const lines = [];
const restoreLog = [];

const factId = (i) => `fact-${String(i).padStart(4, '0')}`;
const factDoc = (space, id, extra = {}) => ({ _id: id, spaceId: space, content: `expired ${id}`, seq: 1, createdAt: '2020-01-01T00:00:00.000Z', _expireAt: PAST, ...extra });
const count = (space, part) => door.coll(space, part).countDocuments({});
const linesFor = (step, space) => lines.filter((l) => l.startsWith(`${step} failed for space '${space}'`));
const recordsFailed = (step) => signals.filter((s) => s.type === 'records-failed' && s.step === step).reduce((n, s) => n + s.count, 0);

describe('a failing expired record never starves the rest', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [A, B, C, D].map((id) => ({ id, label: id, folders: [] })) });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));
    logMod = await import('../../server/dist/util/log.js');
    const { onHousekeepingSignal } = await import('../../server/dist/util/housekeeping-signals.js');
    signals = [];
    restoreLog.push(onHousekeepingSignal((e) => signals.push(e)));
    for (const level of ['info', 'warn', 'error']) {
      const orig = logMod.log[level];
      logMod.log[level] = (m, ...rest) => { lines.push(String(m)); return orig(m, ...rest); };
      restoreLog.push(() => { logMod.log[level] = orig; });
    }
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['deleteOne']);
  });
  after(async () => {
    faults?.restore();
    for (const undo of restoreLog) undo();
    await door?.close();
  });

  it('one cycle deletes the 500 behind a failing head of 500, and says ONE line for the 500', { timeout: 300_000 }, async () => {
    await door.coll(A, 'facts').insertMany(Array.from({ length: TOTAL }, (_, i) => factDoc(A, factId(i))));
    await door.coll(A, 'entities').insertMany([0, 1, 2].map((i) => ({ _id: `ent-${i}`, spaceId: A, name: `e${i}`, type: 'thing', seq: 1, _expireAt: PAST })));
    await door.coll(B, 'facts').insertMany([0, 1, 2].map((i) => factDoc(B, `b-fact-${i}`)));
    faults.fail('deleteOne', `${A}_facts`, new Error('simulated: the delete was refused'), { times: HEAD });

    const deleted = await sweepExpired(new Date());

    const left = await door.coll(A, 'facts').find({}, { projection: { _id: 1 } }).toArray();
    assert.equal(left.length, TOTAL - HEAD, 'the failing head stays, the 500 behind it went, 200 wait behind the throttle');
    assert.equal(deleted, HEAD + 3 + 3, '500 facts, the other collection and the other space');
    assert.equal(await count(A, 'entities'), 0, 'the other collection of the same space was swept');
    assert.equal(await count(B, 'facts'), 0, 'the other space was swept');

    const said = linesFor('TTL sweep: facts delete', A);
    assert.equal(said.length, 1, `one line for 500 failed records, got ${said.length}: ${said.slice(0, 2).join(' | ')}`);
    assert.match(said[0], /\(count: 500\)/);
    const sampled = said[0].match(/fact-\d{4}/g) ?? [];
    assert.ok(sampled.length >= 1 && sampled.length <= 5, `${sampled.length} sample ids: ${said[0]}`);
    const stillStored = new Set(left.map((d) => d._id));
    for (const id of sampled) assert.ok(stillStored.has(id), `${id} is named as failing but it was deleted`);
    assert.equal(recordsFailed('TTL sweep: facts delete'), HEAD, 'the counter moves by the records, not by the line');
  });

  it('two more cycles drain the rest: 500 then 200, nothing counted twice, nothing said again', { timeout: 300_000 }, async () => {
    faults.clear();
    const linesBefore = lines.length;
    const second = await sweepExpired(new Date());
    assert.equal(second, 500);
    assert.equal(await count(A, 'facts'), 200);
    const third = await sweepExpired(new Date());
    assert.equal(third, 200);
    assert.equal(await count(A, 'facts'), 0);
    assert.equal(lines.slice(linesBefore).filter((l) => /TTL sweep: facts delete failed/.test(l)).length, 0);
    assert.equal(recordsFailed('TTL sweep: facts delete'), HEAD);
  });

  it('a record stored under another space id (the deleter answers false) ends the collection and is said once across cycles', { timeout: 120_000 }, async () => {
    await door.coll(C, 'facts').insertMany([
      ...[0, 1, 2, 3, 4].map((i) => factDoc(C, `c-fact-${i}`)),
      factDoc('someone-else', 'c-foreign'),
    ]);
    const first = await sweepExpired(new Date());
    assert.equal(first, 5, 'the five records of this space were deleted');
    assert.deepEqual((await door.coll(C, 'facts').find({}).toArray()).map((d) => d._id), ['c-foreign']);
    const said = linesFor('TTL sweep: facts delete', C);
    assert.equal(said.length, 1);
    assert.match(said[0], /\(count: 1\)/);
    assert.match(said[0], /no record of this space matched/);
    const second = await sweepExpired(new Date());
    assert.equal(second, 0);
    assert.equal(linesFor('TTL sweep: facts delete', C).length, 1, 'the same record is not said again inside the window');
  });

  it('a collection whose READ fails is said under its own step, once, and the collections after it are still swept', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await db.collection(`${D}_edges_src`).insertOne({ _id: 'bad', _expireAt: PAST, field: 'not a number' });
    await door.coll(D, 'chrono').insertOne({ _id: 'chrono-1', spaceId: D, type: 'event', seq: 1, _expireAt: PAST, createdAt: '2020-01-01T00:00:00.000Z' });
    await door.coll(D, 'facts').insertOne(factDoc(D, 'd-fact'));
    await withCollectionAsView(db, `${D}_edges`, `${D}_edges_src`, async () => {
      await sweepExpired(new Date());
      await sweepExpired(new Date());
    }, { pipeline: [{ $addFields: { _x: { $toInt: '$field' } } }] });

    assert.equal(await count(D, 'facts'), 0, 'the collection before the failing one was swept');
    assert.equal(await count(D, 'chrono'), 0, 'the collection after the failing one was swept');
    const said = linesFor('TTL sweep: edges', D);
    assert.equal(said.length, 1, `the read failure is said once across two cycles, got ${said.length}`);
    assert.match(said[0], /\(edges\)/);
  });
});

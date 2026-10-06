/**
 * A record whose delete fails does not head every retention cycle (`Q-359`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * The TTL sweep read the first 500 expired ids of a collection and tried each. A record whose delete threw stayed expired, so it was
 * in the first 500 again next cycle: with 500 such records at the head, every cycle read the same 500, failed the same 500, and
 * deleted nothing, for ever — while every expired record behind them was kept past its window, the retention an operator configured.
 * Each failure was also one log line per record per cycle, five hundred identical lines every five minutes.
 *
 * ## What is held
 *
 *  - a cycle reads PAST the ids it already attempted (`_id: { $nin: attempted }`), so the records behind a stuck head are deleted;
 *  - a cycle stops at 500 deletions per collection, and at 2000 attempts, so a collection of stuck records costs a bounded pass;
 *  - the records that could not be deleted are said ONCE per collection and cycle, with their count, not once each.
 *
 * ## How
 *
 * The real sweep (`sweepExpired`) against the harness Mongo, with `deleteOne` on one space's facts refused for the stuck ids: the
 * driver's own throw, from the first thing `deleteFact` does to the record. The stuck records expire EARLIER than the healthy ones,
 * so they are first in the sweep's read whichever plan the store picks.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-retention-cycle-reads-past-a-record-that-cannot-be-deleted-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const SPACE = 'ttl-stuck';
const NOW = new Date('2026-10-01T00:00:00.000Z');

describe('a record whose delete fails does not stop the retention cycle behind it', { skip }, () => {
  let door; let sweepExpired; let proto; let realDeleteOne;
  let attempts = 0;

  const expired = (id, year) => build.fact(SPACE, id, 1, { _expireAt: new Date(`${year}-01-01T00:00:00.000Z`) });
  const seed = async (stuck, healthy) => {
    const rows = [];
    for (let i = 0; i < stuck; i++) rows.push(expired(`stuck-${String(i).padStart(5, '0')}`, 2019));
    for (let i = 0; i < healthy; i++) rows.push(expired(`ok-${String(i).padStart(5, '0')}`, 2020));
    if (rows.length > 0) await door.coll(SPACE, 'facts').insertMany(rows);
  };
  const remaining = (prefix) => door.coll(SPACE, 'facts').countDocuments({ _id: { $regex: `^${prefix}-` } });

  before(async () => {
    door = await openPushDoor({ suite: 'ttlstuck', spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    realDeleteOne = proto.deleteOne;
    proto.deleteOne = function refusing(filter, ...rest) {
      if (this.collectionName === `${SPACE}_facts` && String(filter?._id ?? '').startsWith('stuck-')) {
        attempts++;
        return Promise.reject(new Error('delete refused: simulated store failure'));
      }
      return realDeleteOne.call(this, filter, ...rest);
    };
  });
  after(async () => {
    if (proto && realDeleteOne) proto.deleteOne = realDeleteOne;
    await door?.close();
  });
  beforeEach(async () => {
    attempts = 0;
    await door.coll(SPACE, 'facts').deleteMany({});
  });

  it('a record whose delete fails at the head does not keep the expired records behind it', { timeout: 120_000 }, async () => {
    await seed(520, 5);
    const { result: deleted } = await logLinesDuring(() => sweepExpired(NOW));
    assert.equal(deleted, 5, 'the five healthy expired records behind 520 stuck ones were not deleted');
    assert.equal(await remaining('ok'), 0, 'expired records are still held past their window');
    assert.equal(await remaining('stuck'), 520, 'a record whose delete failed is left as it was');
  });

  it('says the records it could not delete once for the collection, with their count', { timeout: 120_000 }, async () => {
    await seed(520, 5);
    const { lines } = await logLinesDuring(() => sweepExpired(NOW));
    const named = lines.filter(l => /TTL sweep/.test(l) && l.includes(SPACE));
    assert.ok(named.length <= 3, `${named.length} log lines about 520 stuck records: one per record, not one for the collection`);
    const said = lines.filter(l => /could not be deleted/.test(l) && l.includes(SPACE));
    assert.equal(said.length, 1, `one line naming the collection, not one per record (${said.length}): ${said.slice(0, 3).join(' | ')}`);
    assert.match(said[0], /\b520\b/, `the line does not carry the count: ${said[0]}`);
    assert.match(said[0], /facts/, `the line does not name the collection: ${said[0]}`);
  });

  it('stops a cycle at 500 deletions per collection', { timeout: 120_000 }, async () => {
    await seed(0, 600);
    const { result: deleted } = await logLinesDuring(() => sweepExpired(NOW));
    assert.equal(deleted, 500);
    assert.equal(await remaining('ok'), 100, 'the rest waits for the next cycle');
  });

  it('stops a cycle of stuck records at 2000 attempts, having read past the first page', { timeout: 120_000 }, async () => {
    await seed(2300, 1);
    const { result: deleted } = await logLinesDuring(() => sweepExpired(NOW));
    assert.ok(attempts > 500, `only ${attempts} attempt(s): the cycle never read past the first page of stuck records`);
    assert.ok(attempts <= 2000, `${attempts} attempts: the cycle has no ceiling`);
    assert.equal(deleted, 0, 'the healthy record sits behind more stuck records than one cycle attempts');
  });
});

/**
 * Database-level test: per-space activity persists correctly, and the write cost does not scale with traffic.
 *
 * ## What has to be true
 *
 * The whole affordability argument rests on the SHAPE of the write, so that is what this asserts against a real
 * MongoDB rather than a fixture:
 *
 *   - **one upsert per active space per flush**, whatever the call volume — the property that makes the feature
 *     cheap, and the one a refactor would quietly break by moving the write onto the request path;
 *   - **`$inc`, never read-modify-write**, so a second flush (or a second instance) adds instead of clobbering;
 *   - **`maxMs` accumulated with `$max`**, because a maximum is not additive and summing maxima produces a
 *     number no request ever took;
 *   - **`bucketAt` set on insert only**, or a busy space's TTL expiry is pushed forward on every flush and its
 *     bucket never ages out.
 *
 * A fixture could not check any of these: they are all statements about what the database did with the update.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/space-activity-store-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { configureSpaces } from './_configured-spaces.mjs';

const skip = await mongoSkipReason();

const HOUR = Date.parse('2026-08-01T14:20:00.000Z');
const NEXT_HOUR = Date.parse('2026-08-01T15:05:00.000Z');

let mongo, activity, config;
let recordSpaceCall, drainSpaceActivity, flushSpaceActivity, ensureActivityIndexes, summariseActivity,
  ACTIVITY_COLLECTION, ACTIVITY_RETENTION_DAYS;

describe('space activity store — against a real MongoDB', { skip }, () => {
  before(async () => {
    // The spaces the cases below record calls against: a call is counted only against a configured space (Q-606).
    config = await configureSpaces(['general', 'alpha', 'beta', 'busy', 'useful', 'quiet', 'old', 'new'], 'space-activity-store');
    mongo = await openTestMongo('spaceactivity');
    ({ recordSpaceCall, drainSpaceActivity } = await import('../../server/dist/metrics/space-activity.js'));
    ({ flushSpaceActivity, ensureActivityIndexes, summariseActivity, ACTIVITY_COLLECTION,
      ACTIVITY_RETENTION_DAYS } = await import('../../server/dist/metrics/space-activity-store.js'));
    activity = mongo.col(ACTIVITY_COLLECTION);
    await ensureActivityIndexes();
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { drainSpaceActivity(); await activity.deleteMany({}); });

  it('writes ONE document per space per hour, however many calls it took', async () => {
    // The affordability claim, asserted: 500 calls across two spaces is two upserts.
    for (let i = 0; i < 500; i++) {
      recordSpaceCall(i % 2 ? 'alpha' : 'beta', 'recall', { ms: 10, answered: i % 3 === 0, topScore: 0.5 });
    }
    const touched = await flushSpaceActivity(HOUR);
    assert.equal(touched, 2);
    assert.equal(await activity.countDocuments({}), 2, '500 calls must not be 500 documents');

    const doc = await activity.findOne({ _id: 'alpha:2026-08-01T14' });
    assert.equal(doc.calls.recall.n, 250);
    assert.equal(doc.space, 'alpha');
    assert.equal(doc.bucket, '2026-08-01T14');
  });

  it('a second flush ADDS — it is $inc, not read-modify-write', async () => {
    recordSpaceCall('alpha', 'recall', { ms: 10, answered: true, topScore: 0.8 });
    await flushSpaceActivity(HOUR);
    recordSpaceCall('alpha', 'recall', { ms: 30, answered: false });
    await flushSpaceActivity(HOUR);

    const doc = await activity.findOne({ _id: 'alpha:2026-08-01T14' });
    assert.equal(doc.calls.recall.n, 2, 'the second flush clobbered the first');
    assert.equal(doc.calls.recall.answered, 1);
    assert.equal(doc.calls.recall.sumMs, 40);
  });

  it('keeps maxMs as a MAXIMUM, not a sum', async () => {
    recordSpaceCall('alpha', 'read', { ms: 900 });
    await flushSpaceActivity(HOUR);
    recordSpaceCall('alpha', 'read', { ms: 200 });
    await flushSpaceActivity(HOUR);

    const doc = await activity.findOne({ _id: 'alpha:2026-08-01T14' });
    assert.equal(doc.calls.read.maxMs, 900, 'summed maxima describe a request that never happened');
    assert.equal(doc.calls.read.sumMs, 1_100);
  });

  it('does not push the TTL expiry forward while a space stays busy', async () => {
    // `$setOnInsert` for `bucketAt`. With `$set` a continuously-used space would keep its oldest bucket alive
    // forever, which is how a metrics collection becomes the largest thing in the database.
    recordSpaceCall('alpha', 'recall', { ms: 5 });
    await flushSpaceActivity(HOUR);
    const first = (await activity.findOne({ _id: 'alpha:2026-08-01T14' })).bucketAt;

    recordSpaceCall('alpha', 'recall', { ms: 5 });
    await flushSpaceActivity(HOUR + 30 * 60_000);   // same hour, later flush
    const second = (await activity.findOne({ _id: 'alpha:2026-08-01T14' })).bucketAt;
    assert.deepEqual(second, first, 'bucketAt moved — the bucket will never expire');
    assert.equal(first.toISOString(), '2026-08-01T14:00:00.000Z', 'and it is the hour, not the flush time');
  });

  it('starts a new document when the hour rolls over', async () => {
    recordSpaceCall('alpha', 'recall', { ms: 5 });
    await flushSpaceActivity(HOUR);
    recordSpaceCall('alpha', 'recall', { ms: 5 });
    await flushSpaceActivity(NEXT_HOUR);
    assert.equal(await activity.countDocuments({ space: 'alpha' }), 2);
  });

  describe('only a configured space reaches the collection (Q-606)', () => {
    it('an id the config does not hold is never written, whatever arrives', async () => {
      for (let i = 0; i < 20; i++) recordSpaceCall(`invented-${i}`, 'read', { ms: 1 });
      recordSpaceCall('alpha', 'read', { ms: 1 });
      assert.equal(await flushSpaceActivity(HOUR), 1);
      assert.deepEqual((await activity.find({}).toArray()).map(d => d.space), ['alpha'], 'a made-up id has a stored document, kept 90 days');
    });

    it('a space deleted between a call and the flush is not written back under its old id', async () => {
      config.addSpace('deleted-mid-window');
      recordSpaceCall('deleted-mid-window', 'write', { ms: 1 });
      recordSpaceCall('alpha', 'write', { ms: 1 });
      config.removeSpace('deleted-mid-window');
      await flushSpaceActivity(HOUR);
      assert.deepEqual((await activity.find({}).toArray()).map(d => d.space), ['alpha'],
        'the purge of a deleted space\'s rows was undone by the counts that were still pending');
    });
  });

  it('flushing nothing writes nothing', async () => {
    assert.equal(await flushSpaceActivity(HOUR), 0);
    assert.equal(await activity.countDocuments({}), 0);
  });

  it('has a TTL index, so the collection is bounded', async () => {
    const ix = await activity.indexes();
    const ttl = ix.find(i => i.name === 'ttl_bucketAt');
    assert.ok(ttl, 'no TTL index — this collection grows forever');
    assert.equal(ttl.expireAfterSeconds, ACTIVITY_RETENTION_DAYS * 24 * 60 * 60);
  });

  describe('summariseActivity', () => {
    it('separates demand from payoff, which is the entire point', async () => {
      // `busy` is asked a lot and answers rarely; `useful` is asked less and answers almost always. A call
      // count alone would rank `busy` first and say nothing true.
      for (let i = 0; i < 100; i++) recordSpaceCall('busy', 'recall', { ms: 20, answered: i < 5, topScore: 0.3 });
      for (let i = 0; i < 40; i++) recordSpaceCall('useful', 'recall', { ms: 50, answered: i < 38, topScore: 0.9 });
      await flushSpaceActivity(HOUR);

      const rows = await summariseActivity(24, HOUR + 60_000);
      const busy = rows.find(r => r.space === 'busy');
      const useful = rows.find(r => r.space === 'useful');

      assert.equal(busy.recall, 100);
      assert.equal(busy.answered, 5);
      assert.equal(useful.recall, 40);
      assert.equal(useful.answered, 38);
      assert.ok(useful.meanTopScore > busy.meanTopScore, 'answer quality must be comparable too');
      assert.equal(rows[0].space, 'busy', 'sorted by volume — the UI shows both columns and lets you see the gap');
    });

    it('reports a mean duration and never NaN', async () => {
      recordSpaceCall('alpha', 'recall', { ms: 100 });
      recordSpaceCall('alpha', 'write', { ms: 300 });
      await flushSpaceActivity(HOUR);
      const [row] = await summariseActivity(24, HOUR + 60_000);
      assert.equal(row.calls, 2);
      assert.equal(row.meanMs, 200);
      assert.equal(row.maxMs, 300);
    });

    it('returns meanTopScore as null rather than 0 when nothing was answered', async () => {
      // 0 would read as "answers are terrible"; null reads as "nothing to average", which is the truth.
      recordSpaceCall('quiet', 'recall', { ms: 10, answered: false });
      await flushSpaceActivity(HOUR);
      const [row] = await summariseActivity(24, HOUR + 60_000);
      assert.equal(row.answered, 0);
      assert.equal(row.meanTopScore, null);
    });

    it('excludes buckets outside the window', async () => {
      recordSpaceCall('old', 'recall', { ms: 10 });
      await flushSpaceActivity(Date.parse('2026-07-01T10:00:00.000Z'));
      recordSpaceCall('new', 'recall', { ms: 10 });
      await flushSpaceActivity(HOUR);

      const rows = await summariseActivity(24, HOUR + 60_000);
      assert.deepEqual(rows.map(r => r.space), ['new']);
    });

    it('carries lastUsedAt, the cheapest signal of all', async () => {
      recordSpaceCall('alpha', 'read', { ms: 5 });
      await flushSpaceActivity(HOUR);
      const [row] = await summariseActivity(24, HOUR + 60_000);
      assert.equal(row.lastUsedAt, new Date(HOUR).toISOString());
    });
  });
});

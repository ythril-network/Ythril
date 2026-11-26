/**
 * A chrono entry whose `suppressEmbeddings` flag a write removes is embedded afterwards (`Q-962`, review A2).
 *
 * ## The rule
 *
 * `suppressEmbeddings` is the absence of a vector, so the flag is the one field a removal changes the embedding for. A converge that names it
 * in `deleteFields` leaves the entry UNsuppressed (the stored flag is gone), and so the plan queues the embed job that gives it its vector
 * (`enqueue`); an entry whose flag stays is not queued. The decision reads the flag the write LEAVES: an unset flag is `false`, not "state
 * nothing, keep the stored one".
 *
 * ## Seen red
 *
 * On 96be09a1c the planner passes the vector decision no flag (the removal is in `unset`, not in the write's own options), so the decision
 * reads the STORED flag, `true`: the plan is not queued, and the entry stays unembedded with no job.
 *
 * Run: node --test testing/standalone/a-chrono-entry-whose-suppress-flag-is-removed-is-queued-for-embedding-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { SPACE, AUTHOR, openWriteGroupFixture, settle } from './_write-group.mjs';

const skip = await mongoSkipReason();

const ID = 'cccccccc-0000-4000-8000-000000000001';
const T0 = '2026-11-25T00:00:00.000Z';
let fx;
let m;

const plan = async (extra = {}) => {
  const input = { fields: { id: ID, title: 'Standup', type: 'event', startsAt: T0 }, ...extra };
  const view = new m.ReadSet(SPACE);
  await view.load(m.chrono.chronoWant(input));
  return (await m.chrono.planChrono(SPACE, input, view)).plan;
};

describe('a chrono entry whose suppress flag is removed is queued for embedding', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('chronosuppress');
    m = {
      ReadSet: (await import('../../server/dist/brain/write-plan/read-set.js')).ReadSet,
      chrono: await import('../../server/dist/brain/write-plan/plan-chrono.js'),
    };
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => {
    await fx.clear();
    await fx.coll('chrono').insertOne({
      _id: ID, spaceId: SPACE, title: 'Standup', type: 'event', startsAt: T0, status: 'upcoming', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0,
      suppressEmbeddings: true, seq: 3,
    });
  });

  it('control: an entry whose flag stays is not queued', async () => {
    const p = await plan();
    assert.equal(p.enqueue, false, 'an entry that stays suppressed is queued for embedding');
  });

  it('removing the flag queues the entry, and the group stores it unflagged with its job', async () => {
    const p = await plan({ deleteFields: ['suppressEmbeddings'] });
    assert.equal(p.op, 'converge');
    assert.ok('suppressEmbeddings' in p.unset, 'the plan does not remove the flag');
    assert.equal(p.enqueue, true, 'the entry the write leaves unsuppressed is not queued: it stays unembedded with no job');
    const out = await settle(fx.commitGroup([p]));
    assert.equal(out.error, undefined, `the group failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal('suppressEmbeddings' in (await fx.coll('chrono').findOne({ _id: ID })), false, 'the stored entry still carries the flag');
    const jobs = await fx.coll('embed_jobs').find({}).toArray();
    assert.deepEqual(jobs.map(j => j.recordId), [ID], 'the entry has no embed job');
  });

  it('a write that states the flag still decides: stating true keeps it suppressed', async () => {
    const p = await plan({ opts: { suppressEmbeddings: true } });
    assert.equal(p.enqueue, false);
  });
});

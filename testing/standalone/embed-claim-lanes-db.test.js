/**
 * The embed queue claims by LANE across every space, and a lane only ever becomes more urgent.
 *
 * ## The defect (Q-99 part 2)
 *
 * `claimNextEmbedJob` walked the spaces in config order and took the oldest claimable job of the FIRST space that
 * had one. So a reindex that queued every record of space A, ahead of space B in the list, held B's fresh local
 * write behind A's whole backlog — the write that somebody is waiting to search for, behind a rebuild nobody is.
 * Moving reindex onto this queue (design v3) makes that the common case rather than an edge, which is why the
 * lanes arrive with it.
 *
 * ## The rules pinned here, each against a real MongoDB
 *
 *  1. Lanes go ACROSS every probed space before the next lane: a priority-0 job in B is claimed before five OLDER
 *     priority-2 jobs in A, with A first in the list.
 *  2. A job written before the upgrade has no `priority` field and is claimed as lane 0, not stranded.
 *  3. A space is dropped from the probe hint only when EVERY pass found nothing there. A space holding only
 *     lane-2 work is empty in lane 0 — dropping it then would leave its jobs unclaimed until the next full scan,
 *     and `noteEmpty` is the line that looks like boilerplate.
 *  4. The fresh-claim query of each lane is index-ordered, with no blocking SORT stage.
 *  5. Every enqueue raises urgency only (`$min` on priority).
 *
 * ## Robust to the rotation, on purpose
 *
 * `claimOrder(n)` leads with a background lane on claims n % 8 of 3 and 7 (see `embed-claim-order.test.js`), and
 * this file cannot reset that counter. So nothing here asserts on exactly ONE claim's lane: each assertion is a
 * bound that holds whichever claim the rotation lands on. Two consecutive claims always include a [0, 1, 2] one,
 * because the rotation slots are four apart.
 *
 * ## How the explain() case reads the REAL query
 *
 * It does not rebuild the filter by hand. Mongo's profiler records the `findAndModify` the server's own
 * `claimNextEmbedJob` sent; the case takes each fresh-claim command from `system.profile` (top-level
 * `claimableAfter: null`), asserts the profiler saw no sort stage, and re-explains that exact filter and sort to
 * walk the winning plan. The only replication is `find(filter).sort(sort)` standing in for the `findAndModify`
 * around it, which plans the same query shape.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/embed-claim-lanes-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACES = ['alpha', 'bravo', 'charlie', 'delta'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-claim-lanes-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, queue;
const jobs = (s) => mongo.col(`${s}_embed_jobs`);

/** Queue one job through the real enqueue, then pin its age so "older" means older. */
async function seed(space, id, priority, createdAt) {
  await queue.enqueueEmbedJob(space, 'fact', id, { priority });
  await jobs(space).updateOne({ _id: `fact:${id}` }, { $set: { createdAt } });
}

const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

/** Claim until the queue answers null, at most `max` times; the claimed record ids in order. */
async function drain(spaceIds, max = 20) {
  const order = [];
  for (let i = 0; i < max; i++) {
    const job = await queue.claimNextEmbedJob(spaceIds);
    if (!job) break;
    order.push(job.recordId);
  }
  return order;
}

describe('embed queue lanes (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: SPACES.map(id => ({ id, label: id })), networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('claimlanes');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    try { await mongo?.getDb().command({ profile: 0 }); } catch { /* best effort */ }
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const s of SPACES) await jobs(s).deleteMany({});
    queue.resetEmbedPendingHint();
  });

  it('a priority-0 job in B is claimed before five OLDER priority-2 jobs in A, A first in the list', async () => {
    for (let i = 0; i < 5; i++) await seed('alpha', `rebuild-${i}`, 2, at(i));
    await seed('bravo', 'write', 0, at(30));

    const order = await drain(['alpha', 'bravo']);
    assert.equal(order.length, 6, `every job is claimed eventually (got ${order.join(', ')})`);
    // Within the first two claims, whichever of them the rotation lands on: one of any two is a [0, 1, 2] claim.
    assert.ok(order.indexOf('write') >= 0 && order.indexOf('write') <= 1,
      `the local write was claim #${order.indexOf('write') + 1} of ${order.join(', ')} — lanes must run ACROSS `
      + 'spaces, or a rebuild in a space listed earlier holds every other space\'s writes behind it');
  });

  it('a job with NO priority field (written before the upgrade) is claimed as lane 0', async () => {
    for (let i = 0; i < 5; i++) await seed('alpha', `rebuild-${i}`, 2, at(i));
    // Raw, as an older server wrote it: no `priority` key at all.
    await jobs('alpha').insertOne({
      _id: 'fact:legacy', spaceId: 'alpha', recordType: 'fact', recordId: 'legacy', status: 'pending',
      attempts: 0, transientFailures: 0, lostChildFailures: 0, maxAttempts: 5, lastError: null,
      claimedAt: null, progressAt: null, claimableAfter: null, claimToken: null,
      createdAt: at(30), updatedAt: at(30),
    });

    const order = await drain(['alpha']);
    assert.ok(order.includes('legacy'),
      'a pre-upgrade job was never claimed: matching lane 0 by `priority: 0` alone strands every job an older '
      + 'server queued');
    assert.ok(order.indexOf('legacy') >= 0 && order.indexOf('legacy') <= 1,
      `the pre-upgrade job was claim #${order.indexOf('legacy') + 1} of ${order.join(', ')}; a missing priority is lane 0`);
  });

  it('a space holding only lane-2 work is not dropped from the hint by a lane-0 claim elsewhere', async () => {
    for (let i = 0; i < 3; i++) await seed('charlie', `rebuild-${i}`, 2, at(i));
    await seed('delta', 'write', 0, at(30));

    // The enqueues put both spaces in the hint (beforeEach reset it, so the first claim is also a full scan). No
    // full scan is due after that one (the interval is 30 s), so every later claim probes only the hinted spaces:
    // a charlie dropped by the lane-0 pass, which found nothing THERE, answers null with three jobs pending.
    const order = await drain(['charlie', 'delta']);
    assert.ok(order.indexOf('write') >= 0 && order.indexOf('write') <= 1, `the lane-0 write was claim #${order.indexOf('write') + 1} of ${order.join(', ')}`);
    assert.equal(order.length, 4,
      `only ${order.length} of 4 jobs were claimed before the queue answered null (${order.join(', ')}): a space `
      + 'empty in ONE lane was noted empty, and its other lanes went unclaimed until the next full scan');
    assert.equal(await jobs('charlie').countDocuments({ status: 'pending' }), 0);
  });

  it('the fresh-claim query of every lane is index-ordered, with no SORT stage', async () => {
    const SPACE = 'alpha';
    await queue.ensureEmbedJobIndexes(SPACE);
    // Ballast, so the planner has a real choice to make, and one job per lane so every lane's pass runs.
    for (let i = 0; i < 300; i++) await seed(SPACE, `ballast-${i}`, 2, at(100 + i));
    await jobs(SPACE).updateMany({ recordId: /^ballast-/ }, { $set: { status: 'failed' } });
    for (const p of [0, 1, 2]) await seed(SPACE, `lane-${p}`, p, at(p));

    const db = mongo.getDb();
    await db.collection('system.profile').drop().catch(() => {});
    await db.command({ profile: 2 });
    try {
      await drain([SPACE]);
    } finally {
      await db.command({ profile: 0 });
    }

    const ns = `${db.databaseName}.${SPACE}_embed_jobs`;
    const entries = await db.collection('system.profile').find({ ns, 'command.findAndModify': { $exists: true } }).toArray();
    assert.ok(entries.length >= 3, `the profiler saw ${entries.length} claim commands; expected one per claim at least`);

    // A FRESH claim pins `claimableAfter: null` at the top level, so the index orders it. The `$or` the old claim
    // used (null OR missing OR due) cannot be satisfied by one index range in createdAt order.
    const fresh = entries.filter(e => e.command.query?.status === 'pending'
      && Object.prototype.hasOwnProperty.call(e.command.query, 'claimableAfter')
      && e.command.query.claimableAfter === null
      && Object.prototype.hasOwnProperty.call(e.command.query, 'priority'));
    const lanesSeen = new Set(fresh.map(e => JSON.stringify(e.command.query.priority)));
    assert.ok(fresh.length >= 3 && lanesSeen.size >= 3,
      `found ${fresh.length} fresh-claim commands over ${lanesSeen.size} lane value(s) (${[...lanesSeen].join(', ')}). `
      + 'Each lane needs its own fresh pass `{ status: "pending", priority, claimableAfter: null }` sorted by createdAt. '
      + `Commands seen: ${entries.map(e => JSON.stringify(e.command.query)).join(' | ')}`);

    const stages = (plan, out = []) => {
      if (!plan || typeof plan !== 'object') return out;
      if (plan.stage) out.push(plan);
      for (const k of ['inputStage', 'inputStages', 'queryPlan', 'outerStage', 'innerStage']) {
        const v = plan[k];
        if (Array.isArray(v)) v.forEach(p => stages(p, out)); else if (v) stages(v, out);
      }
      return out;
    };

    for (const e of fresh) {
      const label = JSON.stringify(e.command.query);
      assert.ok(!e.hasSortStage, `the profiler saw a blocking sort on the fresh claim ${label}`);
      assert.deepEqual(e.command.sort, { createdAt: 1 }, `the fresh claim ${label} must take the oldest first`);
      const explained = await db.collection(`${SPACE}_embed_jobs`).find(e.command.query).sort(e.command.sort).explain();
      const all = stages(explained.queryPlanner.winningPlan);
      const names = all.map(s => s.stage);
      assert.ok(!names.includes('SORT'),
        `the fresh claim ${label} sorts in memory (${names.join(' > ')}); the lane index must order it`);
      const scans = all.filter(s => s.stage === 'IXSCAN');
      assert.ok(scans.length > 0, `the fresh claim ${label} is not an index scan (${names.join(' > ')})`);
      for (const s of scans) {
        assert.ok('priority' in s.keyPattern && 'createdAt' in s.keyPattern,
          `the fresh claim ${label} used ${JSON.stringify(s.keyPattern)}, not the lane index`);
      }
    }
  });

  it('an enqueue only ever RAISES urgency: 2 then 0 ends at 0', async () => {
    await queue.enqueueEmbedJob('alpha', 'fact', 'x', { priority: 2 });
    await queue.enqueueEmbedJob('alpha', 'fact', 'x', { priority: 0 });
    const job = await jobs('alpha').findOne({ _id: 'fact:x' });
    assert.equal(job.priority, 0, 'a local write to a record a reindex queued makes its job a local write');
  });

  it('an enqueue only ever RAISES urgency: 0 then 2 stays 0', async () => {
    await queue.enqueueEmbedJob('alpha', 'fact', 'y', { priority: 0 });
    await queue.enqueueEmbedJob('alpha', 'fact', 'y', { priority: 2 });
    const job = await jobs('alpha').findOne({ _id: 'fact:y' });
    assert.equal(job.priority, 0,
      'a reindex sweeping past a record with a pending local write must not demote it behind the rebuild');
  });
});

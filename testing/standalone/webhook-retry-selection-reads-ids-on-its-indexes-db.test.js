/**
 * The retry poll CHOOSES its tick's rows from ids on two compound indexes, and the choice is fair across subscriptions (bundle-169, Q-483; design rev 3.2).
 *
 * ## The defect
 *
 * `dueJobs` was `find({ scheduledAt <= now }).sort({ scheduledAt: 1 }).limit(50)`: the 50 OLDEST due rows, whoever they belong to. One subscription whose sink
 * went down with a burst behind it (thousands of rows, all older than anyone else's) filled every tick, and another subscription's three due retries were not in a
 * selection until the backlog had gone. The fix selects round-robin across subscriptions, and the shape of the fix has a cost the challenge named: a choice made
 * over BODIES (an aggregate that sorts and groups whole rows) reads every due row every tick, which with 10 000 due rows can outlast the housekeeping bound and fail
 * every tick for everyone. So the choice is made over ids and index keys only (a covered read), and the 50 chosen rows are then fetched by `_id`.
 *
 * ## What is pinned (the real `createRetryWorker` over its real queue, against the harness Mongo)
 *
 * - **Fairness.** 10 000 due rows of one subscription, every one older than the 3 of another: the 3 are all delivered-or-dropped in the FIRST tick, together with
 *   the rest of the batch of 50 from the first (at least floor(50 / 2) = 25 of it, and the tick fills its batch: unused share passes on).
 * - **Ids only before the choice.** Every read of the queue that is not a fetch by `_id` returns ids and nothing else: `explain('executionStats')` of the cursor the poll built
 *   reports either `totalDocsExamined: 0` (the covered aggregate of the due keys) or a projection to `_id` alone over at most the batch (a subscription's earliest rows by its
 *   compound: an `_id` is not a key of any secondary index, so that read fetches its few rows and returns only their ids; probed on the harness Mongo), and never a COLLSCAN. (`explain`, not the profiler: the profiler is a database-wide setting that another file's database
 *   at `--test-concurrency=4` would share.) The queries are RECORDED from the poll's own `find` / `aggregate` calls and explained as built, so a change of the
 *   poll's shape is what is measured, not a copy of it.
 * - **Both indexes.** The winning plans of those reads between them scan `{ scheduledAt: 1, webhookId: 1 }` (the due keys, covered) and
 *   `{ webhookId: 1, scheduledAt: 1 }` (one subscription's earliest rows). The two are created here by the key patterns the design names (their creation, and
 *   the drop of `{ scheduledAt: 1 }` after both are confirmed, is the bootstrap step's own test).
 * - **A fetch by `_id` follows the choice** and takes at most the batch (50): bodies are read only for the chosen rows.
 * - **A deleted subscription's row is still selected and dropped.** The selection does not consult the subscriptions, so rows of a subscription that no longer exists
 *   are chosen like any other, removed, counted as dropped (`reason: deleted`) and never delivered. Green at base: it guards the drop path through the new selection.
 *
 * ## Red at base
 *
 * All by the rule, since the code exists: the base `dueJobs` takes the 50 oldest (`the second subscription's 3 rows were not in the first tick`), reads 50 whole
 * documents (`totalDocsExamined` 50, returned with no projection) and issues no fetch by `_id` (`no fetch by _id followed the choice`), and its plan never scans `{ webhookId: 1,
 * scheduledAt: 1 }`. The deleted-subscription case is green at base.
 *
 * Run: node --test testing/standalone/webhook-retry-selection-reads-ids-on-its-indexes-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const RETRY = '_webhook_retry_queue';
/** The batch a tick takes, as the design states it ("at most RETRY_BATCH rows are fetched per tick, as today"). The gate for the docs reads the exported figure. */
const BATCH = 50;
const DUE_KEYS = 'scheduledAt,webhookId';
const LANE_KEYS = 'webhookId,scheduledAt';

let mongo, dispatcher, queue, spy;

/** Every node of a tree, visited. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(n => walk(n, visit)); else if (v && typeof v === 'object') walk(v, visit); }
}
/** Every `winningPlan` of an explain (a find has one, an aggregate has one under `$cursor` or at the top, whichever the planner pushed down). */
function winningPlans(explain) {
  const out = [];
  walk(explain, (n) => { if (n.winningPlan) out.push(n.winningPlan); });
  return out;
}
const stagesOf = (plans) => { const s = []; for (const p of plans) walk(p, (n) => { if (typeof n.stage === 'string') s.push(n.stage); }); return s; };
const keyScans = (plans) => { const s = []; for (const p of plans) walk(p, (n) => { if (n.stage === 'IXSCAN' && n.keyPattern) s.push(Object.keys(n.keyPattern).join(',')); }); return s; };
/** The field lists of every projection stage of the plans (`transformBy`): what the read RETURNS. A read of one subscription's rows by its compound still fetches the rows it limits to, and returns only `_id`. */
const projectionsOf = (plans) => { const s = []; for (const p of plans) walk(p, (n) => { if (n.transformBy && typeof n.transformBy === 'object') s.push(Object.keys(n.transformBy)); }); return s; };
const docsExamined = (explain) => { const n = []; walk(explain, (x) => { if (typeof x.totalDocsExamined === 'number') n.push(x.totalDocsExamined); }); return n.length ? Math.max(...n) : null; };

/** Record the poll's own reads of the retry queue (the cursor each `find` / `aggregate` returns), without changing them. */
function spyOnQueueReads() {
  const proto = Object.getPrototypeOf(mongo.col(RETRY));
  const original = { find: proto.find, aggregate: proto.aggregate };
  const reads = [];
  proto.find = function (...args) { const c = original.find.apply(this, args); if (this.collectionName === RETRY) reads.push({ kind: 'find', cursor: c, shape: args[0] }); return c; };
  proto.aggregate = function (...args) { const c = original.aggregate.apply(this, args); if (this.collectionName === RETRY) reads.push({ kind: 'aggregate', cursor: c, shape: args[0] }); return c; };
  return { reads, restore: () => { proto.find = original.find; proto.aggregate = original.aggregate; } };
}
const mentionsId = (rec) => JSON.stringify(rec.kind === 'find' ? (rec.shape ?? {}) : ((rec.shape ?? [])[0]?.$match ?? {})).includes('"_id"');

const rowOf = (webhookId, n, at) => ({
  _id: `${webhookId}-${String(n).padStart(5, '0')}`, webhookId, body: '{}', event: 'entity.created', spaceId: 's', deliveryId: `d-${webhookId}-${n}`,
  attempt: 2, scheduledAt: new Date(at), createdAt: new Date(at),
});
async function seed(plan) {
  await queue.deleteMany({});
  const docs = plan.flatMap(({ webhookId, count, from }) => Array.from({ length: count }, (_, i) => rowOf(webhookId, i, from + i)));
  await queue.insertMany(docs);
}
const remaining = async (webhookId) => await queue.countDocuments({ webhookId });

/** One real tick of the real worker over the real queue (the production `RetryPollDeps`), run to the moment `dropped` more rows have been dropped. */
async function oneTick(expectDropped) {
  const before = dispatcher.webhookRetriesDroppedCounts().deleted;
  let tick = null;
  const worker = dispatcher.createRetryWorker(undefined, {
    arm: (fn) => { tick = fn; const h = { unref() { return h; } }; return h; }, disarm: () => {}, warn: () => {}, error: () => {},
  });
  worker.job.start();
  tick();
  await waitFor(() => dispatcher.webhookRetriesDroppedCounts().deleted - before >= expectDropped, 30_000, 50,
    () => `dropped ${dispatcher.webhookRetriesDroppedCounts().deleted - before} of the ${expectDropped} rows the tick should have taken`);
  worker.job.stop();
  return dispatcher.webhookRetriesDroppedCounts().deleted - before;
}

describe('the retry poll chooses its rows from ids on two compound indexes, fairly', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('webhookretryselect');
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    queue = mongo.col(RETRY);
    await queue.createIndex({ scheduledAt: 1, webhookId: 1 });
    await queue.createIndex({ webhookId: 1, scheduledAt: 1 });
  });
  after(async () => { spy?.restore(); await queue?.deleteMany({}).catch(() => {}); await closeTestMongo(); });
  beforeEach(() => { spy = null; });
  afterEach(() => { spy?.restore(); spy = null; });

  it('10 000 due rows of one subscription, all older than the 3 of another: the 3 are in the first tick\'s selection, and the tick still fills its batch', async () => {
    const now = Date.now() - 3_600_000;
    await seed([{ webhookId: 'flood', count: 10_000, from: now }, { webhookId: 'small', count: 3, from: now + 20_000 }]);
    const dropped = await oneTick(BATCH);
    assert.equal(dropped, BATCH, `the tick took ${dropped} rows, not its batch of ${BATCH}`);
    assert.equal(await remaining('small'), 0, `the second subscription's 3 rows were not in the first tick (${await remaining('small')} left): the flood's oldest rows took the whole batch`);
    const floodTaken = 10_000 - (await remaining('flood'));
    assert.ok(floodTaken >= Math.floor(BATCH / 2), `the flooding subscription got ${floodTaken} rows, fewer than floor(${BATCH} / 2)`);
    assert.equal(floodTaken + 3, BATCH, 'the share the small subscription did not need was not passed on');
  });

  it('every read that chooses the rows returns ids only (covered, or projected to _id and bounded by the batch), uses both compounds, and a fetch by _id follows', async () => {
    const t = Date.now() - 3_600_000;
    await seed([{ webhookId: 'a', count: 100, from: t }, { webhookId: 'b', count: 100, from: t + 5_000 }, { webhookId: 'c', count: 100, from: t + 10_000 }]);
    spy = spyOnQueueReads();
    await oneTick(BATCH);
    spy.restore();
    const reads = spy.reads;
    assert.ok(reads.length >= 1, 'the poll made no read of the retry queue: the derivation found nothing to explain');
    const selection = reads.filter(r => !mentionsId(r));
    const fetches = reads.filter(r => mentionsId(r));
    const verdicts = [];
    for (const rec of selection) {
      const explain = await rec.cursor.clone().explain('executionStats');
      const plans = winningPlans(explain);
      verdicts.push({ kind: rec.kind, docs: docsExamined(explain), stages: stagesOf(plans), keys: keyScans(plans), projected: projectionsOf(plans) });
    }
    assert.ok(selection.length >= 1, 'every read of the queue was a fetch by _id: nothing chose the rows');
    for (const v of verdicts) {
      assert.ok(!v.stages.includes('COLLSCAN'), `a ${v.kind} that chooses the rows scans the collection: ${v.stages.join(' > ')}`);
      const idsOnly = v.projected.some(keys => keys.length === 1 && keys[0] === '_id');
      assert.ok(v.docs === 0 || (idsOnly && v.docs <= BATCH),
        `a ${v.kind} that chooses the rows examined ${v.docs} documents and returned more than ids (stages ${v.stages.join(' > ')}, projections ${JSON.stringify(v.projected)}): the choice reads bodies, not ids`);
    }
    const scanned = new Set(verdicts.flatMap(v => v.keys));
    assert.ok(scanned.has(DUE_KEYS), `no choosing read scans { scheduledAt: 1, webhookId: 1 } (scanned: ${[...scanned].join(' | ') || 'nothing'})`);
    assert.ok(scanned.has(LANE_KEYS), `no choosing read scans { webhookId: 1, scheduledAt: 1 } (scanned: ${[...scanned].join(' | ') || 'nothing'})`);
    assert.ok(fetches.length >= 1, 'no fetch by _id followed the choice: the rows were read in the choosing query');
    let fetched = 0;
    for (const f of fetches) {
      walk(f.shape, (n) => { if (n._id && Array.isArray(n._id.$in)) fetched += n._id.$in.length; });
    }
    assert.ok(fetched >= 1 && fetched <= BATCH, `${fetched} ids were fetched by _id: bodies are read for the chosen rows only (at most ${BATCH})`);
  });

  it('a deleted subscription\'s rows are still selected: removed, counted as dropped, and never delivered', async () => {
    const t = Date.now() - 3_600_000;
    await seed([{ webhookId: 'gone-sub', count: 3, from: t }]);
    const dropped = await oneTick(3);
    assert.equal(dropped, 3, 'the three rows of a subscription that no longer exists were not all dropped by the tick');
    assert.equal(await queue.countDocuments({}), 0, 'a row of a deleted subscription was left in the queue');
  });
});

/**
 * Database-level test: the media job queue's queries use an index, and MongoDB says so.
 *
 * ## The finding (lens 4, Performance)
 *
 * `initSpace` created indexes for nine per-space collections — memories, entities, edges, chrono,
 * tombstones, conflicts, dupe candidates, contradiction candidates, files — and **not** for
 * `<space>_media_jobs`, which is the collection the product polls hardest:
 *
 *     claimNextJob      { status, $or:[claimableAfter …] }  sort { createdAt: 1 }   per space, every ~1 s
 *     resetStalledJobs  { status, progressAt < cutoff }      sort { claimedAt: 1 }   per space, per sweep
 *     the /metrics collectors                                                        four reads per scrape
 *
 * Each was a collection scan plus an in-memory sort. And nothing prunes the collection — `completeJob` sets
 * `status: 'complete'` and only a deleted file removes a row — so it holds one document per file ever
 * uploaded. The cost therefore grows with the AGE of the instance rather than with its backlog: an idle queue
 * gets more expensive to poll every month the instance stays up.
 *
 * ## Why `explain()` rather than "the index exists"
 *
 * An index that the planner does not choose is decoration. The lens's own verification step is "explain the
 * big-O, then check for the index" — so this asserts the winning plan for the REAL queries, taken from the
 * shipped modules, and fails if a future index change leaves the claim walk scanning again.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/job-queue-indexes-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
let mongo, jobs, stalledJobFilter, MEDIA_JOB_INDEXES;
/** Index names as MongoDB assigned them, so the negative control can drop exactly what was created. */
const createdNames = [];

/** Every stage name in a winning plan, flattened — the shape differs between scan, sort and fetch plans. */
function planStages(explain) {
  const names = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.stage === 'string') names.push(node.stage);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  })(explain?.queryPlanner?.winningPlan ?? {});
  return names;
}

describe('media job queue indexes — against a real MongoDB', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('jobindexes');
    ({ stalledJobFilter, MEDIA_JOB_INDEXES } =
      await import('../../server/dist/files/media/job-queue.js'));
    jobs = mongo.col(`${SPACE}_media_jobs`);

    // The PRODUCT's own creation call, not a copy of its key patterns. A test that builds its own indexes
    // and then asserts a query plan proves the patterns work and says nothing about whether anything
    // creates them. Calling `initSpace` instead would want a full config, a space record and a vector index.
    // Restated by Q-445 (bundle-101): `ensureMediaJobIndexes` is gone; the product builds the job indexes from the one per-space
    // declaration (`spaces/space-indexes.ts`), so this builds the declaration's media-jobs entries through its own builder.
    assert.ok(Array.isArray(MEDIA_JOB_INDEXES) && MEDIA_JOB_INDEXES.length >= 2,
      'the product must still declare its job indexes');
    const { SPACE_INDEXES, buildSpaceIndexUnits } = await import('../../server/dist/spaces/space-indexes.js');
    const { failed } = await buildSpaceIndexUnits(SPACE, SPACE_INDEXES.filter(ix => ix.part === 'mediaJobs'));
    assert.deepEqual(failed, [], 'the declared media job indexes did not build');
    const built = await jobs.indexes();
    for (const keys of MEDIA_JOB_INDEXES) {
      const wanted = JSON.stringify(keys);
      const found = built.find(ix => JSON.stringify(ix.key) === wanted);
      assert.ok(found, `the declaration did not create ${wanted}`);
      createdNames.push(found.name);
    }

    // Enough documents that a scan is a plan the optimiser would have to justify.
    const now = new Date().toISOString();
    await jobs.insertMany(Array.from({ length: 400 }, (_, i) => ({
      _id: `f${i}.pdf`, spaceId: SPACE, filePath: `f${i}.pdf`, mimeType: 'application/pdf',
      mediaType: 'text', status: i % 4 === 0 ? 'pending' : 'complete', attempts: 0, maxAttempts: 3,
      lastError: null, claimedAt: null, claimableAfter: null, progressAt: now,
      createdAt: now, updatedAt: now,
    })));
  });

  after(async () => { await closeTestMongo(); });

  it('the CLAIM query is an index scan, not a collection scan', async () => {
    // Exactly the filter and sort `claimNextJob` uses.
    const now = new Date().toISOString();
    const explain = await jobs.find({
      status: 'pending',
      $or: [{ claimableAfter: null }, { claimableAfter: { $exists: false } }, { claimableAfter: { $lte: now } }],
    }).sort({ createdAt: 1 }).explain('queryPlanner');

    const stages = planStages(explain);
    assert.ok(stages.includes('IXSCAN'), `expected an index scan, got: ${stages.join(' > ')}`);
    assert.ok(!stages.includes('COLLSCAN'), `still scanning the collection: ${stages.join(' > ')}`);
  });

  it('the STALL sweep is an index scan too', async () => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const explain = await jobs.find(stalledJobFilter(cutoff)).sort({ claimedAt: 1 }).explain('queryPlanner');
    const stages = planStages(explain);
    assert.ok(stages.includes('IXSCAN'), `expected an index scan, got: ${stages.join(' > ')}`);
  });

  it('a status COUNT is answered from the index — the metrics take three per space per scrape', async () => {
    const explain = await jobs.find({ status: 'pending' }).explain('queryPlanner');
    const stages = planStages(explain);
    assert.ok(stages.includes('IXSCAN'), `expected an index scan, got: ${stages.join(' > ')}`);
    assert.ok(!stages.includes('COLLSCAN'));
  });

  it('the phase read added in #601 is an index scan as well', async () => {
    // `ythril_media_job_phase` runs this per space per scrape. It was the fourth scan of the same collection.
    const explain = await jobs.find({ status: 'processing' }, { projection: { progress: 1 } })
      .explain('queryPlanner');
    assert.ok(planStages(explain).includes('IXSCAN'));
  });

  it('WITHOUT the indexes the same claim query scans — the control for all of the above', async () => {
    // Without this, every assertion here could be passing on a plan MongoDB would have chosen anyway, and
    // the test would say nothing about whether the indexes matter.
    for (const name of createdNames) await jobs.dropIndex(name);
    const now = new Date().toISOString();
    const explain = await jobs.find({
      status: 'pending',
      $or: [{ claimableAfter: null }, { claimableAfter: { $exists: false } }, { claimableAfter: { $lte: now } }],
    }).sort({ createdAt: 1 }).explain('queryPlanner');
    const stages = planStages(explain);
    assert.ok(stages.includes('COLLSCAN'), `expected the pre-fix plan, got: ${stages.join(' > ')}`);

    // Put them back, so ordering between tests cannot matter.
    for (const keys of MEDIA_JOB_INDEXES) await jobs.createIndex(keys);
  });

  it('every job index is in the per-space declaration, boot-safe — the wiring, not just the function', async () => {
    // The suite above builds indexes through `ensureMediaJobIndexes`, so it would keep passing if nothing
    // ever built them on a real boot. Restated by Q-445 (bundle-101): it read `lifecycle.ts` for the call,
    // which held only while `initSpace` named every builder by hand. What builds a space's indexes is now the
    // one declaration (`spaces/space-indexes.ts`), which `initSpace`, the background pass and a restore all
    // run, so the rule is that every job index is declared on the media jobs collection and built at every
    // boot (an existing instance gets it), with the keys `MEDIA_JOB_INDEXES` holds.
    const { requireSpaceIndexDeclaration } = await import('./_space-index-declaration.mjs');
    const declared = (await requireSpaceIndexDeclaration(assert)).filter(e => e.suffix === 'media_jobs');
    const findings = [];
    for (const keys of MEDIA_JOB_INDEXES) {
      const e = declared.find(d => JSON.stringify(d.spec.key) === JSON.stringify(keys));
      if (!e) findings.push(`${JSON.stringify(keys)} is not declared on media_jobs`);
      else if (e.bootSafe !== true) findings.push(`${JSON.stringify(keys)} is not boot-safe, so an existing instance gets it only from the background pass`);
    }
    assert.deepEqual(findings, [], findings.join('; '));
  });
});

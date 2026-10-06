/**
 * A reindex is a RUN DOCUMENT that the queue finishes — not a loop in one process that a restart forgets.
 *
 * ## What was wrong (Q-99 part 2)
 *
 * `startReindex` walked five collections by hand, inside one `setImmediate`, holding a module-level boolean as
 * its guard and setting the gauge to 1. Three consequences, each invisible from the outside:
 *
 *   1. **A restart mid-run lost the run.** Nothing was written down, so a reindex interrupted by a deploy simply
 *      stopped — and `needsReindex` went back to whatever `initSpace` guessed from one sampled fact.
 *   2. **The guard was instance-wide.** A reindex of one space refused every other space with 409, although the
 *      queue already serialises the embedding work the refusal claimed to protect.
 *   3. **The gauge said 1 or 0**, so two runs read as one and a run that ended second set it to 0 under the first.
 *
 * ## The rules these cases state
 *
 * - `startReindex` writes the run document (`spaceCollection(space, 'reindexRun')`, `_id: 'run'`) with `flagged`,
 *   `target` and `cursor` BEFORE it resolves; the sweep runs after.
 * - After the sweep and a drained queue, one `reindexRunTick` clears `needsReindex` and deletes the document.
 * - `resumeReindexRuns` continues a cut-short sweep from its cursor (what is before it is not queued again) and
 *   restarts one whose `target` no longer matches the configuration.
 * - A sweep that keeps failing records `error` on the document, keeps it, and keeps `needsReindex` asserted.
 * - While a document exists, `initSpace` answers `needsReindex` from its `flagged`.
 * - The guard is per space: 409 for the space with an ACTIVE run, naming only that space; any other space is
 *   allowed; an errored run does not block.
 * - `ythril_reindex_in_progress` is the number of active runs.
 *
 * ## Two choices the cases make, stated so the implementation can be held to them
 *
 * - **`cursor.kind` is an embed record type** (`EMBED_RECORD_TYPES`: `fact`, `entity`, …) — the vocabulary
 *   `enqueueEmbedJobs(spaceId, type, ids, …)` already takes. The resume cases seed a cursor in it, and one case
 *   asserts a written cursor uses it.
 * - **The current `target` is READ from a run `startReindex` wrote**, never spelled here. A test that wrote its
 *   own `{model, dimensions, prefixScheme}` would assert that the code equals the test's guess.
 *
 * The gauge cases poison it before each step (pitfall-gauge-reset-reads-zero): a gauge that is already at the
 * expected value proves nothing about the step under test.
 *
 * Run: `npm run test:up` first, then (after `npm run build` in server/)
 *      node --test testing/standalone/a-reindex-run-is-a-document-that-finishes-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const SPACES = ['life', 'early', 'resume', 'retarget', 'broken', 'flagged', 'guard-a', 'guard-b', 'guard-c', 'ref',
  'gauge-a', 'gauge-b'];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-reindex-run-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

let server, mongo, loader, reindex, queue, worker, shared, lifecycle, registry, spaceCollection;

/**
 * A run another process is sweeping, for the cases that HOLD a run in a state (no sweep is running) and read it. Since the tick
 * resumes a run whose lease is stale (`a-reindex-boot-failure-is-retried-by-the-tick-db.test.js`), a seeded incomplete run
 * without one is a run the 5 s watcher may start sweeping under the case.
 */
const HELD_LEASE = () => Date.now() + 60 * 60_000;

const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((String(text).length + i) % 10) / 10);

const runCol = (space) => mongo.col(spaceCollection(space, 'reindexRun'));
const jobsCol = (space) => mongo.col(spaceCollection(space, 'embedJobs'));
const factsCol = (space) => mongo.col(spaceCollection(space, 'facts'));
const spaceConfig = (id) => loader.getConfig().spaces.find(s => s.id === id);

/** Plain top-level facts, written straight to the collection so no write-path job is queued for them. */
async function seedFacts(space, n) {
  const now = new Date().toISOString();
  const ids = Array.from({ length: n }, (_, i) => `${space}-f-${String(i).padStart(3, '0')}`);
  await factsCol(space).insertMany(ids.map((id, i) => ({
    _id: id, spaceId: space, fact: `fact number ${i} in ${space}`, tags: [], entityIds: [], seq: i + 1,
    createdAt: now, updatedAt: now,
  })));
  return ids;
}

/** Record ids that have a REBUILD job queued in the space. */
async function rebuildQueued(space) {
  const rows = await jobsCol(space).find({ rebuild: true }).project({ recordId: 1 }).toArray();
  return new Set(rows.map(r => r.recordId));
}

/** Poll until `cond()` holds; the failure message is the point, so a red run says which rule it broke. */
const until = (cond, what, timeoutMs = 20_000) => waitForValue(cond, timeoutMs, 100, undefined, { what });

const sweepDone = (space) => until(async () => (await runCol(space).findOne({ _id: 'run' }))?.sweepComplete === true,
  `the run document of '${space}' to report sweepComplete`);

async function drainQueue() {
  for (let i = 0; i < 500 && await worker.runOneEmbedJob(); i++) { /* drain */ }
}

async function gauge() {
  const got = await registry.reindexInProgress.get();
  return got.values[0]?.value;
}

/** The target a run is stamped with under THIS configuration — read from a run, never guessed. */
async function currentTarget() {
  await runCol('ref').deleteMany({});
  const decision = await reindex.planReindex({ spaceId: 'ref', space: spaceConfig('ref'), memberIds: ['ref'] });
  assert.equal(decision.ok, true, `precondition: a reindex of an empty space is allowed: ${JSON.stringify(decision)}`);
  await reindex.startReindex(decision.plan);
  const doc = await runCol('ref').findOne({ _id: 'run' });
  assert.ok(doc?.target, 'startReindex must stamp the run with the target it is building for');
  return doc.target;
}

describe('a reindex run is a document the queue finishes (real MongoDB, stub embedder)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(input) }] }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${server.address().port}`;

    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'reindex-run', instanceLabel: 'test', tokens: [], networks: [],
      spaces: SPACES.map(id => ({ id, label: id, folders: [] })),
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('reindexrun');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    reindex = await import('../../server/dist/brain/reindex.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    shared = await import('../../server/dist/spaces/_shared.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    registry = await import('../../server/dist/metrics/registry.js');
  });

  after(async () => {
    await closeTestMongo();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const s of SPACES) {
      await mongo.col(`${s}_facts`).deleteMany({});
      await mongo.col(`${s}_embed_jobs`).deleteMany({});
      // Through the registry, so the base (which has no such kind) fails HERE rather than wiping nothing.
      try { await runCol(s).deleteMany({}); } catch { /* the kind does not exist yet — the case will say so */ }
      shared.setReindexNeeded(s, false);
    }
    queue.resetEmbedPendingHint();
  });

  describe('the lifecycle', () => {
    it('startReindex writes the run document, with flagged, target and cursor, before it resolves', async () => {
      await seedFacts('life', 3);
      shared.setReindexNeeded('life', true);
      const decision = await reindex.planReindex({ spaceId: 'life', space: spaceConfig('life'), memberIds: ['life'] });
      assert.equal(decision.ok, true, JSON.stringify(decision));
      await reindex.startReindex(decision.plan);

      // Read at once: the promise resolving is the contract that the document exists.
      const doc = await runCol('life').findOne({ _id: 'run' });
      assert.ok(doc, 'no run document after startReindex resolved — a restart now would forget the run');
      assert.equal(doc.spaceId, 'life');
      assert.deepEqual(doc.members, ['life']);
      assert.equal(doc.flagged, true, 'flagged records that needsReindex was asserted when the run began');
      for (const k of ['model', 'dimensions', 'prefixScheme']) {
        assert.ok(k in (doc.target ?? {}), `target.${k} is missing — a resume could not tell the model changed`);
      }
      assert.ok('cursor' in doc, 'the cursor is what a resumed sweep continues from');
      assert.ok(doc.startedAt, 'startedAt is what the no-progress warning measures from');
    });

    it('before the sweep has queued anything, remaining already counts every record the run will rebuild', async () => {
      // Found by the Q-99 part 2 drive: the first poll after the POST read "0 left to rebuild" while 314 records
      // waited, because only queued jobs were counted. startReindex resolves before the sweep's first batch.
      // Held in that state deterministically: a run document whose sweep has not started (no process is sweeping
      // it), as after a restart before the resume, rather than racing a real sweep's first batch.
      const ids = await seedFacts('early', 7);
      await runCol('early').insertOne({
        _id: 'run', spaceId: 'early', members: ['early'], flagged: false, target: await currentTarget(),
        startedAt: new Date().toISOString(), cursor: null, sweepComplete: false,
        sweepLeaseAt: HELD_LEASE(), // a lease nobody lets go of: the watcher (armed by earlier cases) must not start the sweep this holds back
      });
      const first = await reindex.reindexStateFor(['early']);
      assert.equal(first.reindexRun.running, true);
      assert.equal(first.reindexRun.remaining, ids.length,
        'a run that has queued nothing yet still has every record left to rebuild — "0 left" reads as done');

      // Half queued: the queued jobs and the records not yet reached, each counted once.
      await queue.enqueueEmbedJobs('early', 'fact', ids.slice(0, 3), { priority: queue.EMBED_PRIORITY.rebuild, rebuild: true });
      await runCol('early').updateOne({ _id: 'run' }, { $set: { cursor: { kind: 'fact', lastId: ids[2] } } });
      assert.equal((await reindex.reindexStateFor(['early'])).reindexRun.remaining, ids.length,
        'records not yet queued plus the jobs queued — never the jobs twice, never the unqueued records dropped');
    });

    it('after the sweep and a drained queue, one tick clears needsReindex and deletes the document', async () => {
      const ids = await seedFacts('life', 4);
      shared.setReindexNeeded('life', true);
      const decision = await reindex.planReindex({ spaceId: 'life', space: spaceConfig('life'), memberIds: ['life'] });
      await reindex.startReindex(decision.plan);
      await sweepDone('life');

      // The sweep QUEUES; it embeds nothing itself. Every record is a rebuild job until the worker takes it.
      assert.deepEqual([...await rebuildQueued('life')].sort(), ids, 'every record must be queued as a rebuild');
      const mid = await reindex.reindexStateFor(['life']);
      assert.deepEqual(mid, { needsReindex: true, reindexRun: { running: true, remaining: ids.length, failed: 0 } },
        'while the jobs are queued the run is running and the flag is still asserted');

      // A tick before the queue drains must NOT finish the run: needsReindex refuses recall until it is done.
      await reindex.reindexRunTick();
      assert.ok(await runCol('life').findOne({ _id: 'run' }), 'a tick with rebuild jobs pending ended the run early');
      assert.equal(shared.needsReindex('life'), true);

      await drainQueue();
      await reindex.reindexRunTick();
      assert.equal(await runCol('life').findOne({ _id: 'run' }), null, 'a finished run must delete its document');
      assert.equal(shared.needsReindex('life'), false, 'a finished run must clear needsReindex');
      assert.deepEqual(await reindex.reindexStateFor(['life']),
        { needsReindex: false, reindexRun: { running: false, remaining: 0, failed: 0 } });
    });

    it('a written cursor names its kind in the embed record-type vocabulary', async () => {
      await seedFacts('life', 2);
      const decision = await reindex.planReindex({ spaceId: 'life', space: spaceConfig('life'), memberIds: ['life'] });
      await reindex.startReindex(decision.plan);
      await sweepDone('life');
      const { cursor } = await runCol('life').findOne({ _id: 'run' });
      assert.ok(cursor && queue.EMBED_RECORD_TYPES.includes(cursor.kind),
        `cursor.kind must be one of ${queue.EMBED_RECORD_TYPES.join(', ')}: ${JSON.stringify(cursor)}`);
    });
  });

  describe('a run survives a restart', () => {
    it('a sweep cut short resumes from its cursor: what is before it is not queued again, the rest is', async () => {
      const target = await currentTarget();
      const ids = await seedFacts('resume', 10);
      const lastId = ids[4];
      await runCol('resume').insertOne({
        _id: 'run', spaceId: 'resume', members: ['resume'], flagged: true, target,
        startedAt: new Date().toISOString(), cursor: { kind: 'fact', lastId }, sweepComplete: false,
      });

      await reindex.resumeReindexRuns();
      await sweepDone('resume');

      const queued = await rebuildQueued('resume');
      for (const id of ids) {
        if (id <= lastId) assert.equal(queued.has(id), false, `${id} is at or before the cursor and was queued again`);
        else assert.equal(queued.has(id), true, `${id} is after the cursor and was never queued`);
      }
      assert.equal(shared.needsReindex('resume'), true, 'a resumed flagged run keeps needsReindex asserted');
    });

    it('a run whose target no longer matches the configuration restarts from the start', async () => {
      const target = await currentTarget();
      const ids = await seedFacts('retarget', 6);
      // The model changed between the run starting and the restart: everything it had queued was for the old one.
      const stale = { ...target, model: `${target.model}-previous`, dimensions: Number(target.dimensions) + 1 };
      await runCol('retarget').insertOne({
        _id: 'run', spaceId: 'retarget', members: ['retarget'], flagged: true, target: stale,
        startedAt: new Date().toISOString(), cursor: { kind: 'fact', lastId: ids[ids.length - 1] }, sweepComplete: false,
      });

      await reindex.resumeReindexRuns();
      await sweepDone('retarget');

      assert.deepEqual([...await rebuildQueued('retarget')].sort(), ids,
        'a retargeted run must re-queue every record, including those its old cursor had passed');
      assert.deepEqual((await runCol('retarget').findOne({ _id: 'run' })).target, target,
        'and it must be re-stamped with the target it is now building for');
    });

    it('a sweep that keeps failing keeps the document, records the error, and keeps needsReindex asserted', async () => {
      await seedFacts('broken', 3);
      // An honest write failure: every insert into the job collection is refused by the server.
      await mongo.getDb().collection(spaceCollection('broken', 'embedJobs')).drop().catch(() => {});
      await mongo.getDb().createCollection(spaceCollection('broken', 'embedJobs'), {
        validator: { __reindexRunTestRefusesEveryJob: { $exists: true } }, validationAction: 'error',
      });
      try {
        shared.setReindexNeeded('broken', true);
        const decision = await reindex.planReindex({ spaceId: 'broken', space: spaceConfig('broken'), memberIds: ['broken'] });
        await reindex.startReindex(decision.plan);

        const doc = await until(async () => {
          const d = await runCol('broken').findOne({ _id: 'run' });
          return d?.error ? d : null;
        }, 'the run document to record the sweep error after its retries', 90_000);
        assert.equal(typeof doc.error, 'string');
        assert.notEqual(doc.sweepComplete, true, 'a failed sweep is not complete');

        await reindex.reindexRunTick();
        assert.ok(await runCol('broken').findOne({ _id: 'run' }), 'an errored run must keep its document');
        assert.equal(shared.needsReindex('broken'), true,
          'an errored run must keep needsReindex asserted — recall over half-rebuilt vectors is wrong in silence');
      } finally {
        await mongo.getDb().collection(spaceCollection('broken', 'embedJobs')).drop().catch(() => {});
      }
    });

    it('while a run document exists, initSpace answers needsReindex from its flagged', async () => {
      const target = await currentTarget();
      await runCol('flagged').insertOne({
        _id: 'run', spaceId: 'flagged', members: ['flagged'], flagged: true, target,
        startedAt: new Date().toISOString(), cursor: null, sweepComplete: false, sweepLeaseAt: HELD_LEASE(),
      });
      // No fact carries a different embeddingModel, so the sample check alone would answer false.
      await lifecycle.initSpace('flagged', { waitForVectorReady: false });
      assert.equal(shared.needsReindex('flagged'), true,
        'a boot during a flagged run must re-assert needsReindex in the same step, leaving no window');
    });
  });

  describe('the guard is per space', () => {
    const activeRun = (space, extra = {}) => runCol(space).insertOne({
      _id: 'run', spaceId: space, members: [space], flagged: false, target: { model: 'm', dimensions: DIMS, prefixScheme: 'none' },
      startedAt: new Date().toISOString(), cursor: null, sweepComplete: false, sweepLeaseAt: HELD_LEASE(), ...extra,
    });

    it('an active run in A refuses A with 409, naming only A; B is allowed', async () => {
      await activeRun('guard-a');
      const a = await reindex.planReindex({ spaceId: 'guard-a', space: spaceConfig('guard-a'), memberIds: ['guard-a'] });
      assert.equal(a.ok, false, 'a second reindex of a space with an active run must be refused');
      assert.equal(a.refusal.status, 409);
      const said = JSON.stringify(a.refusal.body);
      assert.match(said, /guard-a/, 'the refusal must name the space that is busy');
      assert.doesNotMatch(said, /guard-b|guard-c/, 'and only that space');

      const b = await reindex.planReindex({ spaceId: 'guard-b', space: spaceConfig('guard-b'), memberIds: ['guard-b'] });
      assert.equal(b.ok, true, `another space must not be refused: ${JSON.stringify(b)}`);
    });

    it('the instance-wide refusal is gone: a run started in B does not refuse C', async () => {
      await seedFacts('guard-b', 2);
      const b = await reindex.planReindex({ spaceId: 'guard-b', space: spaceConfig('guard-b'), memberIds: ['guard-b'] });
      await reindex.startReindex(b.plan);
      const c = await reindex.planReindex({ spaceId: 'guard-c', space: spaceConfig('guard-c'), memberIds: ['guard-c'] });
      assert.equal(c.ok, true, `a run in one space refused another: ${JSON.stringify(c)}`);
    });

    it('a run that ended in error does not block a new reindex of its space', async () => {
      await activeRun('guard-a', { error: 'sweep failed after 3 attempts' });
      const a = await reindex.planReindex({ spaceId: 'guard-a', space: spaceConfig('guard-a'), memberIds: ['guard-a'] });
      assert.equal(a.ok, true, `an errored run is not active, and must be replaceable: ${JSON.stringify(a)}`);
    });
  });

  describe('the gauge counts active runs', () => {
    it('ythril_reindex_in_progress is the number of active runs, through every change', async () => {
      await seedFacts('gauge-a', 2);
      await seedFacts('gauge-b', 2);

      registry.reindexInProgress.set(99);
      const a = await reindex.planReindex({ spaceId: 'gauge-a', space: spaceConfig('gauge-a'), memberIds: ['gauge-a'] });
      await reindex.startReindex(a.plan);
      assert.equal(await gauge(), 1, 'one active run');

      registry.reindexInProgress.set(99);
      const b = await reindex.planReindex({ spaceId: 'gauge-b', space: spaceConfig('gauge-b'), memberIds: ['gauge-b'] });
      await reindex.startReindex(b.plan);
      assert.equal(await gauge(), 2, 'two active runs are two, not 1');

      await sweepDone('gauge-a');
      await sweepDone('gauge-b');
      await drainQueue();
      registry.reindexInProgress.set(99);
      await reindex.reindexRunTick();
      assert.equal(await gauge(), 0, 'with both runs finished the gauge reads 0');
    });
  });
});

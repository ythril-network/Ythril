/**
 * A space's version continues above the high-water mark this instance keeps OUTSIDE the database (Q-556, bundle-163).
 *
 * ## The finding this holds
 *
 * A space's version counter lives in `ythril_counters`, in the database. A restore onto an empty database, a counter wipe (`docker compose
 * down -v` with config.json kept), an admin import onto an emptied instance, or a rename whose counter move failed leaves the counter BELOW
 * versions this instance already handed out. The next edit is then stamped below the copy the peers hold, and every peer keeps its own
 * (the newer one wins on a version compare): the edit is lost on every peer, with no error on either side.
 *
 * Probed on 7c81b63e: a record X held at version 6 by a peer, a restore onto an
 * empty database from a backup whose counter was 3, and the first edit of X stamped 4.
 *
 * The rule (owner decision 2026-10-28): the instance keeps the high-water of its versions in config.json (`versionMarks`, saved in steps
 * in the background, no write waits on it), and a space's FIRST allocation in a process, and every allocation that finds its counter has
 * gone BACKWARDS while the process runs, raises the counter to that mark before it stamps. `reportDatabaseReplaced()` (the end of a
 * restore) makes the next allocation a first one again.
 *
 * ## What is held, one case each
 *
 * - a. a fresh process, config.json holds a mark, `ythril_counters` is empty (the counter wipe, and a restart): the FIRST stamp is above
 *      the mark. Each node:test file is its own process, so this is a real first allocation.
 * - b. a restore onto an empty database (dump, edit X to a higher version, drop the counters and the space's collections,
 *      `restoreDatabase`, `reportDatabaseReplaced`): the FIRST edit of X stamps above the version that left.
 * - c. a counter that goes backwards while the process runs (allocate, delete the counter doc, allocate): the stamp is above the mark.
 * - d. the mark is recorded: after `flushConfig()` config.json holds `versionMarks[space] === min(counter + STEP, VERSION_FLOOR_CAP - STEP)`
 *      exactly, and at the cap the mark clamps to `VERSION_FLOOR_CAP - STEP`.
 * - e. the raise is visible: `ythril_version_counter_raised_total{reason="start"}` after case a, `{reason="went_back"}` after case c.
 *
 * ## Seen red
 *
 * On 7c81b63e (no `util/version-mark.ts`, no `versionMarks`): a stamps 1 against a mark of 5000, b stamps 4 against a version of 6, c stamps 1
 * after 4, d finds config.json holding the preset 50 (and no entry at all at the cap), e finds no such metric. Every case runs; none depends
 * on the new module being importable (`version-mark.js` is read through `markModule()`, which answers `null` while it does not exist).
 *
 * STEP is `VERSION_MARK_STEP` of `util/version-mark.ts` (100_000); it is written out here because a test that derives its expectation from
 * the code under test asserts that the code equals itself (the standalone twin of this file holds that the module exports this number).
 *
 * Database: ythril_harness_q556_mark. Run: node --test testing/standalone/a-version-continues-above-the-mark-kept-outside-the-database-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo: `npm run test:up`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'ythril-q556-mark-'));
const CONFIG_PATH = join(tmpDir, 'config.json');
// Read at module load by the loader: set BEFORE anything of the server is imported.
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const S = '../../server/dist/';
// A literal specifier: the standalone split finds a database-backed file by this import and runs it in a capped batch.
const { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } = await import('./_mongo-harness.mjs');
const skip = await mongoSkipReason();

const DB = 'ythril_harness_q556_mark';
/** `VERSION_MARK_STEP` (util/version-mark.ts), as the design states it. */
const STEP = 100_000;
/** The marks config.json holds when the process starts. */
const MARK_S1 = 5_000;
const MARK_S4 = 50;

let mongo, db, loader, stamp, registry, cap;
/** What cases a and c saw, for the metric cases (e) that run after them. */
const observed = {};

/** `util/version-mark.js`, or `null` while it does not exist: a missing module is a failed assertion in the case, never a crash of the file. */
async function markModule() {
  try { return await import(`${S}util/version-mark.js`); } catch { return null; }
}

/** The metric's value for one `reason`, or `null` when the metric is not registered. */
async function raisedTotal(reason) {
  const m = registry.register.getSingleMetric('ythril_version_counter_raised_total');
  if (!m) return null;
  const { values } = await m.get();
  return values.filter(v => v.labels.reason === reason).reduce((sum, v) => sum + v.value, 0);
}

const counterDoc = (id) => db.collection('ythril_counters').findOne({ _id: id });
const firstStamp = async (space, id = 'X') => (await stamp.versionsFor(space, [id], { parts: ['facts'] }))[0].version;
const diskMarks = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).versionMarks ?? {};

async function dropEverything() {
  for (const c of await db.listCollections().toArray()) await db.collection(c.name).drop();
}

describe('a version continues above the mark kept outside the database', { skip }, () => {
  before(async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'q556-instance', instanceLabel: 'q556', spaces: [], tokens: [], networks: [],
      versionMarks: { s1: MARK_S1, s4: MARK_S4 },
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    mongo = await openTestMongo('q556_mark');
    db = mongo.getDb();
    // Loaded the way boot loads them: the stamping module and the metrics registry are in memory BEFORE the config is read.
    stamp = await import(`${S}util/version-stamp.js`);
    registry = await import(`${S}metrics/registry.js`);
    ({ VERSION_FLOOR_CAP: cap } = await import(`${S}util/seq.js`));
    loader = await import(`${S}config/loader.js`);
    loader.loadConfig();
  });

  after(async () => {
    await closeTestMongo();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Not for case a: its premise is a database that holds nothing, and `openTestMongo` dropped it. A later case starts as empty as that.
  beforeEach(async () => { if (db) await dropEverything(); });

  it('a. a fresh process whose config.json holds a mark and whose counters are empty: the first stamp is above the mark', async () => {
    assert.equal(await counterDoc('s1'), null, 'fixture: the counter is not empty');
    const before = await raisedTotal('start');
    const version = await firstStamp('s1');
    observed.start = { before, after: await raisedTotal('start') };
    assert.ok(version > MARK_S1,
      `the first stamp of a space after a counter wipe was ${version}, at or below the mark ${MARK_S1} that config.json holds: an edit stamped there is lost on every peer`);
  });

  it('b. a restore onto an empty database: the first edit stamps above the version that left', async () => {
    const dir = mkdtempSync(join(tmpDir, 'dump-'));
    const uri = testMongoUri(DB);
    const { dumpDatabase } = await import(`${S}db/dump.js`);
    const { restoreDatabase } = await import(`${S}db/restore.js`);

    // The backup moment: X at version 2, counter 3.
    await db.collection('s2_facts').insertOne({ _id: 'X', spaceId: 's2', seq: 2 });
    await db.collection('ythril_counters').insertOne({ _id: 's2', seq: 3 });
    await dumpDatabase(uri, dir);

    // Three edits after the backup; the last version is the one a peer holds.
    let left = 0;
    for (let i = 0; i < 3; i++) {
      left = await firstStamp('s2');
      await db.collection('s2_facts').updateOne({ _id: 'X' }, { $set: { seq: left } });
    }
    assert.ok(left > 3, `fixture: the edits did not move X past the backup (${left})`);

    // The whole database is lost and a restore lays the backup onto an EMPTY one.
    await dropEverything();
    await restoreDatabase(uri, dir);
    mongo.reportDatabaseReplaced();

    const version = await firstStamp('s2');
    assert.ok(version > left,
      `the first edit of X after a restore onto an empty database stamped ${version}, at or below ${left}, the version the peers hold: the edit is lost on every peer`);
  });

  it('c. a counter that goes backwards while running: the next stamp is above the mark', async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) last = await firstStamp('s3');
    assert.ok(last >= 4, `fixture: four allocations ended at ${last}`);

    await db.collection('ythril_counters').deleteOne({ _id: 's3' });   // the counter goes back to nothing, the process keeps running
    const before = await raisedTotal('went_back');
    const version = await firstStamp('s3');
    observed.wentBack = { before, after: await raisedTotal('went_back') };

    assert.ok(version > last, `after the counter went back the stamp was ${version}, at or below ${last}, a version this instance had already handed out`);
    assert.ok(version > STEP, `after the counter went back the stamp was ${version}, not above the mark (at least ${STEP}) the earlier allocations set`);
  });

  it('d. the mark is recorded: config.json holds min(counter + STEP, VERSION_FLOOR_CAP - STEP) exactly', async () => {
    await firstStamp('s4');                                  // one allocation, past the preset mark of 50
    const counter = (await counterDoc('s4')).seq;
    await loader.flushConfig();
    assert.equal(diskMarks().s4, Math.min(counter + STEP, cap - STEP),
      `config.json holds ${JSON.stringify(diskMarks().s4)} for the space whose counter is ${counter}, not counter + ${STEP}`);
  });

  it('d. at the cap the recorded mark clamps to VERSION_FLOOR_CAP - STEP', async () => {
    await db.collection('ythril_counters').insertOne({ _id: 's5', seq: cap - 10 });
    await firstStamp('s5');
    const counter = (await counterDoc('s5')).seq;
    assert.ok(counter + STEP > cap - STEP, `fixture: the counter ${counter} is not near the cap`);
    await loader.flushConfig();
    assert.equal(diskMarks().s5, cap - STEP,
      `config.json holds ${JSON.stringify(diskMarks().s5)} for a counter near the cap, not VERSION_FLOOR_CAP - STEP (${cap - STEP})`);
  });

  it('d. the module states the step the cases above assume', async () => {
    const mod = await markModule();
    assert.ok(mod, 'server/dist/util/version-mark.js does not exist: nothing owns the mark');
    assert.equal(mod.VERSION_MARK_STEP, STEP);
  });

  it('e. a raise at the start of a process is counted: ythril_version_counter_raised_total{reason="start"}', () => {
    assert.ok(observed.start, 'fixture: case a did not reach its measurement');
    assert.notEqual(observed.start.after, null, 'ythril_version_counter_raised_total is not registered');
    assert.ok(observed.start.after - (observed.start.before ?? 0) >= 1,
      `the raise at the start of the process was not counted (${observed.start.before} -> ${observed.start.after})`);
  });

  it('e. a raise after the counter went back is counted: ythril_version_counter_raised_total{reason="went_back"}', () => {
    assert.ok(observed.wentBack, 'fixture: case c did not reach its measurement');
    assert.notEqual(observed.wentBack.after, null, 'ythril_version_counter_raised_total is not registered');
    assert.ok(observed.wentBack.after - (observed.wentBack.before ?? 0) >= 1,
      `the raise after the counter went back was not counted (${observed.wentBack.before} -> ${observed.wentBack.after})`);
  });
});

// A left-over temp dir would be a file nobody asked for.
process.on('exit', () => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

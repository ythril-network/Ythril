/**
 * One space's trouble does not stop the candidate prune or the tombstone prune (`Q-274`, `Q-358`, `Q-317`; bundle-53 G17).
 * Against the real store: a view whose reads FAIL, a view whose reads STALL, a document another session holds, so the
 * failure is the driver's and the server's own.
 *
 * ## The defect it prevents
 *
 * Both pruners walked the spaces with a `catch` of their own around the delete and a `log.warn` on every pass:
 *
 *  - **a failure said again every cycle.** A space whose candidates could not be read printed one line per pass for as long as
 *    it stayed broken, and one lookup failure (`readStoredById` inside `pruneSpaceCandidates`) was swallowed with no line at
 *    all, so a space that never pruned was indistinguishable from a space with nothing to prune;
 *  - **a hang held the walk.** Nothing bounded the operations, so one space whose read or write never returned held the
 *    prune, and with it every later six-hour tick (the timer skipped an overlapping tick, which turned the prune OFF).
 *
 * ## What is held
 *
 *  - candidate prune: a space whose `dupe_candidates` cannot be read is said ONCE (under its own step, with the collection
 *    named and when it is retried), its OTHER collection is still pruned, and the space behind it is pruned; a lookup that
 *    fails keeps every finding (fail closed) and is said; a read that hangs ends at the housekeeping bound, is said once, and
 *    the space behind it is pruned;
 *  - tombstone prune: the two halves are independent: the record half failing does not stop the file half, and the reverse;
 *    each is said once, with its half named; a delete that hangs behind another session's lock ends at the bound, is said once,
 *    and the space behind it is pruned;
 *  - both timers are interval jobs (`util/interval-job.ts`), which name themselves at construction.
 *
 * A faulty space sits BEFORE the healthy one in the config in every case: a walk that stops at the first failure leaves
 * exactly the spaces after it unpruned. A hung space is quarantined for a minute by the process-wide walk, so each hang case
 * has a space of its own.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-stop-the-prunes-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { holdDocumentLock, setWriteBoundForTest, settleWithin, withCollectionAsView, withStalledReads } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-prunes-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const GENERAL = 'general';
/** Spaces that sit BEFORE the healthy ones in the config, each with the one fault it is armed with. */
const FAILING = 'failing';
const LOOKUP = 'lookupfails';
const HUNG_CANDIDATES = 'hungcands';
const LOCKED = 'lockedtombs';
const OK = 'healthy';
const ALL = [FAILING, LOOKUP, HUNG_CANDIDATES, LOCKED, GENERAL, OK];

const BOUND_MS = 1000;
const STALL_MS = 3000;
const CANDIDATE_STEP = 'Candidate prune';
const TOMBSTONE_STEP = 'Tombstone prune';

let mongo, candidate, tombstone, signals;

const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
/** A finding about two records that do not exist: the pruner removes it. */
const orphan = (id) => ({ _id: id, type: 'fact', aId: `${id}-a`, bId: `${id}-b`, status: 'open' });
const recordTombstone = (space, seq) => ({ _id: `${space}-t${seq}`, spaceId: space, type: 'fact', deletedAt: iso(1), instanceId: 'self', seq });
const fileTombstone = (space, day) => ({ _id: `${space}-f${day}`, spaceId: space, path: `p/report-${day}.pdf`, deletedAt: iso(day) });
const idsIn = async (collection) => (await mongo.col(collection).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
/**
 * The lines that say `step` failed for `space`. A unit's failure names the unit; a TIMEOUT ends the whole space, so the walk says
 * it for the space and no unit is named (`unit` left out).
 */
const lineFor = (lines, step, space, unit) => lines.filter(l => l.includes(`${step} failed for space '${space}'${unit === undefined ? ':' : ` (${unit})`}`));
/** A source whose document cannot be turned into a number: a view over it with `$toInt` fails a read that reaches it. */
const failingPipeline = [{ $addFields: { _x: { $toInt: '$f' } } }];

describe('one space\'s trouble does not stop the prunes', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('prunes');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'prunes-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: ALL.map(id => ({ id, label: id, builtIn: id === GENERAL, folders: [] })),
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    candidate = await import('../../server/dist/brain/candidate-prune.js');
    tombstone = await import('../../server/dist/brain/tombstone-prune.js');
    signals = await import('../../server/dist/util/housekeeping-signals.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of ALL) {
      for (const c of ['dupe_candidates', 'contradiction_candidates', 'tombstones', 'file_tombstones', 'facts']) {
        await mongo.col(`${space}_${c}`).deleteMany({});
      }
    }
  });

  describe('candidate prune', () => {
    it('a space whose candidates cannot be read is said once; its other collection and the spaces behind it are still pruned', async () => {
      const db = mongo.getDb();
      await mongo.col(`${FAILING}_contradiction_candidates`).insertOne(orphan('f-c1'));
      await mongo.col(`${OK}_dupe_candidates`).insertMany([orphan('ok-d1'), orphan('ok-d2')]);
      await mongo.col(`${OK}_contradiction_candidates`).insertOne(orphan('ok-c1'));
      await db.collection(`${FAILING}_src`).insertOne({ _id: 'bad', f: 'not a number' });
      let first, second;
      try {
        await withCollectionAsView(db, `${FAILING}_dupe_candidates`, `${FAILING}_src`, async () => {
          first = await logLinesDuring(() => candidate.pruneAllSpaces());
          second = await logLinesDuring(() => candidate.pruneAllSpaces());
        }, { pipeline: failingPipeline });
      } finally {
        await db.collection(`${FAILING}_src`).deleteMany({});
      }

      assert.deepEqual(await idsIn(`${OK}_dupe_candidates`), [], 'the healthy space is pruned although the failing one sits before it');
      assert.deepEqual(await idsIn(`${OK}_contradiction_candidates`), []);
      assert.deepEqual(await idsIn(`${FAILING}_contradiction_candidates`), [],
        'the failing space\'s OTHER collection is pruned: a collection is a unit, one failing does not end the space');
      const said = lineFor(first.lines, CANDIDATE_STEP, FAILING, 'dupe_candidates');
      assert.equal(said.length, 1, `said once, with the collection named: ${first.lines.join(' | ')}`);
      assert.match(said[0], /retried next cycle/);
      assert.equal(lineFor(second.lines, CANDIDATE_STEP, FAILING, 'dupe_candidates').length, 0,
        'a condition that persists is said once per window, not once per pass');
      assert.ok(first.result.walk.failed.some(f => f.spaceId === FAILING && f.unit === 'dupe_candidates'),
        `the walk returns what failed: ${JSON.stringify(first.result.walk?.failed)}`);
    });

    it('a lookup that fails keeps every finding and is said (it used to be swallowed without a line)', async () => {
      const db = mongo.getDb();
      await mongo.col(`${LOOKUP}_dupe_candidates`).insertOne({ _id: 'keep-me', type: 'fact', aId: 'fx-a', bId: 'fx-b', status: 'open' });
      // The records the finding names live in a view whose read throws for `fx-a`: the existence lookup fails.
      await db.collection(`${LOOKUP}_src`).insertOne({ _id: 'fx-a', f: 'not a number' });
      let ran;
      try {
        await withCollectionAsView(db, `${LOOKUP}_facts`, `${LOOKUP}_src`, async () => {
          ran = await logLinesDuring(() => candidate.pruneAllSpaces());
        }, { pipeline: failingPipeline });
      } finally {
        await db.collection(`${LOOKUP}_src`).deleteMany({});
      }
      assert.deepEqual(await idsIn(`${LOOKUP}_dupe_candidates`), ['keep-me'],
        'fail closed: a lookup that could not be made must not read as "the records are gone"');
      assert.equal(lineFor(ran.lines, CANDIDATE_STEP, LOOKUP, 'dupe_candidates').length, 1,
        `and the space that never prunes is said, not silent: ${ran.lines.join(' | ')}`);
    });

    it('a read that HANGS ends at the housekeeping bound, is said once, and the space behind it is pruned', async () => {
      const db = mongo.getDb();
      await mongo.col(`${OK}_dupe_candidates`).insertOne(orphan('ok-hung-d'));
      const restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
      let outcome, lines;
      try {
        // The reader's filter is empty (`find({})`), so every source document of the view reaches the stalling stage.
        await withStalledReads(db, `${HUNG_CANDIDATES}_dupe_candidates`, `${HUNG_CANDIDATES}_dupe_src`, { ms: STALL_MS }, async () => {
          ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(candidate.pruneAllSpaces(), STALL_MS - 200)));
          if (!outcome.settled) await outcome.rest;   // the stall's own end is waited for before the view is put back
        });
      } finally {
        await restoreBound();
      }
      assert.ok(outcome.settled, `the prune was still waiting after ${outcome.elapsedMs} ms on a read that stalls for ${STALL_MS} ms: nothing ended it at the ${BOUND_MS} ms bound`);
      assert.equal(outcome.ok, true, `the prune answers for a hung space: ${outcome.error}`);
      assert.deepEqual(await idsIn(`${OK}_dupe_candidates`), [], 'the space behind the hung one was pruned');
      const said = lineFor(lines, CANDIDATE_STEP, HUNG_CANDIDATES);
      assert.equal(said.length, 1, `said once: ${lines.join(' | ')}`);
      assert.match(said[0], new RegExp(`time bound of ${BOUND_MS} ms`), 'in the words of the bound it ran into');
    });
  });

  describe('tombstone prune', () => {
    const seed = async (space) => {
      await mongo.col(`${space}_tombstones`).insertMany([recordTombstone(space, 1), recordTombstone(space, 2)]);
      await mongo.col(`${space}_file_tombstones`).insertMany([fileTombstone(space, 1), fileTombstone(space, 2)]);
    };

    it('the record half failing does not stop the file half or the spaces behind it; it is said once, with its half named', async () => {
      const db = mongo.getDb();
      await seed(FAILING); await seed(OK);
      await db.collection(`${FAILING}_tsrc`).insertOne({ _id: 'x' });
      let first, second;
      try {
        // A view takes no write: the record tombstones' delete fails at the command.
        await withCollectionAsView(db, `${FAILING}_tombstones`, `${FAILING}_tsrc`, async () => {
          first = await logLinesDuring(() => tombstone.pruneAllTombstones());
          second = await logLinesDuring(() => tombstone.pruneAllTombstones());
        });
      } finally {
        await db.collection(`${FAILING}_tsrc`).deleteMany({});
      }
      assert.deepEqual(await idsIn(`${FAILING}_file_tombstones`), [], 'the file half still ran in the space whose record half failed');
      assert.deepEqual(await idsIn(`${OK}_tombstones`), [], 'the space behind it is pruned (records)');
      assert.deepEqual(await idsIn(`${OK}_file_tombstones`), [], 'and (files)');
      const said = lineFor(first.lines, TOMBSTONE_STEP, FAILING, 'record tombstones');
      assert.equal(said.length, 1, `said once with the half named: ${first.lines.join(' | ')}`);
      assert.match(said[0], /retried next cycle/);
      assert.equal(lineFor(second.lines, TOMBSTONE_STEP, FAILING, 'record tombstones').length, 0, 'not said again within the window');
      assert.ok(first.result.walk.failed.some(f => f.spaceId === FAILING && f.unit === 'record tombstones'),
        `the walk returns what failed: ${JSON.stringify(first.result.walk?.failed)}`);
    });

    it('the file half failing does not stop the record half; it is said once, with its half named', async () => {
      const db = mongo.getDb();
      await seed(FAILING); await seed(OK);
      await db.collection(`${FAILING}_tsrc`).insertOne({ _id: 'x' });
      let ran;
      try {
        await withCollectionAsView(db, `${FAILING}_file_tombstones`, `${FAILING}_tsrc`, async () => {
          ran = await logLinesDuring(() => tombstone.pruneAllTombstones());
        });
      } finally {
        await db.collection(`${FAILING}_tsrc`).deleteMany({});
      }
      assert.deepEqual(await idsIn(`${FAILING}_tombstones`), [], 'the record half is independent of the file half');
      assert.deepEqual(await idsIn(`${OK}_file_tombstones`), [], 'the space behind it is pruned');
      assert.equal(lineFor(ran.lines, TOMBSTONE_STEP, FAILING, 'file tombstones').length, 1, `said once: ${ran.lines.join(' | ')}`);
    });

    it('a delete that HANGS behind another session\'s lock ends at the bound, is said once, and the space behind it is pruned', async () => {
      await seed(LOCKED); await seed(OK);
      const restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
      const lock = await holdDocumentLock(mongo, `${LOCKED}_tombstones`, { filter: { _id: `${LOCKED}-t1` } });
      let outcome, lines;
      try {
        ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(tombstone.pruneAllTombstones(), 2_500)));
      } finally {
        await lock.release();   // drains the write the lock held, so nothing lands after the case
        await restoreBound();
      }
      if (!outcome.settled) await outcome.rest;
      assert.ok(outcome.settled, `the prune was still waiting after ${outcome.elapsedMs} ms on a delete behind a held lock: nothing ended it at the ${BOUND_MS} ms bound`);
      assert.equal(outcome.ok, true, `the prune answers for a hung space: ${outcome.error}`);
      assert.deepEqual(await idsIn(`${OK}_tombstones`), [], 'the space behind the hung one was pruned');
      const said = lineFor(lines, TOMBSTONE_STEP, LOCKED);
      assert.equal(said.length, 1, `said once: ${lines.join(' | ')}`);
      assert.match(said[0], new RegExp(`time bound of ${BOUND_MS} ms`));
    });
  });

  it('both timers are interval jobs: each names itself at construction', () => {
    const jobs = signals.declaredJobs();
    for (const job of [CANDIDATE_STEP, TOMBSTONE_STEP]) {
      assert.ok(jobs.includes(job), `'${job}' is not a declared interval job (${jobs.join(', ')}): its timer is a bare setInterval`);
    }
  });
});

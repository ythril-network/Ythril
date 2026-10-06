/**
 * The spills older versions wrote INTO a space are swept locally, and nothing else is touched.
 *
 * ## Why (Q-92, design point 8)
 *
 * Before 5.6.0 a recall's remainder and an over-cap traversal were written as root `_tmp/results-<uuid>.json` and
 * `_tmp/graph-<uuid>.json`, with a `<space>_files` record. They replicated, and a pulled copy never expired
 * (`_expireAt` is local-only). Sync now carries the shape in neither direction, so what is left is local: the
 * sweep deletes it.
 *
 * - **By PATH, not by tag.** Metadata can arrive before its blob, and a blob can outlive its record, so a sweep
 *   keyed on the FileMeta tag leaves one half behind and finds it again for ever.
 * - **Hard, with no tombstone and no webhook.** No transport carries the path any more, so a tombstone would be
 *   a deletion notice for something no peer is sent; and a burst of unattributed `file.deleted` webhooks on
 *   upgrade would tell consumers a person deleted files.
 * - **Only the root shape.** `notes/_tmp/graph-….json` is a user's own folder and stays.
 * - **Recurring, inside the hourly TTL sweep**, because older peers keep sending spills until they upgrade —
 *   a boot-once sweep would leave every one that arrived after it.
 *
 * ## One space's trouble is that space's (Q-274, Q-358, bundle-53 G11)
 *
 * The sweep walks every space through `eachSpace`, so a space whose read FAILS or HANGS is reported once and the
 * next space is still swept; a directory that cannot be read for any reason but "it is not there" is that space's
 * failure and not an empty listing; and a half-finished removal is redone, not orphaned (`fileHashes` goes before the
 * `files` record, which stays the finder). The cases name a faulty space that sits BEFORE the healthy one in the
 * config, because a walk that stops at the first failure leaves exactly the spaces after it unswept.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-legacy-spill-is-swept-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';
import { failWrites, setWriteBoundForTest, settleWithin, withCollectionAsView, withStalledReads } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-spill-sweep-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'general';
const SECOND = 'second';
/** Spaces that sit BEFORE the healthy ones in the config, each armed by exactly one case (a hung space is quarantined for a minute). */
const FAILING = 'failing';
const HUNG = 'hung';
const UNREADABLE = 'unreadable';
const ALL = [FAILING, HUNG, UNREADABLE, SPACE, SECOND];
const ROOT = path.join(tmpDir, 'files', SPACE);
const STEP = 'Legacy spill sweep';

const BOTH = `_tmp/graph-${randomUUID()}.json`;          // blob and FileMeta
const BLOB_ONLY = `_tmp/results-${randomUUID()}.json`;   // a blob whose record is gone
const META_ONLY = `_tmp/graph-${randomUUID()}.json`;     // a record whose blob never arrived
const USERS_OWN = `notes/_tmp/graph-${randomUUID()}.json`;
const NOTE = 'notes/a.md';
const NOT_A_SPILL = '_tmp/scratch.json';                 // a root _tmp file that is not the spill shape
const SECOND_SPILL = `_tmp/results-${randomUUID()}.json`; // a spill in the second healthy space

let mongo, sweepMod;

const abs = (rel, space = SPACE) => path.join(tmpDir, 'files', space, ...rel.split('/'));
const put = (rel, body, space = SPACE) => { fs.mkdirSync(path.dirname(abs(rel, space)), { recursive: true }); fs.writeFileSync(abs(rel, space), body); };
const meta = (rel, space = SPACE) => ({
  _id: rel, spaceId: space, path: rel, description: '', tags: [rel.startsWith('_tmp/graph') ? 'graph-spill' : 'result-spill'],
  author: { instanceId: 'old-peer', instanceLabel: 'Old' },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1,
});
const idsIn = async (collection) => (await mongo.col(collection).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
const lineFor = (lines, space) => lines.filter(l => l.includes(`${STEP} failed for space '${space}'`));

describe('legacy read spills are swept from the space', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('spillsweep');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'spill-sweep-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: ALL.map(id => ({ id, label: id, builtIn: id === SPACE, folders: [] })),
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    sweepMod = await import('../../server/dist/files/legacy-spill-sweep.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of ALL) {
      fs.rmSync(path.join(tmpDir, 'files', space), { recursive: true, force: true });
      for (const c of ['files', 'fileTombstones', 'file_hashes']) await mongo.col(`${space}_${c}`).deleteMany({});
    }
    await mongo.col('audit_log').deleteMany({});
    put(BOTH, '{"kind":"graph-traversal"}');
    put(BLOB_ONLY, '{"kind":"recall-results"}');
    put(USERS_OWN, '{"mine":true}');
    put(NOTE, 'a real note');
    put(NOT_A_SPILL, '{}');
    await mongo.col(`${SPACE}_files`).insertMany([meta(BOTH), meta(META_ONLY), meta(USERS_OWN), meta(NOTE), meta(NOT_A_SPILL)]);
  });

  it('removes every half of every spill, by path, and nothing else', async () => {
    const res = await sweepMod.sweepLegacySpills();
    for (const rel of [BOTH, BLOB_ONLY]) assert.equal(fs.existsSync(abs(rel)), false, `the blob ${rel} survived the sweep`);
    const ids = (await mongo.col(`${SPACE}_files`).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
    assert.deepEqual(ids, [NOT_A_SPILL, NOTE, USERS_OWN].sort(),
      'the spill records are gone, a record without its blob included, and every other record is kept');
    for (const rel of [USERS_OWN, NOTE, NOT_A_SPILL]) assert.ok(fs.existsSync(abs(rel)), `${rel} is not a spill and must stay`);
    assert.equal(res.removed, 3, `three spills, counted once each whichever half was present: ${JSON.stringify(res)}`);
    assert.deepEqual(res.failed, [],
      'a space with no `_tmp` directory has no spills: the directory not being there is an answer, and nothing to report');
  });

  it('writes no tombstone, and a second run finds nothing', async () => {
    await sweepMod.sweepLegacySpills();
    assert.equal(await mongo.col(`${SPACE}_fileTombstones`).countDocuments({}), 0,
      'no transport carries the path any more, so a tombstone would announce a deletion nobody is sent');
    const again = await sweepMod.sweepLegacySpills();
    assert.equal(again.removed, 0, 'idempotent: a spill once swept is not found again');
  });

  it('runs inside the hourly TTL sweep, not once at boot', () => {
    const src = stripComments(fs.readFileSync('server/src/brain/ttl-sweep.ts', 'utf8'));
    assert.match(src, /sweepLegacySpills\(/,
      'older peers keep sending spills until they upgrade, so a boot-once sweep leaves every later arrival');
  });

  describe('one space\'s trouble is that space\'s (Q-274, Q-358)', () => {
    it('a space whose read FAILS is reported once, and the spaces after it are still swept', async () => {
      put(SECOND_SPILL, '{}', SECOND);
      await mongo.col(`${SECOND}_files`).insertOne(meta(SECOND_SPILL, SECOND));
      const db = mongo.getDb();
      // The view's stage runs over the SOURCE, so the read throws for a source document whose field is not a number.
      await db.collection(`${FAILING}_src`).insertOne({ _id: `_tmp/graph-${randomUUID()}.json`, f: 'not a number' });
      let first, second, lines;
      try {
        await withCollectionAsView(db, `${FAILING}_files`, `${FAILING}_src`, async () => {
          ({ lines, result: first } = await logLinesDuring(() => sweepMod.sweepLegacySpills()));
          ({ result: second } = await logLinesDuring(() => sweepMod.sweepLegacySpills()));
        }, { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
      } finally {
        await db.collection(`${FAILING}_src`).deleteMany({});
      }

      assert.equal(first.removed, 4, `the failing space is first in the config, yet general's three spills and the second space's one all went: ${JSON.stringify(first)}`);
      assert.equal(await idsIn(`${SPACE}_files`).then(ids => ids.includes(BOTH) || ids.includes(META_ONLY)), false, 'general\'s spill records are gone');
      assert.equal(await idsIn(`${SECOND}_files`).then(ids => ids.length), 0, 'and so are the SECOND healthy space\'s: the walk did not stop at the first failure');
      assert.ok(first.failed.some(f => f.spaceId === FAILING), `the failing space is in the result the sweep returns: ${JSON.stringify(first.failed)}`);
      assert.ok(first.failed.every(f => f.spaceId === FAILING), `and nothing else is: ${JSON.stringify(first.failed)}`);
      assert.ok(second.failed.some(f => f.spaceId === FAILING), 'a next run reports it again to its caller');
      const said = lineFor(lines, FAILING);
      assert.equal(said.length, 1, `reported once, by name, with when it is retried: ${said.join(' | ')}`);
      assert.match(said[0], /retried next cycle/);
    });

    it('a space whose read HANGS ends at the housekeeping bound, is reported once, and the spaces after it are swept', async () => {
      const db = mongo.getDb();
      // The stall costs a sleep per source document the READER's filter lets through, and the sweep's filter is an
      // anchored `_tmp/` prefix on `_id` (`files/legacy-spill-sweep.ts`): the guard reads with that filter, and the seeds are
      // documents of that shape, or the stage is never reached.
      const { SPILL_DIR } = await import('../../server/dist/brain/spill-path.js');
      const readerFilter = { _id: { $regex: `^${SPILL_DIR}/` } };
      const seed = Array.from({ length: 20 }, () => ({ _id: `_tmp/graph-${randomUUID()}.json` }));
      const restoreBound = await setWriteBoundForTest({ housekeepingOpMs: 1_000 });
      let outcome, lines;
      try {
        await withStalledReads(db, `${HUNG}_files`, `${HUNG}_src`, { ms: 3_000, readerFilter, seed }, async () => {
          ({ lines, result: outcome } = await logLinesDuring(() => settleWithin(sweepMod.sweepLegacySpills(), 2_800)));
          // Left unsettled, the stall's own end is waited for before the view is put back.
          if (!outcome.settled) await outcome.rest;
        });
      } finally {
        restoreBound();
      }

      assert.ok(outcome.settled, `the sweep was still waiting after ${outcome.elapsedMs}ms on a read that stalls for 4000ms: nothing ended it at the 1000ms bound`);
      assert.equal(outcome.ok, true, `the sweep returns its result for a hung space: ${outcome.error}`);
      const res = outcome.value;
      assert.equal(res.removed, 3, `general sits after the hung space and was swept: ${JSON.stringify(res)}`);
      assert.ok(res.failed.some(f => f.spaceId === HUNG), `the hung space is in the result: ${JSON.stringify(res.failed)}`);
      const said = lineFor(lines, HUNG);
      assert.equal(said.length, 1, `reported once: ${said.join(' | ')}`);
      assert.match(said[0], /time bound of 1000 ms/, 'in the words of the bound it ran into');
    });

    it('a directory that cannot be read, for any reason but not being there, is reported and not taken for an empty one', async () => {
      const unreadableDir = path.join(tmpDir, 'files', UNREADABLE, '_tmp');
      fs.mkdirSync(unreadableDir, { recursive: true });
      const real = fsp.readdir;
      // A permission failure, produced where the sweep reads: a real one cannot be arranged the same way on every platform.
      fsp.readdir = (dir, ...rest) => {
        if (path.resolve(String(dir)) === path.resolve(unreadableDir)) {
          return Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' }));
        }
        return real.call(fsp, dir, ...rest);
      };
      let res, lines;
      try {
        ({ result: res, lines } = await logLinesDuring(() => sweepMod.sweepLegacySpills()));
      } finally { fsp.readdir = real; }

      assert.equal(res.removed, 3, `the spaces after the unreadable one are swept: ${JSON.stringify(res)}`);
      assert.ok(res.failed.some(f => f.spaceId === UNREADABLE && /EACCES/.test(f.error)), `the unreadable directory is in the result, with its reason: ${JSON.stringify(res.failed)}`);
      assert.equal(lineFor(lines, UNREADABLE).length, 1, `and said once: ${lines.join(' | ')}`);
    });

    it('a failed `files` delete leaves the `files` record as the finder, with its `fileHashes` row already gone; the next run completes it', async () => {
      const hashes = `${SPACE}_file_hashes`;
      await mongo.col(hashes).insertMany([{ _id: BOTH, sha256: 'a' }, { _id: META_ONLY, sha256: 'b' }, { _id: NOTE, sha256: 'c' }]);
      const faults = failWrites(Object.getPrototypeOf(mongo.col('probe')), ['deleteMany']);
      let failedRun, afterFailure;
      try {
        faults.fail('deleteMany', `${SPACE}_files`, new Error('the files delete failed'));
        failedRun = await sweepMod.sweepLegacySpills();
        afterFailure = { files: await idsIn(`${SPACE}_files`), hashes: await idsIn(hashes) };
      } finally { faults.restore(); }

      assert.deepEqual(afterFailure.hashes, [NOTE],
        'the spills\' hash rows went FIRST: a files record left behind a failed delete must not be the only half that is gone');
      assert.ok(afterFailure.files.includes(BOTH) && afterFailure.files.includes(META_ONLY),
        'the `files` records are still there, so the next run finds the spills by them');
      assert.ok(failedRun.failed.some(f => f.spaceId === SPACE), `the failure is reported to the caller: ${JSON.stringify(failedRun)}`);

      const next = await sweepMod.sweepLegacySpills();
      assert.deepEqual(await idsIn(`${SPACE}_files`), [NOT_A_SPILL, NOTE, USERS_OWN].sort(), 'the next run removes the records');
      assert.equal(next.removed, 2, `the two records whose blobs were already gone, each counted: ${JSON.stringify(next)}`);
      assert.deepEqual(next.failed, []);
    });

    it('writes one `file.legacy_spill.sweep` audit entry per CLEANED space, and none for a space that failed or had nothing', async () => {
      put(SECOND_SPILL, '{}', SECOND);
      await mongo.col(`${SECOND}_files`).insertOne(meta(SECOND_SPILL, SECOND));
      const db = mongo.getDb();
      await db.collection(`${FAILING}_src`).insertOne({ _id: `_tmp/graph-${randomUUID()}.json`, f: 'not a number' });
      try {
        await withCollectionAsView(db, `${FAILING}_files`, `${FAILING}_src`, async () => {
          await sweepMod.sweepLegacySpills();
        }, { pipeline: [{ $addFields: { _x: { $toInt: '$f' } } }] });
      } finally {
        await db.collection(`${FAILING}_src`).deleteMany({});
      }
      const entries = () => mongo.col('audit_log').find({ operation: 'file.legacy_spill.sweep' }).toArray();
      assert.ok(await holdsWithin(async () => (await entries()).length >= 2, 5_000, 50), 'the entries are written');
      await sleep(300);   // time is the subject: an extra entry would arrive in this window
      const spaces = (await entries()).map(e => e.spaceId).sort();
      assert.deepEqual(spaces, [SPACE, SECOND].sort(), `one per cleaned space: ${spaces.join(', ')}`);
    });
  });
});

/**
 * What the absent-bytes sweep could not look at, and what a restore, an import or a chunked upload brought back, is never removed by it; and a
 * record's stamp leaves this instance by no door (bundle-70, Q-337, slice S4: the cases the tests-first step owed).
 *
 * ## What it prevents
 *
 *  - **Unlooked is not absent.** A look at a path that fails (EACCES, EIO) or does not return (a stuck mount) says nothing about the bytes. Read
 *    as "absent", one failing look stamps a record and a day later removes it, for a file that is on disk. Such a row is never stamped and never
 *    removed, and counts against removal in the mass-loss rule.
 *  - **A restored or imported record waits.** A restore or an import brings rows back whose bytes may still be on their way; a stamp from before
 *    it would age them past the day's window at once. Both clear every stamp and set `filesRestoredAt`, so every row of the space waits
 *    WAIT_DAYS_FOR_BYTES days.
 *  - **A chunked upload's finish is a byte writer.** The stamp goes in its own write, as for every other byte writer.
 *  - **The stamp is local.** A peer reading one row by id (the pull's by-id route), and a REST answer of a file row, are not shown it.
 *
 * ## How it is driven
 *
 * Through `sweepExpired(now)` with a later `now` per pass (`_absent-bytes-sweep.mjs`), the step seam's `look` and `lookBoundMs` standing for a
 * disk that fails or hangs (the runner is root, so a mode bit cannot make a path unreadable).
 *
 * Red on f423dd6e: nothing stamps, the seam has no `look`, the restore hook does not exist, every door carries the stamp.
 *
 * Run: node --test testing/standalone/the-absent-bytes-sweep-holds-what-it-cannot-look-at-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { PEER_TOKEN } from './_push-door.mjs';
import { NOW, DAY, SHA_PRESENT, THE_TWO_PASSES, after as at, runPass, passesAt, sweepSteps, resetSweepSteps, orphan, retired } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'absentunlooked';
const STAMP = NOW.toISOString();

let acts, loader, knownKeys;
const rows = () => acts.door.coll(S, 'files');
const rowOf = (p) => rows().findOne({ _id: p });
const entryOf = () => loader.getConfig().spaces.find(s => s.id === S);
const sweep = () => import('../../server/dist/files/absent-bytes-sweep.js');

async function healthy(n) { for (let i = 0; i < n; i++) await acts.seed(`ok${i}.txt`, { sha256: SHA_PRESENT, seq: 1 }); }
async function lose(...paths) { for (const p of paths) await rows().insertOne(orphan(S, p)); }
const settle = async (...instants) => { try { await passesAt(...instants); } catch { /* read from the rows */ } };

describe('the absent-bytes sweep holds what it cannot look at, and what was brought back (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'absentunlooked', space: S });
    loader = await import('../../server/dist/config/loader.js');
    knownKeys = Object.keys(entryOf());
  });
  after(async () => { await resetSweepSteps(); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    const entry = entryOf();
    for (const k of Object.keys(entry).filter(k => !knownKeys.includes(k))) delete entry[k];
  });
  afterEach(async () => { await resetSweepSteps(); });

  describe('a look that fails or does not return', () => {
    it('a record whose look FAILS is never stamped and never removed, while a plain orphan beside it is', async () => {
      await healthy(4);
      await lose('eacces.txt', 'gone.txt');
      (await sweepSteps())({
        look: async (_space, key) => {
          if (key === 'eacces.txt') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return false;
        },
      });
      await settle(...THE_TWO_PASSES, at(40 * DAY));
      assert.ok(retired(await rowOf('gone.txt')), 'fixture: the plain orphan was not removed, so the case proves nothing');
      const left = await rowOf('eacces.txt');
      assert.ok(left && !retired(left), `a record whose bytes could not be looked at was removed: ${JSON.stringify(left)}`);
      assert.equal(left.bytesAbsentSince, undefined, 'a record whose look failed was stamped as absent');
    });

    it('a record whose look does not return within its bound is unlooked: never stamped, never removed', async () => {
      await healthy(4);
      await lose('stuck.txt', 'gone.txt');
      (await sweepSteps())({
        lookBoundMs: 50,
        look: (_space, key) => (key === 'stuck.txt' ? new Promise(() => { /* a stuck mount */ }) : Promise.resolve(false)),
      });
      await settle(...THE_TWO_PASSES);
      assert.ok(retired(await rowOf('gone.txt')), 'fixture: the plain orphan was not removed');
      const left = await rowOf('stuck.txt');
      assert.ok(left && !retired(left) && left.bytesAbsentSince === undefined, `a record whose look hung was stamped or removed: ${JSON.stringify(left)}`);
    });

    it('unlooked rows count against removal: with as many unlooked as present, a lone orphan is held as mass loss', async () => {
      await healthy(1);
      await lose('a.txt', 'b.txt');
      (await sweepSteps())({ look: async (_s, key) => { if (key === 'b.txt') throw Object.assign(new Error('EIO'), { code: 'EIO' }); return false; } });
      await settle(...THE_TWO_PASSES, at(5 * DAY));
      assert.equal((await rowOf('a.txt'))?.bytesAbsentSince, STAMP, 'fixture: the orphan was not stamped');
      assert.ok(!retired(await rowOf('a.txt')), '1 absent + 1 unlooked of 3 recorded is more than half: the orphan was removed');
    });
  });

  describe('what a restore and an import bring back', () => {
    it('restartAbsentBytesSweeps (what the restore runs at its end) clears every stamp, sets filesRestoredAt and starts the pass over', async () => {
      const { restartAbsentBytesSweeps } = await sweep();
      assert.equal(typeof restartAbsentBytesSweeps, 'function', 'files/absent-bytes-sweep.ts exports no restartAbsentBytesSweeps');
      await healthy(2);
      await rows().insertOne(orphan(S, 'restored.txt', { bytesAbsentSince: '2026-01-01T00:00:00.000Z' }));
      await runPass(NOW);
      await restartAbsentBytesSweeps([S], NOW);
      assert.equal((await rowOf('restored.txt')).bytesAbsentSince, undefined, 'a stamp from before the restore survived it');
      assert.equal(entryOf().filesRestoredAt, STAMP, 'the space does not say when its records were brought back');
      assert.equal(entryOf().absentBytesScan, undefined, 'the pass was not started over');
    });

    it('a restored space\'s record with a sha256 waits WAIT_DAYS_FOR_BYTES, not a day', async () => {
      const { restartAbsentBytesSweeps } = await sweep();
      await healthy(2);
      await lose('restored.txt');
      await restartAbsentBytesSweeps([S], NOW);
      await settle(NOW, at(2 * DAY), at(10 * DAY));
      assert.equal((await rowOf('restored.txt'))?.bytesAbsentSince, STAMP, 'fixture: the record was not stamped');
      assert.ok(!retired(await rowOf('restored.txt')), 'a record of a space restored ten days ago was removed after a day');
    });

    it('an import clears the stamps of the space and sets filesRestoredAt', async () => {
      const { importDocuments } = await import('../../server/dist/sync/space-import.js');
      await healthy(1);
      await rows().insertOne(orphan(S, 'waiting.txt', { bytesAbsentSince: STAMP }));
      await importDocuments(S, { facts: [] });
      assert.equal((await rowOf('waiting.txt')).bytesAbsentSince, undefined, 'an import left a stamp in the space it landed in');
      assert.equal(typeof entryOf().filesRestoredAt, 'string', 'an import did not set filesRestoredAt');
    });

    it('the restore act runs the restart at its end (source)', async () => {
      const { readFileSync } = await import('node:fs');
      const src = readFileSync(new URL('../../server/src/db/restore-act.ts', import.meta.url), 'utf8');
      const end = src.slice(src.indexOf('function onRestoreEnd'));
      assert.match(end.slice(0, end.indexOf('\n}')), /restartAbsentBytesSweeps\(/, 'the restore\'s end does not restart the absent-bytes sweep');
    });
  });

  describe('a chunked upload\'s finish clears the stamp in its own write', () => {
    it('the last range over a stamped record leaves it live and unstamped', async () => {
      await rows().insertOne(orphan(S, 'chunked.bin', { bytesAbsentSince: STAMP }));
      const range = (start, data, total) => acts.post('upload', { query: { path: 'chunked.bin' }, body: Buffer.from(data),
        headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${start + data.length - 1}/${total}` } });
      const first = await range(0, 'abcd', 8);
      assert.ok(first.code < 300, `fixture: the first range answered ${first.code} ${JSON.stringify(first.body)}`);
      const last = await range(4, 'efgh', 8);
      assert.ok(last.code < 300, `fixture: the last range answered ${last.code} ${JSON.stringify(last.body)}`);
      const row = await rowOf('chunked.bin');
      assert.ok(row && !retired(row), `the record is not live after the finish: ${JSON.stringify(row)}`);
      assert.equal(row.bytesAbsentSince, undefined, 'a chunked upload\'s finish left the stamp: a live file reads as waiting for its bytes');
    });
  });

  describe('the stamp leaves by no door', () => {
    it('a peer reading one row by id (the pull\'s by-id route) is not shown the stamp', async () => {
      await acts.seed('byid.txt', { sha256: SHA_PRESENT, seq: 1, bytesAbsentSince: STAMP, pos: 1, posAtSeq: 1 });
      const handler = acts.door.handler('get', '/filemeta/:id');
      const req = { method: 'GET', params: { id: 'byid.txt' }, query: { spaceId: S }, authToken: PEER_TOKEN, get: () => undefined, headers: {} };
      const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() { return this; }, end() { return this; } };
      await handler(req, res);
      const said = JSON.stringify(res.body);
      assert.ok(said.includes('byid.txt'), `fixture: the by-id route did not serve the row: ${res.code} ${said}`);
      assert.ok(!said.includes('bytesAbsentSince'), `the by-id route serves the local stamp to a peer: ${said}`);
    });

    it('a REST answer of a file row (PATCH of its metadata) is not shown the stamp', async () => {
      const { fileMetaRouter } = await import('../../server/dist/api/brain/file-meta.js');
      const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
      const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
      await acts.seed('rest.txt', { sha256: SHA_PRESENT, seq: 1, bytesAbsentSince: STAMP });
      const layer = fileMetaRouter.stack.find(l => l.route?.path === '/spaces/:spaceId/files' && l.route.methods.patch);
      assert.ok(layer, 'no PATCH /spaces/:spaceId/files on the file-meta router — re-anchor this test');
      const req = { method: 'PATCH', params: { spaceId: S }, query: { path: 'rest.txt' }, body: { tags: ['seen'] }, ip: '127.0.0.1', headers: {},
        get: () => undefined, authToken: { id: 't', name: 'test', rights: ADMIN } };
      const res = { code: 200, body: undefined, headersSent: false, status(c) { this.code = c; return this; }, setHeader() { return this; },
        json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
      await layer.route.stack.at(-1).handle(req, res);
      const said = JSON.stringify(res.body);
      assert.ok(res.code < 300 && said.includes('rest.txt'), `fixture: the PATCH answered ${res.code} ${said}`);
      assert.ok(!said.includes('bytesAbsentSince'), `a REST answer carries the local stamp: ${said}`);
    });
  });
});

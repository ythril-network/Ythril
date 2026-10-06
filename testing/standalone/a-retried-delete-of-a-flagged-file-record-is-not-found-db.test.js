/**
 * A delete of a file record that is already gone answers 404 on every door — whether the record was removed, flagged
 * deleted, or never was a file at all (Q-343, half two).
 *
 * ## The defect
 *
 * `deleteFileCascade` decides what a path with no bytes is by whether a metadata record exists at the id. Two kinds
 * of record exist that are not a file to delete: one a SOFT delete flagged (`deletedAt`, kept for audit when
 * `softDeleteFileMeta` is on) and a derived one (`parentFileId`: a chunk or a face record). Both answered "known",
 * so a retried delete of a file that HAD been deleted wrote a second tombstone, flagged the record again with a new
 * `deletedAt` and a new seq, fired a second `file.deleted` webhook, and answered 204. A caller reading "204" as
 * "something was there" was told so about a file that was not. The same retry with the flag off answered 404.
 *
 * ## What is asserted
 *
 * For each of the three doors that reach the cascade — `DELETE /api/files/:spaceId`, `POST /api/delete_file`
 * (the generic tool door) and MCP's `delete_file` — which share one function, so a gap in it is a gap in all three:
 *
 * - with `softDeleteFileMeta: true`, the first delete answers success and flags the record, and the second answers 404
 *   and leaves `deletedAt`, `seq`, the tombstones and the `file.deleted` events exactly as the first left them;
 * - with the flag off, the first delete removes the record, and the second answers 404;
 * - a derived record (chunk) answers 404 and is left alone, tombstone-free;
 * - **the half that must keep working**: a delete a store failure stopped after the bytes went (bytes gone, record
 *   live) is COMPLETED by the retry, flag on or off — the live record is what tells the retry it is owed.
 *
 * And a directory delete after a soft delete does not bring the flagged record back to life (TST-10).
 *
 * Run: node --test testing/standalone/a-retried-delete-of-a-flagged-file-record-is-not-found-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'gonedel';
const T0 = '2026-09-01T00:00:00.000Z';
const DOORS = ['REST DELETE /api/files', 'POST /api/delete_file', 'MCP delete_file'];

let door, files, config, deleteHandler, callTool, ADMIN, events, unsubscribe;

const onDisk = (p) => fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', S, p));
const record = (p) => door.coll(S, 'files').findOne({ _id: p });
const tombstones = () => door.coll(S, 'file_tombstones').find({}).sort({ path: 1 }).toArray();
const deletedEvents = () => events.filter(e => e.event === 'file.deleted').length;

/** A stored file: its bytes on disk and its metadata row. */
async function seed(p, extra = {}) {
  await files.writeFile(S, p, `content of ${p}`);
  await door.coll(S, 'files').insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, ...extra });
}

/** The REST file router's own `DELETE` handler, past rate limit and auth. */
async function restDelete(p, body = {}) {
  const req = { method: 'DELETE', params: { spaceId: S }, query: { path: p }, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await deleteHandler(req, res);
  return { status: res.code, detail: res.body };
}

/** `delete_file` through `callTool`, as `POST /api/delete_file` (transport `rest`) or as MCP (transport `mcp`) reaches it. */
async function toolDelete(transport, p) {
  const out = await callTool({ name: 'delete_file', args: { space: S, path: p },
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: 't', tokenLabel: 't' } });
  return { status: out.status, detail: (out.result.content ?? []).map(c => c.text ?? '').join('\n') };
}

/** One delete of `p` through the named door: its status, and the sentence it gave. */
function del(doorName, p) {
  if (doorName === DOORS[0]) return restDelete(p);
  return toolDelete(doorName === DOORS[1] ? 'rest' : 'mcp', p);
}

const succeeded = (a) => a.status >= 200 && a.status < 300;

describe('a delete of a file record already gone answers 404 on every door', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'gonedel', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    files = await import('../../server/dist/files/files.js');
    config = (await import('../../server/dist/config/loader.js')).getConfig();
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods.delete);
    assert.ok(layer, 'no DELETE /:spaceId on the file router — re-anchor this test');
    deleteHandler = layer.route.stack.at(-1).handle;
    const { subscribeBrainChanges } = await import('../../server/dist/brain/brain-events.js');
    events = [];
    unsubscribe = subscribeBrainChanges(S, (ev) => events.push(ev));
  });
  after(async () => {
    unsubscribe?.();
    delete config?.softDeleteFileMeta;
    await door?.close();
  });
  beforeEach(async () => {
    for (const part of ['files', 'file_tombstones']) await door.coll(S, part).deleteMany({});
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
    fs.mkdirSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true });
    events.length = 0;
    config.softDeleteFileMeta = true;
  });

  for (const doorName of DOORS) {
    describe(doorName, () => {
      it('with soft delete on, the second delete of a flagged record is 404 and changes nothing', async () => {
        await seed('a.txt');
        const first = await del(doorName, 'a.txt');
        assert.ok(succeeded(first), `the first delete must succeed: ${first.status} ${JSON.stringify(first.detail)}`);
        const flagged = await record('a.txt');
        assert.ok(flagged?.deletedAt, 'the first delete must flag the record deleted');
        const tombstonesAfterFirst = await tombstones();
        assert.equal(tombstonesAfterFirst.length, 1, 'the first delete must write one tombstone');
        const eventsAfterFirst = deletedEvents();
        assert.equal(eventsAfterFirst, 1, 'the first delete must fire one file.deleted');

        const second = await del(doorName, 'a.txt');
        assert.equal(second.status, 404, `a retried delete of an already-deleted file must answer 404, not "${second.status}": ${JSON.stringify(second.detail)}`);

        const after = await record('a.txt');
        assert.equal(after?.deletedAt, flagged.deletedAt, 'the second delete re-flagged the record with a new deletedAt');
        assert.equal(after?.seq, flagged.seq, 'the second delete moved the record\'s seq, so peers are paged a change that did not happen');
        assert.deepEqual(await tombstones(), tombstonesAfterFirst, 'the second delete wrote or replaced a tombstone');
        assert.equal(deletedEvents(), eventsAfterFirst, 'the second delete fired a second file.deleted webhook');
      });

      it('with soft delete off, the first delete removes the record and the second is 404', async () => {
        config.softDeleteFileMeta = false;
        await seed('b.txt');
        const first = await del(doorName, 'b.txt');
        assert.ok(succeeded(first), `${first.status} ${JSON.stringify(first.detail)}`);
        assert.equal(await record('b.txt'), null, 'the first delete left the record');
        const second = await del(doorName, 'b.txt');
        assert.equal(second.status, 404, `${second.status} ${JSON.stringify(second.detail)}`);
        assert.equal((await tombstones()).length, 1, 'the second delete wrote another tombstone');
      });

      it('a derived (chunk) record answers 404 and is left alone', async () => {
        await door.coll(S, 'files').insertOne({ _id: 'doc.pdf#1', spaceId: S, path: 'doc.pdf#1', parentFileId: 'doc.pdf',
          sizeBytes: 0, tags: [], createdAt: T0, updatedAt: T0 });
        const answer = await del(doorName, 'doc.pdf#1');
        assert.equal(answer.status, 404, `a chunk is not a file the caller can delete: ${answer.status} ${JSON.stringify(answer.detail)}`);
        assert.ok(await record('doc.pdf#1'), 'the delete removed a derived record');
        assert.deepEqual(await tombstones(), [], 'a delete of a derived record wrote a tombstone');
        assert.equal(deletedEvents(), 0, 'a delete of a derived record fired file.deleted');
      });

      it('a path with live records only UNDER it (no bytes, no record of its own) is 404: it is not a file', async () => {
        await door.coll(S, 'files').insertOne({ _id: 'gone/inner.txt', spaceId: S, path: 'gone/inner.txt', sizeBytes: 1, tags: [], createdAt: T0, updatedAt: T0 });
        const answer = await del(doorName, 'gone');
        assert.equal(answer.status, 404, `${answer.status} ${JSON.stringify(answer.detail)}`);
        const inner = await record('gone/inner.txt');
        assert.ok(inner && !inner.deletedAt, 'a file delete of a folder-shaped path touched the records under it');
        assert.deepEqual(await tombstones(), [], 'a file delete of a folder-shaped path wrote a tombstone');
      });

      for (const soft of [true, false]) {
        it(`an interrupted first delete (bytes gone, record live) is completed by the retry, soft delete ${soft ? 'on' : 'off'}`, async () => {
          config.softDeleteFileMeta = soft;
          await seed('c.txt');
          fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S, 'c.txt'));
          assert.equal(onDisk('c.txt'), false);
          const retry = await del(doorName, 'c.txt');
          assert.ok(succeeded(retry), `the retry of an interrupted delete must complete it: ${retry.status} ${JSON.stringify(retry.detail)}`);
          const left = await record('c.txt');
          if (soft) assert.ok(left?.deletedAt, 'the completed delete did not flag the record');
          else assert.equal(left, null, 'the completed delete left the record');
          assert.deepEqual((await tombstones()).map(t => t.path), ['c.txt'], 'the completed delete must tombstone the path');
          assert.equal(deletedEvents(), 1);
        });
      }
    });
  }

  it('a directory delete after a soft delete does not bring the flagged record back', async () => {
    await seed('dir/one.txt');
    const first = await restDelete('dir/one.txt');
    assert.ok(succeeded(first), `${first.status}`);
    assert.ok((await record('dir/one.txt'))?.deletedAt);
    const tombstonesBefore = await tombstones();
    const dir = await restDelete('dir', { confirm: true });
    assert.ok(succeeded(dir), `the directory is still on disk and its delete is allowed: ${dir.status} ${JSON.stringify(dir.detail)}`);
    assert.ok((await record('dir/one.txt'))?.deletedAt, 'a directory delete after a soft delete left the flagged record live');
    assert.deepEqual(await tombstones(), tombstonesBefore, 'the directory delete wrote a tombstone for a file that was already gone');
  });
});

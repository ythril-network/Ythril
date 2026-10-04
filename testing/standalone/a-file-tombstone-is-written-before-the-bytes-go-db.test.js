/**
 * A file's sync tombstone is written BEFORE its bytes go, on every path that removes a file — so a store failure on
 * the tombstone leaves the file where it was and the retry repeats the whole act, and a file whose bytes are already
 * gone gets the tombstone it is missing (bundle-30 I13, pre-ship reliability R1 / data-integrity DI-3).
 *
 * ## The defect
 *
 * I12 made `writeFileTombstones` rethrow a store failure so the caller is told to retry. But it ran AFTER the unlink
 * (`deleteFileCascade`), after the tree was removed (directory delete) and after the move. The retry then met a file
 * already gone: the REST delete took its orphan branch and answered 204 writing no tombstone, a directory delete
 * answered 404, a move failed on its missing source, and the TTL sweep hit ENOENT on every cycle for ever. With no
 * tombstone, a peer's manifest pushes the file straight back — the resurrection the throw existed to prevent.
 *
 * ## What is asserted, for each path that removes a file
 *
 * - With the store failing the tombstone write: the act fails, and the bytes and the metadata are still there.
 * - The retry, with the store back: the bytes are gone and a tombstone names the path.
 * - A file whose bytes went missing out of band (its metadata remains) is completed by the REST delete and by the
 *   TTL sweep: tombstone written, metadata removed.
 * - A path with neither bytes nor metadata is a not-found error, and writes no tombstone.
 *
 * Run: node --test testing/standalone/a-file-tombstone-is-written-before-the-bytes-go-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { failWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'tombfirst';
const T0 = '2026-09-01T00:00:00.000Z';
// The driver the SERVER loads, so the store failure is classified by the class the server sees.
const { MongoNetworkError } = createRequire(path.resolve('server/package.json'))('mongodb');

let door, files, cascade, move, ttl, deleteHandler, faults;
/** The store fails ONLY the tombstone write, with an error the server classifies as the store's — until `faults.clear()`. */
const tombstoneStoreDown = () => faults.fail('insertMany', `${S}_file_tombstones`,
  new MongoNetworkError('connection 7 to 10.9.9.9:27017 closed'), { times: Infinity });

const onDisk = (p) => fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', S, p));
const meta = (p) => door.mongo.col(`${S}_files`).findOne({ _id: p });
const tombstoned = async () => (await door.mongo.col(`${S}_file_tombstones`).find({}).toArray()).map(t => t.path).sort();

/** A stored file: its bytes on disk and its metadata row. */
async function seed(p, extra = {}) {
  await files.writeFile(S, p, `content of ${p}`);
  await door.mongo.col(`${S}_files`).insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [],
    createdAt: T0, updatedAt: T0, ...extra });
}

/** The REST `DELETE /api/files/:spaceId` handler, past rate limit and auth, as a caller reaches it. */
async function restDelete(p, body = {}) {
  const req = { method: 'DELETE', params: { spaceId: S }, query: { path: p }, body, authToken: { name: 'test' },
    get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await deleteHandler(req, res);
  return res;
}

describe('a file tombstone is written before the bytes go', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'tombfirst', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    files = await import('../../server/dist/files/files.js');
    cascade = await import('../../server/dist/files/delete-cascade.js');
    move = await import('../../server/dist/files/move-cascade.js');
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods.delete);
    assert.ok(layer, 'no DELETE /:spaceId on the file router — re-anchor this test');
    deleteHandler = layer.route.stack.at(-1).handle;
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['insertMany']);
  });
  after(async () => {
    faults?.restore();
    await door?.close();
  });
  beforeEach(async () => {
    faults.clear();
    for (const part of ['files', 'file_tombstones']) await door.mongo.col(`${S}_${part}`).deleteMany({});
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
  });

  it('a file delete through a tombstone store failure leaves the file, and the retry tombstones it', async () => {
    await seed('a.txt');
    tombstoneStoreDown();
    await assert.rejects(cascade.deleteFileCascade(S, 'a.txt'), 'the delete must fail when its tombstone cannot be written');
    assert.ok(onDisk('a.txt'), 'the bytes went before the tombstone was written — the retry can never write it');
    assert.ok(await meta('a.txt'), 'the metadata went with a failed delete');
    faults.clear();
    await cascade.deleteFileCascade(S, 'a.txt');
    assert.equal(onDisk('a.txt'), false, 'the retried delete did not remove the bytes');
    assert.equal(await meta('a.txt'), null, 'the retried delete did not remove the metadata');
    assert.deepEqual(await tombstoned(), ['a.txt'], 'the retried delete wrote no tombstone');
  });

  it('a directory delete through a tombstone store failure leaves the tree, and the retry tombstones every file', async () => {
    await seed('dir/one.txt');
    await seed('dir/two.txt');
    tombstoneStoreDown();
    const first = await restDelete('dir', { confirm: true });
    assert.equal(first.code, 503, `a store failure on the tombstones must answer 503: ${JSON.stringify(first.body)}`);
    assert.ok(onDisk('dir/one.txt') && onDisk('dir/two.txt'), 'the tree went before its tombstones were written');
    faults.clear();
    const retry = await restDelete('dir', { confirm: true });
    assert.equal(retry.code, 204, `the retried directory delete: ${retry.code} ${JSON.stringify(retry.body)}`);
    assert.equal(onDisk('dir/one.txt'), false);
    assert.deepEqual(await tombstoned(), ['dir/one.txt', 'dir/two.txt'], 'the retried directory delete wrote no tombstones');
  });

  it('a move through a tombstone store failure leaves the source in place, and the retry moves and tombstones it', async () => {
    await seed('src.txt');
    tombstoneStoreDown();
    await assert.rejects(move.moveFileCascade(S, 'src.txt', 'dst.txt'), 'the move must fail when its tombstones cannot be written');
    assert.ok(onDisk('src.txt'), 'the bytes moved before the tombstone was written — the retry finds no source');
    assert.equal(onDisk('dst.txt'), false, 'a failed move left a copy at the destination');
    assert.deepEqual(await tombstoned(), [], 'a failed move left a tombstone for a file that did not move');
    faults.clear();
    await move.moveFileCascade(S, 'src.txt', 'dst.txt');
    assert.ok(onDisk('dst.txt') && !onDisk('src.txt'), 'the retried move did not move the file');
    assert.deepEqual(await tombstoned(), ['src.txt'], 'the retried move did not tombstone the path it left');
  });

  it('the TTL sweep through a tombstone store failure leaves the file, and the next sweep tombstones it', async () => {
    await seed('old.txt', { _expireAt: new Date('2026-01-01T00:00:00Z') });
    tombstoneStoreDown();
    await ttl.sweepExpired(new Date());
    assert.ok(onDisk('old.txt'), 'the sweep removed the bytes before the tombstone was written');
    assert.ok(await meta('old.txt'), 'the sweep removed the metadata through a failed delete');
    faults.clear();
    await ttl.sweepExpired(new Date());
    assert.equal(onDisk('old.txt'), false, 'the next sweep did not remove the bytes');
    assert.equal(await meta('old.txt'), null, 'the next sweep did not remove the expired metadata');
    assert.deepEqual(await tombstoned(), ['old.txt'], 'the next sweep wrote no tombstone');
  });

  it('a file whose bytes are already gone is completed: the REST delete and the TTL sweep write its tombstone', async () => {
    await seed('orphan.txt');
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S, 'orphan.txt'));
    const r = await restDelete('orphan.txt');
    assert.equal(r.code, 204, `the orphan delete: ${r.code} ${JSON.stringify(r.body)}`);
    assert.equal(await meta('orphan.txt'), null, 'the orphan delete left the metadata');
    assert.deepEqual(await tombstoned(), ['orphan.txt'], 'the orphan delete wrote no tombstone, so a peer re-pushes the file');

    await seed('gone.txt', { _expireAt: new Date('2026-01-01T00:00:00Z') });
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S, 'gone.txt'));
    await ttl.sweepExpired(new Date());
    assert.equal(await meta('gone.txt'), null, 'the sweep left an expired record whose bytes were gone — it retries for ever');
    assert.deepEqual(await tombstoned(), ['gone.txt', 'orphan.txt'], 'the sweep wrote no tombstone for the expired orphan');
  });

  it('a path with neither bytes nor metadata is not found, on both doors, and writes no tombstone', async () => {
    const { NotFoundError } = await import('../../server/dist/util/errors.js');
    await assert.rejects(cascade.deleteFileCascade(S, 'never.txt'), (err) => err instanceof NotFoundError,
      'the cascade (MCP delete_file, the TTL sweep) must say the path is not there, as a not-found');
    const r = await restDelete('never.txt');
    assert.equal(r.code, 404, `the REST delete of a path never known: ${r.code}`);
    assert.deepEqual(await tombstoned(), [], 'a delete of nothing wrote a tombstone');
  });
});

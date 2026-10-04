/**
 * A file delete or move that meets a store failure answers 503 on every door and leaves a state its retry repairs —
 * never a success over half an act, and never a tombstone for a file that is still here (bundle-30 I14,
 * verify-drive-4 findings D1 and D2).
 *
 * ## The findings
 *
 * - **D1.** With the store paused, a file delete answered `204` having removed the bytes, with the metadata left
 *   and the tombstone's fate unknown to the server. The tombstone write failed as a `MongoBulkWriteError`, which was
 *   not taken for the store's failure (`a-bulk-write-failure-is-classified-by-what-it-wraps-db`), and every later
 *   store step — the metadata, the job, the artifacts — swallowed its own failure and logged it.
 * - **D2.** A move whose tombstone insert was REPORTED failed answered `503` with the file in place — and the insert
 *   landed when the store came back. `writeFileTombstones` had returned no ids, so nothing was withdrawn, and the
 *   tombstone told peers to delete a file that still exists here.
 *
 * ## What is asserted, on REST and on MCP
 *
 * - A tombstone write that fails as the driver fails it changes nothing: `503`, bytes and metadata in place.
 * - One that is reported failed AND landed leaves no tombstone behind, whether it landed before the withdrawal or
 *   after the withdrawal's first attempt was itself refused.
 * - A store step that fails AFTER the bytes went (delete) or moved (move) answers `503`, and the same request,
 *   retried, completes the act: bytes, metadata and tombstone each where a finished act leaves them.
 *
 * Every injected error is one the installed driver produced against the real store (`driverWriteFailures`).
 *
 * Run: node --test testing/standalone/a-file-act-answers-true-in-an-outage-db.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { driverWriteFailures, eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'fileoutage';
const T0 = '2026-09-01T00:00:00.000Z';

let door, files, tombstones, F, handlers, callTool, ADMIN, proto;
/** The faults armed for the current case, by `method collection`; each is `{ err, times, land, late }`. */
let faults = new Map();
const originals = {};

const root = () => path.join(process.env['DATA_ROOT'], 'files', S);
const onDisk = (p) => fs.existsSync(path.join(root(), p));
const meta = (p) => door.mongo.col(`${S}_files`).findOne({ _id: p });
const tombstoned = async () => (await door.mongo.col(`${S}_file_tombstones`).find({}).toArray()).map(t => t.path).sort();

async function seed(p) {
  await files.writeFile(S, p, `content of ${p}`);
  await door.mongo.col(`${S}_files`).insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 });
}

/**
 * The next `times` calls of `method` on `S_<part>` throw `err`. `land`: the write is applied first and THEN reported
 * failed. `lateMs`: it is reported failed at once and applied that many ms later — the insert a paused store
 * applies from its buffer when it comes back.
 */
function fail(method, part, err, { times = 1, land = false, lateMs } = {}) {
  faults.set(`${method} ${S}_${part}`, { err, times, land, lateMs });
}

function install(method) {
  originals[method] = proto[method];
  proto[method] = async function faulty(...args) {
    const f = faults.get(`${method} ${this.collectionName}`);
    if (!f || f.times <= 0) return originals[method].apply(this, args);
    f.times -= 1;
    if (f.land) await originals[method].apply(this, args);
    if (f.lateMs !== undefined) setTimeout(() => { void originals[method].apply(this, args).catch(() => {}); }, f.lateMs);
    throw f.err;
  };
}

/** A route handler as a caller reaches it past rate limit and auth, with a response that records what was sent. */
async function rest(method, query, body = {}) {
  const req = { method, params: { spaceId: S }, query, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handlers[method](req, res);
  return res;
}
const restDelete = (p, body) => rest('DELETE', { path: p }, body);
const restMove = (src, dst) => rest('PATCH', { path: src }, { destination: dst });

async function mcp(tool, args) {
  const out = await callTool({ name: tool, args: { space: S, ...args },
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { status: out.status, isError: !!out.result.isError, text, sc: out.result.structuredContent ?? {} };
}

/** Every door's answer to a store failure: 503, retryable, and none of the driver's text. */
function assertStoreAnswer(door, a) {
  const raw = JSON.stringify(a.body ?? a.sc ?? null) + (a.text ?? '');
  // A REST response records its status as `code` (`status` is its setter); an MCP answer carries `status`.
  const status = 'code' in a ? a.code : a.status;
  assert.equal(status, 503, `${door} answered ${status}: ${raw}`);
  assert.equal((a.body ?? a.sc).retryable, true, `${door} did not say the failure is retryable: ${raw}`);
  assert.ok(!raw.includes(F.address), `${door} answered with the driver's text: ${raw}`);
}

describe('a file act answers true in an outage, and its retry repairs it', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'fileoutage', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    F = await driverWriteFailures('ythril_harness_fileoutage');
    files = await import('../../server/dist/files/files.js');
    tombstones = await import('../../server/dist/files/tombstones.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const handlerOf = (m) => {
      const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods[m]);
      assert.ok(layer, `no ${m.toUpperCase()} /:spaceId on the file router — re-anchor this test`);
      return layer.route.stack.at(-1).handle;
    };
    handlers = { DELETE: handlerOf('delete'), PATCH: handlerOf('patch') };
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    for (const m of ['insertMany', 'deleteOne', 'deleteMany']) install(m);
  });
  after(async () => {
    for (const [m, f] of Object.entries(originals)) proto[m] = f;
    await door?.close();
  });
  beforeEach(async () => {
    faults = new Map();
    for (const part of ['files', 'file_tombstones']) await door.mongo.col(`${S}_${part}`).deleteMany({});
    fs.rmSync(root(), { recursive: true, force: true });
  });
  afterEach(() => { faults = new Map(); });

  it('the injected errors are the driver\'s: the bulk wrapper the drive saw, and a failed selection', () => {
    assert.equal(F.storeGone.bulk.name, 'MongoBulkWriteError');
    assert.equal(F.storeGone.single.name, 'MongoServerSelectionError');
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: a delete whose tombstone write fails as the driver fails it answers 503 and changes nothing`, async () => {
      await seed('a.txt');
      fail('insertMany', 'file_tombstones', F.storeGone.bulk);
      const a = via === 'REST' ? await restDelete('a.txt') : await mcp('delete_file', { path: 'a.txt' });
      assertStoreAnswer(`${via} delete`, a);
      assert.ok(onDisk('a.txt'), 'the bytes went although the tombstone was never written — a peer pushes the file back');
      assert.ok(await meta('a.txt'), 'the metadata went with a delete that answered a failure');
    });

    it(`${via}: a delete whose tombstone is reported failed but landed leaves no tombstone for the file it kept`, async () => {
      await seed('kept.txt');
      fail('insertMany', 'file_tombstones', F.storeGone.bulk, { land: true });
      const a = via === 'REST' ? await restDelete('kept.txt') : await mcp('delete_file', { path: 'kept.txt' });
      assertStoreAnswer(`${via} delete`, a);
      assert.ok(onDisk('kept.txt') && await meta('kept.txt'), 'the file did not stay where it was');
      await tombstones.whenFileTombstoneWithdrawalsSettle?.();
      assert.deepEqual(await tombstoned(), [], 'a tombstone names a file that is still here — peers delete it');
    });

    it(`${via}: a delete whose metadata delete fails after the bytes went answers 503, and the retry completes it`, async () => {
      await seed('b.txt');
      fail('deleteOne', 'files', F.storeGone.single);
      const a = via === 'REST' ? await restDelete('b.txt') : await mcp('delete_file', { path: 'b.txt' });
      assertStoreAnswer(`${via} delete`, a);
      const retry = via === 'REST' ? await restDelete('b.txt') : await mcp('delete_file', { path: 'b.txt' });
      assert.equal(retry.code ?? retry.status, via === 'REST' ? 204 : 200, `the retry: ${JSON.stringify(retry.body ?? retry.text)}`);
      assert.equal(onDisk('b.txt'), false);
      assert.equal(await meta('b.txt'), null, 'the retry did not remove the metadata');
      assert.ok((await tombstoned()).includes('b.txt'), 'no tombstone names the deleted file');
    });

    it(`${via}: a move whose tombstone is reported failed but landed answers 503 and withdraws it`, async () => {
      await seed('src.txt');
      fail('insertMany', 'file_tombstones', F.storeGone.bulk, { land: true });
      const a = via === 'REST' ? await restMove('src.txt', 'dst.txt') : await mcp('move_file', { src: 'src.txt', dst: 'dst.txt' });
      assertStoreAnswer(`${via} move`, a);
      assert.ok(onDisk('src.txt') && !onDisk('dst.txt'), 'the file did not stay where it was');
      await tombstones.whenFileTombstoneWithdrawalsSettle?.();
      assert.deepEqual(await tombstoned(), [], 'a failed move left a tombstone for a file that did not move (D2)');
    });

    it(`${via}: a move whose metadata rename fails after the bytes moved answers 503, and the retry completes it`, async () => {
      await seed('from.txt');
      fail('deleteOne', 'files', F.storeGone.single);
      const a = via === 'REST' ? await restMove('from.txt', 'to.txt') : await mcp('move_file', { src: 'from.txt', dst: 'to.txt' });
      assertStoreAnswer(`${via} move`, a);
      const retry = via === 'REST' ? await restMove('from.txt', 'to.txt') : await mcp('move_file', { src: 'from.txt', dst: 'to.txt' });
      assert.equal(retry.code ?? retry.status, 200, `the retried move: ${JSON.stringify(retry.body ?? retry.text)}`);
      assert.ok(onDisk('to.txt') && !onDisk('from.txt'), 'the retried move did not leave the file at its destination');
      assert.ok(await meta('to.txt'), 'the retried move did not carry the metadata to the destination');
      assert.equal(await meta('from.txt'), null, 'the metadata is still at the source');
      assert.deepEqual(await tombstoned(), ['from.txt'], 'the path the move left is not tombstoned');
    });
  }

  it('a directory delete whose metadata delete fails after the tree went answers 503, and the retry completes it', async () => {
    await seed('dir/one.txt');
    await seed('dir/two.txt');
    fail('deleteMany', 'files', F.storeGone.single);
    const first = await restDelete('dir', { confirm: true });
    assertStoreAnswer('REST directory delete', first);
    const retry = await restDelete('dir', { confirm: true });
    assert.equal(retry.code, 204, `the retried directory delete: ${retry.code} ${JSON.stringify(retry.body)}`);
    assert.equal(await meta('dir/one.txt'), null, 'the retry left the metadata of a file whose bytes are gone');
    assert.equal(await meta('dir/two.txt'), null);
    assert.deepEqual(await tombstoned(), ['dir/one.txt', 'dir/two.txt']);
  });

  it('a tombstone that lands after its withdrawal was first refused is still withdrawn', async () => {
    assert.equal(typeof tombstones.whenFileTombstoneWithdrawalsSettle, 'function',
      'files/tombstones.js has no whenFileTombstoneWithdrawalsSettle — a withdrawal that has to wait cannot be awaited');
    await seed('late.txt');
    fail('insertMany', 'file_tombstones', F.storeGone.bulk, { lateMs: 400 });
    fail('deleteMany', 'file_tombstones', F.storeGone.single);
    const a = await restMove('late.txt', 'moved.txt');
    assertStoreAnswer('REST move', a);
    assert.ok(await eventually(async () => (await door.mongo.col(`${S}_file_tombstones`).countDocuments()) > 0, 2_000),
      'the late insert never landed — the case is not the one the drive saw');
    await tombstones.whenFileTombstoneWithdrawalsSettle();
    assert.deepEqual(await tombstoned(), [], 'a tombstone the store applied after the withdrawal\'s first try survives');
    assert.ok(onDisk('late.txt'));
  });
});

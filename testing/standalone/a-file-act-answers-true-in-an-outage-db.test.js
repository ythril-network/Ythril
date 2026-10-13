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
 *   tombstone told peers to delete a file that still exists here. (Since bundle-30 I15 the tombstone is written
 *   PENDING and published only once the act happened, so a landed write is served to no peer whatever becomes of it.)
 *
 * ## What is asserted, on REST and on MCP
 *
 * - A tombstone write that fails as the driver fails it changes nothing: `503`, bytes and metadata in place.
 * - One that is reported failed AND landed publishes no tombstone, whether it landed before the act's clean-up or
 *   after that clean-up was itself refused — and the TTL sweep's settle removes what is left.
 * - "Published" is what `GET /api/sync/file-tombstones` serves a peer.
 * - A store step that fails AFTER the bytes went (delete) answers `503`, and the same request, retried, completes the act:
 *   bytes, metadata and tombstone each where a finished act leaves them.
 * - A MOVE whose record step fails after the bytes moved — the store's failure or not, a write that did not happen or one that
 *   landed and was reported failed — leaves the file's row, its derived rows, its jobs and its links ALL at the source, answers
 *   `503` (never `200` over half a move), and a retry completes it (bundle-44, Q-342, Q-345). The case asserts the armed fault
 *   fired (`failWrites(...).fired`).
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
import { driverWriteFailures, eventually, failWrites } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { toolDoor } from './_file-act-doors.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'fileoutage';
const T0 = '2026-09-01T00:00:00.000Z';

let door, files, tombstones, F, handlers, callTool, ADMIN, faults, tool, answerOf;

const root = () => path.join(process.env['DATA_ROOT'], 'files', S);
const onDisk = (p) => fs.existsSync(path.join(root(), p));
const meta = (p) => door.mongo.col(`${S}_files`).findOne({ _id: p });
/** The paths a peer is told are gone: what the `GET /api/sync/file-tombstones` door serves. */
const tombstoned = async () => (await door.pull('/file-tombstones', { spaceId: S })).tombstones.map(t => t.path).sort();

async function seed(p) {
  await files.writeFile(S, p, `content of ${p}`);
  await door.mongo.col(`${S}_files`).insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 });
}

/** The next calls of `method` on `S_<part>` fail as `failWrites` fails them (`land`, `lateMs`: see there). */
const fail = (method, part, err, opts) => faults.fail(method, `${S}_${part}`, err, opts);

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

/**
 * A move whose bytes moved and whose records did not follow answers, on every door, 503 `move_still_owed` for the destination, says
 * it is retryable, and none of the driver's text. A REST door says WHEN in `Retry-After` (a positive whole number of seconds, the one
 * writer of it); MCP has no header and says `retryable` in the body.
 */
function assertMoveStillOwed(via, a, destination) {
  const answer = answerOf(a);
  const raw = JSON.stringify(a.body ?? a.sc ?? null) + (a.text ?? '');
  assert.equal(answer.status, 503, `${via} answered ${answer.status}: ${raw}`);
  assert.equal(answer.code, 'move_still_owed', `${via} answered code ${JSON.stringify(answer.code)}: ${raw}`);
  assert.equal(answer.path, destination, `${via} named path ${JSON.stringify(answer.path)}: ${raw}`);
  assert.equal(answer.retryable, true, `${via} did not say the move is retryable: ${raw}`);
  assert.ok(!raw.includes(F.address), `${via} answered with the driver's text: ${raw}`);
  if (via === 'MCP') {
    assert.equal(answer.retryAfter, undefined, 'MCP has no header to carry a Retry-After');
  } else {
    assert.match(String(answer.retryAfter), /^[1-9]\d*$/, `${via} answered 503 without a usable Retry-After (${JSON.stringify(answer.retryAfter)}): the caller is not told when to come back`);
  }
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
    ({ tool, answerOf } = await toolDoor(S));
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['insertOne', 'insertMany', 'deleteOne', 'deleteMany', 'bulkWrite']);
  });
  after(async () => {
    faults?.restore();
    await door?.close();
  });
  beforeEach(async () => {
    faults.clear();
    for (const part of ['files', 'file_tombstones', 'media_jobs', 'links', 'entities']) await door.mongo.col(`${S}_${part}`).deleteMany({});
    fs.rmSync(root(), { recursive: true, force: true });
  });
  afterEach(() => { faults.clear(); });

  it('the injected errors are the driver\'s: the bulk wrapper the drive saw, and a failed selection', () => {
    assert.equal(F.storeGone.bulk.name, 'MongoBulkWriteError');
    assert.equal(F.storeGone.single.name, 'MongoServerSelectionError');
  });

  it('failWrites reports whether an armed fault FIRED: once per throw, nothing for a write it was not armed on, and nothing after clear()', async () => {
    const probe = door.mongo.col(`${S}_fault_probe`);
    fail('insertOne', 'fault_probe', F.storeGone.single);
    assert.equal(faults.fired('insertOne', `${S}_fault_probe`), 0, 'a fault that was only armed reports it fired');
    await assert.rejects(() => probe.insertOne({ _id: 'x' }), (err) => err === F.storeGone.single);
    assert.equal(faults.fired('insertOne', `${S}_fault_probe`), 1);
    await probe.insertOne({ _id: 'y' });
    assert.equal(faults.fired('insertOne', `${S}_fault_probe`), 1, 'a write after the fault was spent counted as fired');
    assert.equal(faults.fired('insertMany', `${S}_fault_probe`), 0, 'a method the fault was not armed on reports fired');
    faults.clear();
    assert.equal(faults.fired('insertOne', `${S}_fault_probe`), 0);
    await probe.deleteMany({});
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
      await tombstones.whenPendingFileTombstoneDropsSettle();
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

    it(`${via}: a move whose tombstone is reported failed but landed answers 503 and publishes none`, async () => {
      await seed('src.txt');
      fail('insertMany', 'file_tombstones', F.storeGone.bulk, { land: true });
      const a = via === 'REST' ? await restMove('src.txt', 'dst.txt') : await mcp('move_file', { src: 'src.txt', dst: 'dst.txt' });
      assertStoreAnswer(`${via} move`, a);
      assert.ok(onDisk('src.txt') && !onDisk('dst.txt'), 'the file did not stay where it was');
      await tombstones.whenPendingFileTombstoneDropsSettle();
      assert.deepEqual(await tombstoned(), [], 'a failed move left a tombstone for a file that did not move (D2)');
    });
  }

  // ── A move whose record step fails after the bytes moved ─────────────────────────────────────────────────────────
  //
  // THE outage test of the move (bundle-44, Q-342, Q-345; plan rev 3 D1, D3, D7). The rule is about WHERE EVERYTHING IS, not
  // about which write failed: whatever fails in the record step once the bytes have moved — the store, or anything else, a
  // write that never happened or one that landed and was reported failed — the file's row, the rows derived from it, its jobs
  // and its links are all still at the source (none lost, none at neither id), the door answers `503` it can be retried
  // from (never `200` over a half-done move), and the retry completes the move. It used to arm ONE fault, a `deleteOne` of the
  // file row that never ran, which left the source row in place by construction: the only half-move it could see was the
  // one that cannot lose a row. A fault AFTER the delete — the insert, or a delete that landed — is the one that does.
  //
  // Each fault names the writes a record step can make (`INSERTS`, `DELETES`) rather than the one the code makes today, and the
  // case asserts the armed fault FIRED: a move that no longer goes through a method must not turn this into a test of nothing.
  const E1 = '11111111-1111-4111-8111-111111111111';
  const E2 = '22222222-2222-4222-8222-222222222222';
  const INSERTS = ['insertOne', 'insertMany', 'bulkWrite'];
  const DELETES = ['deleteOne', 'deleteMany', 'bulkWrite'];
  /** Every row a file owns here: its own, a chunk, the converted Markdown and an extracted image (each derived from it). */
  const rowsOf = (p) => [p, `${p}#chunk-0`, `_converted/${p}.md`, `_extracted/${p}/x.jpg`].sort();
  /** The queued job of the extracted image: a job's id is its path. */
  const jobOf = (p) => `_extracted/${p}/x.jpg`;
  const LINKS = [`entity:${E1}`, `entity:${E2}`];

  /** A file with everything a move carries: bytes and sidecar bytes, a rich record, three derived rows, a queued job, two links. */
  async function seedEverything(p) {
    await files.writeFile(S, p, `content of ${p}`);
    await files.writeFile(S, `_converted/${p}.md`, 'converted markdown');
    await files.writeFile(S, `_extracted/${p}/x.jpg`, 'image bytes');
    const derived = (id, extra = {}) => ({ _id: id, spaceId: S, path: id, parentFileId: p, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 5, ...extra });
    await door.mongo.col(`${S}_files`).insertMany([
      { _id: p, spaceId: S, path: p, sizeBytes: 10, tags: ['kept-tag'], description: 'the moved description', properties: { kept: true }, createdAt: T0, updatedAt: T0 },
      derived(`${p}#chunk-0`, { chunkIndex: 0, content: 'a chunk' }), derived(`_converted/${p}.md`), derived(`_extracted/${p}/x.jpg`),
    ]);
    await door.mongo.col(`${S}_media_jobs`).insertOne({ _id: jobOf(p), spaceId: S, status: 'pending' });
    const entity = (_id, seq) => ({ _id, spaceId: S, name: `Entity ${seq}`, type: 'thing', tags: [], createdAt: T0, seq, author: { instanceId: 'outage', instanceLabel: 'Outage' } });
    await door.mongo.col(`${S}_entities`).insertMany([entity(E1, 1), entity(E2, 2)]);
    const { updateFileMeta } = await import('../../server/dist/files/file-meta.js');
    await updateFileMeta(S, p, { linkEntities: [E1, E2] });
    const adjacency = await import('../../server/dist/brain/link-adjacency.js');
    assert.deepEqual((await adjacency.linksStartingFrom(S, [p])).map(r => `${r.toKind}:${r.to}`).sort(), LINKS, 'fixture: the file is not linked');
  }

  /** Which of a file's rows, its job and its links are held under the path `p`, by identity. */
  async function heldAt(p) {
    const adjacency = await import('../../server/dist/brain/link-adjacency.js');
    const rows = await door.mongo.col(`${S}_files`).find({ _id: { $in: rowsOf(p) } }, { projection: { _id: 1 } }).toArray();
    return {
      rows: rows.map(r => r._id).sort(),
      job: (await door.mongo.col(`${S}_media_jobs`).findOne({ _id: jobOf(p) }))?._id ?? null,
      links: (await adjacency.linksStartingFrom(S, [p])).map(r => `${r.toKind}:${r.to}`).sort(),
    };
  }

  /** Everything of `from.txt` is at `to.txt` and nothing of it is left: rows, job, links, the record's own fields, bytes, the tombstone. */
  async function assertMovedWhole() {
    const done = await heldAt('to.txt');
    assert.deepEqual(done.rows, rowsOf('to.txt'), 'the move did not carry every row to the destination');
    assert.equal(done.job, jobOf('to.txt'), 'the move did not carry the job');
    assert.deepEqual(done.links, LINKS, 'the move did not carry the links');
    assert.deepEqual(await heldAt('from.txt'), { rows: [], job: null, links: [] }, 'something of the file is still at the source');
    const record = await meta('to.txt');
    assert.equal(record.description, 'the moved description');
    assert.deepEqual(record.tags, ['kept-tag']);
    assert.deepEqual(record.properties, { kept: true });
    assert.ok(onDisk('_converted/to.txt.md') && onDisk('_extracted/to.txt/x.jpg') && !onDisk('from.txt'), 'the move did not leave the file and its sidecars at the destination');
    const gone = await tombstoned();
    assert.ok(gone.includes('from.txt'), `the path the move left is not tombstoned: ${JSON.stringify(gone)}`);
    assert.ok(!gone.includes('to.txt'), 'the destination is tombstoned');
  }

  const NOT_THE_STORE = new Error('injected: a failure that is not the store\'s');
  const FAULTS = [
    { name: 'the records\' re-insert fails as the store fails it', methods: INSERTS, part: 'files', err: () => F.storeGone.single },
    { name: 'the records\' re-insert fails with an error that is not the store\'s', methods: INSERTS, part: 'files', err: () => NOT_THE_STORE },
    { name: 'the records\' delete LANDS and is reported failed', methods: DELETES, part: 'files', err: () => F.storeGone.single, opts: { land: true } },
    { name: 'the jobs\' re-insert fails with an error that is not the store\'s', methods: INSERTS, part: 'media_jobs', err: () => NOT_THE_STORE },
    { name: 'the jobs\' delete LANDS and is reported failed', methods: DELETES, part: 'media_jobs', err: () => F.storeGone.single, opts: { land: true } },
  ];

  // `TOOL` is `POST /api/<tool>`, the third door a move reaches (`_file-act-doors.mjs`).
  for (const via of ['REST', 'TOOL', 'MCP']) {
    const move = (s, d) => (via === 'REST' ? restMove(s, d) : via === 'TOOL' ? tool('move_file', { src: s, dst: d }) : mcp('move_file', { src: s, dst: d }));
    for (const f of FAULTS) {
      it(`${via}: ${f.name}, after the bytes moved: 503, everything still at the source, and the retry completes the move`, async () => {
        await seedEverything('from.txt');
        for (const m of f.methods) fail(m, f.part, f.err(), f.opts);

        const a = await move('from.txt', 'to.txt');

        assertMoveStillOwed(via, a, 'to.txt');
        const fired = f.methods.reduce((n, m) => n + faults.fired(m, `${S}_${f.part}`), 0);
        assert.ok(fired > 0, `the fault armed on ${f.methods} of ${S}_${f.part} never fired — the move does not go through them, so this case injected nothing`);
        assert.ok(onDisk('to.txt') && !onDisk('from.txt'), 'fixture: the bytes did not move, so this is not a failure AFTER the bytes moved');
        const atSource = await heldAt('from.txt');
        assert.deepEqual(atSource.rows, rowsOf('from.txt'), 'a row of the file is not at the source: a record step that fails after the bytes moved must leave every row where it was');
        assert.equal(atSource.job, jobOf('from.txt'), 'the queued job is not at the source');
        assert.deepEqual(atSource.links, LINKS, 'the file\'s links are not at the source');
        const atDestination = await heldAt('to.txt');
        assert.deepEqual(atDestination.rows, [], 'a row of the file is at the destination although the move failed: half a move');
        assert.equal(atDestination.job, null, 'the job is at the destination although the move failed');

        faults.clear();
        const retry = await move('from.txt', 'to.txt');
        assert.equal(retry.code ?? retry.status, 200, `the retried move: ${JSON.stringify(retry.body ?? retry.text)}`);
        await assertMovedWhole();
      });
    }

    it(`${via}: a move still owed leaves the failure that stopped it in the log, whichever door met it`, async () => {
      await seedEverything('from.txt');
      for (const m of INSERTS) fail(m, 'files', F.storeGone.single);
      const { emitted, result: a } = await logLinesDuring(() => move('from.txt', 'to.txt'));
      assertMoveStillOwed(via, a, 'to.txt');
      assert.ok(emitted.some(l => /\[ERROR\].*failed with a 5xx.*caused by: MongoServerSelectionError/.test(l)),
        `the answer says the move will be completed and the log holds nothing of what stopped it:\n${emitted.join('\n')}`);
    });

    it(`${via}: control, no fault: the same move arrives whole (what the retries above must reach)`, async () => {
      await seedEverything('from.txt');
      const a = await move('from.txt', 'to.txt');
      assert.equal(a.code ?? a.status, 200, `the move: ${JSON.stringify(a.body ?? a.text)}`);
      await assertMovedWhole();
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
    // Each path at least once: the retry tombstones what it completes, as the orphan rule does for one file.
    assert.deepEqual([...new Set(await tombstoned())], ['dir/one.txt', 'dir/two.txt']);
  });

  it('a tombstone that lands after its clean-up was refused is never published, and the sweep\'s settle removes it', async () => {
    await seed('late.txt');
    fail('insertMany', 'file_tombstones', F.storeGone.bulk, { lateMs: 400 });
    fail('deleteMany', 'file_tombstones', F.storeGone.single);
    const a = await restMove('late.txt', 'moved.txt');
    assertStoreAnswer('REST move', a);
    assert.ok(await eventually(async () => (await door.mongo.col(`${S}_file_tombstones`).countDocuments()) > 0, 2_000),
      'the late insert never landed — the case is not the one the drive saw');
    await tombstones.whenPendingFileTombstoneDropsSettle();
    assert.deepEqual(await tombstoned(), [], 'a tombstone the store applied after the act failed is served to peers');
    assert.ok(onDisk('late.txt'));
    await tombstones.settleStalePendingFileTombstones(S, new Date(Date.now() + 24 * 3_600_000));
    assert.equal(await door.mongo.col(`${S}_file_tombstones`).countDocuments(), 0,
      'the settle kept a pending tombstone for a file that is still here');
  });
});

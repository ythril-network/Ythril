/**
 * A destination that cannot be created is refused BEFORE anything is written, and every door says so alike (bundle-44, Q-351).
 *
 * ## The defect
 *
 * Nothing looks at a destination's ancestors. A move, a `mkdir`, an upload or a `write_file` whose path runs THROUGH a regular
 * file (`a.txt/x`, where `a.txt` is a file) reaches the filesystem and fails there, and each door reports the filesystem's
 * own failure in its own words: REST answers `500 { error: 'Failed to ...' }`, MCP answers `400` carrying the raw message —
 * `ENOTDIR … '/data/files/<space>/a.txt/x'`, the server's absolute data path, to the caller. A directory moved into itself
 * (`d` -> `d/sub`) is the same failure by another errno. Worse, the move has published pending tombstones and held the
 * queued jobs by then.
 *
 * ## The rule
 *
 * A destination whose path cannot be created is a refusal about THE CALLER'S PATH, answered the same on every door that can be
 * asked to place bytes or a directory there:
 *
 * - status `409`, a body carrying `code: 'path_blocked'` and a `path` RELATIVE to the space (the blocker, or the requested path
 *   — never the absolute data root, never an errno);
 * - nothing written: no tombstone, the source's bytes and record where they were, the blocking file untouched, no staged chunk.
 *
 * Why `409` and not `400`: a peer pushing bytes treats `400` as "refused about the bytes" and stops sending them until the hash
 * changes (`sync/file-push.ts`); a refusal about the RECEIVER'S tree must not read like that.
 *
 * `a` -> `ab` is NOT refused: "under the source" is decided by whole path segments, never by a string prefix.
 *
 * ## Doors held, all or none
 *
 * REST `PATCH /api/files`, `POST /api/move_file`, MCP `move_file`; REST `mkdir`, MCP `create_dir`; REST upload and MCP
 * `write_file`; the chunked upload at its FIRST range (nothing staged), and at a later range when the blocker appeared in
 * between (staged ranges discarded). The doors are the real handlers (`_file-act-doors.mjs`); only auth is skipped.
 *
 * Red against 664676ef: REST answers 500, MCP 400 with the raw message, the chunked first range answers 202.
 *
 * Run: node --test testing/standalone/a-destination-blocked-by-a-file-is-refused-alike-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'destblocked';
const T0 = '2026-09-01T00:00:00.000Z';

let acts, chunks, mkdirHandler, uploadHandler, toolHandler, ADMIN;

const handlerOf = (router, method, route) => {
  const layer = router.stack.find(l => l.route?.path === route && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${route} on the router — re-anchor this test`);
  return layer.route.stack.at(-1).handle;
};

/** One request through a route's own handler (past rate limit and auth), as `_file-act-doors.mjs` does for PATCH and DELETE. */
async function call(handler, { params = {}, query = {}, body = {}, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: 'POST', params, query, body, headers: lower, ip: '127.0.0.1',
    authToken: { id: 't', name: 'test', rights: ADMIN },
    get: (h) => lower[String(h).toLowerCase()],
    is: (type) => (lower['content-type'] ?? '').includes(type.split('/')[1]) };
  const res = { code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handler(req, res);
  return res;
}

/** A door's answer, whichever door it is: the status, the `code` and `path` it carries, and every byte of text it said. */
function normalised(answer, { via }) {
  if ('code' in answer) {   // a REST answer
    const b = answer.body ?? {};
    const carried = via === 'tool' ? (b.data ?? {}) : b;   // `POST /api/<tool>`: the structured detail is `data`
    return { status: answer.code, code: carried.code, path: carried.path, wire: JSON.stringify({ body: b, headers: answer.headers }) };
  }
  return { status: answer.status, code: answer.sc?.code, path: answer.sc?.path, wire: JSON.stringify({ text: answer.text, sc: answer.sc }) };
}

/** The doors that can be asked to place bytes or a directory under `a.txt/`. `run` returns the normalised answer. */
const DOORS = () => [
  { name: 'REST PATCH /api/files (move)', move: true, run: async (src, dst) => normalised(await acts.rest('PATCH', { path: src }, { destination: dst }), { via: 'rest' }) },
  { name: 'POST /api/move_file', move: true, run: async (src, dst) => normalised(await call(toolHandler, { params: { tool: 'move_file' }, body: { space: S, src, dst } }), { via: 'tool' }) },
  { name: 'MCP move_file', move: true, run: async (src, dst) => normalised(await acts.mcp('move_file', { src, dst }), { via: 'mcp' }) },
  { name: 'REST mkdir', dir: true, run: async (p) => normalised(await call(mkdirHandler, { params: { spaceId: S }, query: { path: p } }), { via: 'rest' }) },
  { name: 'MCP create_dir', dir: true, run: async (p) => normalised(await acts.mcp('create_dir', { path: p }), { via: 'mcp' }) },
  { name: 'REST upload', run: async (p) => normalised(await call(uploadHandler, { params: { spaceId: S }, query: { path: p },
    body: { content: 'hello' }, headers: { 'content-type': 'application/json' } }), { via: 'rest' }) },
  { name: 'MCP write_file', run: async (p) => normalised(await acts.mcp('write_file', { path: p, content: 'hello' }), { via: 'mcp' }) },
  { name: 'REST chunked upload, first range', chunked: true, run: async (p) => normalised(await call(uploadHandler, { params: { spaceId: S }, query: { path: p },
    body: Buffer.from('abcd'), headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-3/8' } }), { via: 'rest' }) },
];

/** Ask a door for the blocked destination: a move to `a.txt/x`, a directory `a.txt/d`, a file `a.txt/f`. */
const askBlocked = (d) => (d.move ? d.run('s.txt', 'a.txt/x') : d.run(d.dir ? 'a.txt/d' : 'a.txt/f'));

/** The shared refusal: 409, `path_blocked`, a relative path under the blocker, nothing the filesystem or the data root said. */
function assertRefusedAlike(door, a, blocker) {
  assert.equal(a.status, 409, `${door}: a destination blocked by a file answered ${a.status}, not 409 — ${a.wire}`);
  assert.equal(a.code, 'path_blocked', `${door}: the body carries code ${JSON.stringify(a.code)}, not 'path_blocked' — ${a.wire}`);
  assert.equal(typeof a.path, 'string', `${door}: the body names no path — ${a.wire}`);
  assert.ok(!path.isAbsolute(a.path) && !/^[A-Za-z]:[\\/]/.test(a.path) && !a.path.startsWith('/'),
    `${door}: the path is absolute (${a.path}); it must be relative to the space`);
  assert.ok(a.path === blocker || a.path.startsWith(`${blocker}/`),
    `${door}: the path is ${JSON.stringify(a.path)}, which is neither the blocker (${blocker}) nor a path under it`);
  const root = process.env['DATA_ROOT'];
  for (const form of [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '/')]) {
    assert.ok(!a.wire.includes(form), `${door}: the answer carries the server's data root: ${a.wire}`);
  }
  assert.doesNotMatch(a.wire, /ENOTDIR|ENOENT|EEXIST|EISDIR|EINVAL|EPERM|errno/,
    `${door}: the answer carries the filesystem's own text: ${a.wire}`);
}

/** What a refused act must have left alone. */
async function assertNothingWritten(door, { moveSource = false } = {}) {
  assert.deepEqual(await acts.raw(), [], `${door}: a refused destination left a tombstone behind`);
  assert.equal(fs.readFileSync(path.join(acts.root(), 'a.txt'), 'utf8'), 'content of a.txt', `${door}: the blocking file changed`);
  assert.ok(fs.statSync(path.join(acts.root(), 'a.txt')).isFile(), `${door}: the blocking file is no longer a file`);
  assert.ok(!acts.onDisk('a.txt/x') && !acts.onDisk('a.txt/d') && !acts.onDisk('a.txt/f'), `${door}: something exists under the file`);
  if (moveSource) {
    assert.equal(fs.readFileSync(path.join(acts.root(), 's.txt'), 'utf8'), 'content of s.txt', `${door}: the source's bytes are not where they were`);
    const row = await acts.door.coll(S, 'files').findOne({ _id: 's.txt' });
    assert.ok(row, `${door}: the source's record is gone`);
    assert.equal(row.updatedAt, T0, `${door}: the source's record was rewritten`);
    assert.equal(await acts.door.coll(S, 'files').countDocuments({ _id: { $regex: '^a\\.txt/' } }), 0, `${door}: a record exists under the blocking file`);
  }
}

const stagedAt = async (p, total) => ({
  received: await chunks.getUploadReceived(S, p, total),
  dir: fs.existsSync(path.join(process.env['DATA_ROOT'], '.chunks', S, chunks.uploadId(S, p, total))),
});

describe('a destination blocked by a file is refused, alike, before anything is written', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'destblocked', space: S });
    chunks = await import('../../server/dist/files/chunks.js');
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const { toolsRouter } = await import('../../server/dist/api/tools.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    mkdirHandler = handlerOf(fileStoreRouter, 'post', '/:spaceId/mkdir');
    uploadHandler = handlerOf(fileStoreRouter, 'post', '/:spaceId');
    toolHandler = handlerOf(toolsRouter, 'post', '/:tool');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    fs.rmSync(path.join(process.env['DATA_ROOT'], '.chunks', S), { recursive: true, force: true });
    await acts.seed('a.txt');
    await acts.seed('s.txt');
  });

  describe('a path through a regular file', () => {
    for (const d of DOORS()) {
      it(`${d.name}: 409 path_blocked, a relative path, no data root, no filesystem text`, async () => {
        assertRefusedAlike(d.name, await askBlocked(d), 'a.txt');
      });

      it(`${d.name}: nothing was written`, async () => {
        await askBlocked(d);
        await assertNothingWritten(d.name, { moveSource: !!d.move });
        if (d.chunked) {
          assert.deepEqual(await stagedAt('a.txt/f', 8), { received: 0, dir: false },
            `${d.name}: a refused first range left staged chunks behind`);
        }
      });
    }

    it('a chunked upload whose blocker appears between two ranges is refused at the later one, and the staged ranges are discarded', async () => {
      const send = (range, bytes) => call(uploadHandler, { params: { spaceId: S }, query: { path: 'n/f' }, body: Buffer.from(bytes),
        headers: { 'content-type': 'application/octet-stream', 'content-range': range } });
      const first = await send('bytes 0-3/8', 'abcd');
      assert.equal(first.code, 202, `the first range, with nothing in the way: ${JSON.stringify(first.body)}`);
      await acts.seed('n');   // a file now holds the name the upload's directory would need
      const last = normalised(await send('bytes 4-7/8', 'efgh'), { via: 'rest' });
      assertRefusedAlike('REST chunked upload, last range', last, 'n');
      assert.deepEqual(await stagedAt('n/f', 8), { received: 0, dir: false }, 'the refused upload left its staged ranges behind');
      assert.equal(fs.readFileSync(path.join(acts.root(), 'n'), 'utf8'), 'content of n', 'the file that took the name changed');
    });
  });

  describe('a directory moved into itself', () => {
    for (const d of DOORS().filter(x => x.move)) {
      it(`${d.name}: d -> d/sub is 409 path_blocked, and the directory, its file and its record are untouched`, async () => {
        await acts.seed('d/f.txt');
        const a = await d.run('d', 'd/sub');
        assertRefusedAlike(d.name, a, 'd');
        assert.deepEqual(await acts.raw(), [], `${d.name}: a directory moved into itself left a tombstone`);
        assert.equal(fs.readFileSync(path.join(acts.root(), 'd', 'f.txt'), 'utf8'), 'content of d/f.txt', `${d.name}: the directory's file moved`);
        assert.ok(!acts.onDisk('d/sub'), `${d.name}: the directory was moved into itself`);
        const row = await acts.door.coll(S, 'files').findOne({ _id: 'd/f.txt' });
        assert.ok(row && row.updatedAt === T0, `${d.name}: the child's record was moved or rewritten`);
      });

      it(`${d.name}: a -> ab is NOT refused (whole path segments, not a string prefix)`, async () => {
        await acts.seed('a/f.txt');
        const a = await d.run('a', 'ab');
        assert.ok(a.status >= 200 && a.status < 300, `${d.name}: a move of a to ab answered ${a.status} — ${a.wire}`);
        assert.ok(acts.onDisk('ab/f.txt') && !acts.onDisk('a/f.txt'), `${d.name}: the directory did not arrive at ab`);
        assert.ok(await acts.door.coll(S, 'files').findOne({ _id: 'ab/f.txt' }), `${d.name}: the child's record did not follow`);
      });
    }
  });
});

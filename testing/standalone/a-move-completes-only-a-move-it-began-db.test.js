/**
 * A retried move completes only a move it began: the source's bytes absent and the destination's present is ALSO what
 * an orphan source beside an unrelated file looks like, so the completion asks for the marker the first attempt wrote
 * (bundle-30 I15, preship-3 P3-2) — and asks the store whether anything is recorded at a path with one record, not
 * every record under it (P3-7).
 *
 * ## The defect
 *
 * I14 completed a move that a store failure stopped after its bytes: no bytes at `src`, a file at `dst`, live records
 * at `src`. An orphan `a.txt` (record kept, bytes gone) moved onto an unrelated `b.txt` matches that too, so the move
 * re-keyed `b.txt`'s jobs to `a.txt`'s, deleted `b.txt`'s chunks and put `a.txt`'s under its ids, overwrote its
 * sidecars, lost `a.txt`'s record on the duplicate key, and answered `200` with a `file.updated` webhook for a move
 * that never happened. At a17f24dc that was a `404`.
 *
 * ## What is asserted, on REST and MCP
 *
 * - The orphan onto an unrelated file is not found, and leaves both files' records, chunks and bytes as they were.
 * - The existence questions the completions ask answer from the live file records at, or under, a path — never a
 *   chunk, never a soft-deleted record.
 *
 * The completion of a move that WAS begun is asserted in `a-file-act-answers-true-in-an-outage-db`.
 *
 * Run: node --test testing/standalone/a-move-completes-only-a-move-it-began-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'moveowed';
const T0 = '2026-09-01T00:00:00.000Z';

let door, files, fileMeta, handlers, callTool, ADMIN;

const root = () => path.join(process.env['DATA_ROOT'], 'files', S);
const read = (p) => fs.readFileSync(path.join(root(), p), 'utf8');
const record = (p, extra = {}) => ({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, ...extra });

async function rest(method, query, body = {}) {
  const req = { method, params: { spaceId: S }, query, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handlers[method](req, res);
  return res;
}
async function mcp(tool, args) {
  const out = await callTool({ name: tool, args: { space: S, ...args },
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { status: out.status, isError: !!out.result.isError, text };
}

describe('a retried move completes only a move it began', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'moveowed', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    files = await import('../../server/dist/files/files.js');
    fileMeta = await import('../../server/dist/files/file-meta.js');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods.patch);
    assert.ok(layer, 'no PATCH /:spaceId on the file router — re-anchor this test');
    handlers = { PATCH: layer.route.stack.at(-1).handle };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    for (const part of ['files', 'file_tombstones']) await door.coll(S, part).deleteMany({});
    fs.rmSync(root(), { recursive: true, force: true });
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}: an orphan source moved onto an unrelated file is not found, and changes neither`, async () => {
      await files.writeFile(S, 'b.txt', 'the bytes of b');
      await door.coll(S, 'files').insertMany([
        record('b.txt', { description: 'b, as written' }),
        record('b.txt#chunk-0', { parentFileId: 'b.txt', description: 'a passage of b' }),
        record('a.txt', { description: 'a, whose bytes went out of band' }),
        record('a.txt#chunk-0', { parentFileId: 'a.txt', description: 'a passage of a' }),
      ]);
      const a = via === 'REST'
        ? await rest('PATCH', { path: 'a.txt' }, { destination: 'b.txt' })
        : await mcp('move_file', { src: 'a.txt', dst: 'b.txt' });
      const status = 'code' in a ? a.code : a.status;
      assert.equal(status, 404, `a move of a source with no bytes and no move begun answered ${status}: ${JSON.stringify(a.body ?? a.text)}`);
      const rows = Object.fromEntries((await door.coll(S, 'files').find({}).toArray()).map(r => [r._id, r]));
      assert.equal(rows['b.txt']?.description, 'b, as written', 'b.txt\'s record was replaced');
      assert.equal(rows['b.txt#chunk-0']?.description, 'a passage of b', 'b.txt\'s chunk was replaced by a.txt\'s');
      assert.equal(rows['a.txt']?.description, 'a, whose bytes went out of band', 'a.txt\'s record was lost');
      assert.equal(rows['a.txt#chunk-0']?.parentFileId, 'a.txt', 'a.txt\'s chunk was moved under b.txt');
      assert.equal(read('b.txt'), 'the bytes of b');
      assert.deepEqual(await door.coll(S, 'file_tombstones').find({}).toArray(), [], 'a move that did not happen wrote a tombstone');
    });
  }

  it('the existence questions answer from the live file records at, or under, a path', async () => {
    assert.equal(typeof fileMeta.hasLiveFileRecordAt, 'function', 'files/file-meta.js exports no hasLiveFileRecordAt');
    assert.equal(typeof fileMeta.hasLiveFileRecordUnder, 'function', 'files/file-meta.js exports no hasLiveFileRecordUnder');
    await door.coll(S, 'files').insertMany([
      record('x.txt'),
      record('d/one.txt'),
      record('e/soft.txt', { deletedAt: T0 }),
      record('f.txt#chunk-0', { parentFileId: 'f.txt' }),
      record('g/h.txt#chunk-0', { parentFileId: 'g/h.txt' }),
    ]);
    const at = (p) => fileMeta.hasLiveFileRecordAt(S, p);
    const under = (p) => fileMeta.hasLiveFileRecordUnder(S, p);
    assert.deepEqual([await at('x.txt'), await under('x.txt')], [true, false], 'a record AT the path is not one UNDER it');
    assert.deepEqual([await at('d'), await under('d')], [true, true], 'a record under the folder');
    assert.deepEqual([await at('e'), await under('e')], [false, false], 'a soft-deleted record is not live');
    assert.deepEqual([await at('f.txt'), await at('g')], [false, false], 'a chunk is not a file record');
    assert.deepEqual([await at('nothing'), await under('nothing')], [false, false]);
  });
});

/**
 * A file the listing names under its decomposed (NFD) spelling is deleted and moved by that name, on both doors (Q-581, bundle-88 review F1, F2).
 *
 * ## The rule
 *
 * A file system that keeps a decomposed name holds the bytes under it while the row is at the NFC key. The listing (`list_dir`, the REST
 * listing: `listDir`) reports the disk's name, and the byte doors (REST `GET`, MCP `read_file`) find the file under it through `heldSpellingOf`.
 * So the name the listing gives must act on the file it names, on every door that takes a caller's path:
 *
 *  1. DELETE (REST `DELETE /api/files/:space`, MCP `delete_file`) removes the bytes it finds under that spelling: they are gone from the
 *     disk, one tombstone stands at the key, no row is left and the byte door answers "not found" afterwards. With no row at the key
 *     the delete still finds the file (it used to answer "not found" for a file GET served).
 *  2. MOVE and rename (REST `PATCH`, MCP `move_file`) carry the bytes it finds under that spelling to the destination: the destination holds
 *     them, no spelling of the source is left, the row follows, and the old key is tombstoned once.
 *  3. A name held under no spelling is "not found" on both acts, as before (control).
 *  4. A directory the root's listing names under its decomposed spelling is listed by its NFC name too (the one `listDir` both doors use).
 *
 * ## Seen red
 *
 * On the base, 1 with a row: the delete answered success, published the tombstone and left the bytes on the disk (the settle read the NFC
 * path and found nothing there); 1 without a row: "not found"; 2: "not found" on both doors; 4: ENOENT on the scandir of the NFC name. 3 and the NFC controls are green on the base.
 *
 * The decomposed names are built with `normalize('NFD')`. A file system that does not keep a decomposed name cannot hold the fixture, and
 * the suite says so and skips.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-listed-decomposed-file-is-deleted-and-moved-by-its-listed-name-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'nfdacts';
const NAME = 'Café.txt';
const NFD_NAME = NAME.normalize('NFD');
const DIR = 'Dossier été';
const CONTENT = 'the file held decomposed';
const T0 = '2026-09-01T00:00:00.000Z';

let d, getHandler, rights, heldSpellingOf;
const rows = () => d.door.coll(S, 'files');
const rootDir = () => path.join(process.env['DATA_ROOT'], 'files', S);

/** Put bytes on the disk under exactly the spelling given (every upload door would have normalised it away). */
const put = (rel, content = CONTENT) => {
  const abs = path.join(rootDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
/** The row an upload would have left, at the NFC key. */
const rowAt = (key) => rows().insertOne({ _id: key, spaceId: S, path: key, sizeBytes: Buffer.byteLength(CONTENT), tags: [], createdAt: T0, updatedAt: T0, seq: 3 });
/** Every file name under the space's root as the disk spells it, relative. */
const onDisk = () => {
  const found = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), next); else found.push(next);
    }
  };
  walk(rootDir(), '');
  return found.sort();
};
/** The tombstone paths the space holds, stored or published, sorted. */
const tombstonePaths = async () => (await d.raw()).map(t => t.path).sort();

/** GET /api/files/:space?path= through the router's own handler. */
async function restGet(p) {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  Object.assign(res, { code: 200, headers: {}, json: undefined, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; } });
  const done = new Promise(resolve => { res.json = () => { resolve(); return res; }; res.on('finish', resolve); res.destroy = () => { resolve(); return res; }; });
  await getHandler({ method: 'GET', params: { spaceId: S }, query: { path: p }, headers: {}, authToken: { id: 't', name: 'test', rights }, get: () => undefined }, res);
  await done;
  return { code: res.code, text: Buffer.concat(chunks).toString('utf8') };
}

/** The name the listing of `dir` gives for the one file in it (REST and MCP list through the one `listDir`). */
async function listedName(dir = '') {
  const listed = (await d.files.listDir(S, dir)).filter(e => e.type === 'file');
  assert.equal(listed.length, 1, `the listing of '${dir}' names ${JSON.stringify(listed)}`);
  return listed[0].name;
}

describe('a listed decomposed file is deleted and moved by the name the listing gives', { skip }, () => {
  let keeps = false;
  before(async () => {
    d = await openFileActDoors({ suite: 'nfdacts', space: S });
    ({ heldSpellingOf } = await import('../../server/dist/files/held-spelling.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['get']);
    assert.ok(layer, 'no GET /:spaceId on the file router - re-anchor this test');
    getHandler = layer.route.stack.at(-1).handle;
    assert.notEqual(NFD_NAME, NAME, 'the fixture name has no decomposed form');
    fs.mkdirSync(rootDir(), { recursive: true });
    fs.writeFileSync(path.join(rootDir(), `probe-${NFD_NAME}`), 'x');
    keeps = fs.readdirSync(rootDir()).includes(`probe-${NFD_NAME}`);
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });

  const needsDecomposed = (t) => { if (!keeps) { t.skip('this file system normalises a decomposed name on write: the fixture cannot exist here'); return false; } return true; };

  for (const via of ['REST', 'MCP']) {
    describe(`${via}`, () => {
      it('delete by the listed name removes the bytes, tombstones the key once and leaves no row (1)', async (t) => {
        if (!needsDecomposed(t)) return;
        put(NFD_NAME);
        await rowAt(NAME);
        const listed = await listedName();
        assert.equal(listed, NFD_NAME, 'the listing does not name the decomposed spelling: the fixture is not what the test means');
        const a = await d.del(via, listed);
        assert.equal(d.failed(a), false, JSON.stringify(a.body ?? a.text));
        assert.deepEqual(onDisk(), [], 'the delete answered success and left the bytes on the disk');
        assert.deepEqual(await tombstonePaths(), [NAME], 'the delete did not leave exactly one tombstone, at the key');
        assert.equal(await rows().findOne({ _id: NAME }), null, 'the row survived the delete');
        assert.equal(await heldSpellingOf(S, NAME), null, 'the file is still held under a spelling of its key');
        assert.equal((await restGet(NAME)).code, 404, 'the byte door still serves a deleted file');
      });

      it('delete by the listed name finds a file that has no row (1)', async (t) => {
        if (!needsDecomposed(t)) return;
        put(path.join(DIR, NFD_NAME));
        const listed = await listedName(DIR);
        const a = await d.del(via, `${DIR}/${listed}`);
        assert.equal(d.failed(a), false, `a file the listing names and GET serves was refused: ${JSON.stringify(a.body ?? a.text)}`);
        assert.deepEqual(onDisk(), [], 'the bytes are still on the disk');
        assert.deepEqual(await tombstonePaths(), [`${DIR}/${NAME}`]);
      });

      it('move by the listed name carries the bytes and the row, and tombstones the old key once (2)', async (t) => {
        if (!needsDecomposed(t)) return;
        put(NFD_NAME);
        await rowAt(NAME);
        const listed = await listedName();
        const a = await d.move(via, listed, 'moved/there.txt');
        assert.equal(d.failed(a), false, `a file the listing names and GET serves cannot be moved by that name: ${JSON.stringify(a.body ?? a.text)}`);
        assert.deepEqual(onDisk(), ['moved/there.txt'], 'the bytes are not at the destination alone');
        assert.equal(fs.readFileSync(path.join(rootDir(), 'moved/there.txt'), 'utf8'), CONTENT);
        assert.equal(await rows().findOne({ _id: NAME }), null, 'the row stayed at the source');
        assert.ok(await rows().findOne({ _id: 'moved/there.txt' }), 'the row did not follow the bytes');
        assert.deepEqual(await tombstonePaths(), [NAME], 'the old key is not tombstoned exactly once');
        assert.equal((await restGet(NAME)).code, 404);
        assert.equal((await restGet('moved/there.txt')).text, CONTENT);
      });

      it('a name held under no spelling is not found, on both acts (3)', async () => {
        put('other.txt');
        const del = await d.del(via, 'nothing-here.txt');
        assert.equal(d.failed(del), true);
        assert.equal(d.statusOf(del), 404);
        const mv = await d.move(via, 'nothing-here.txt', 'moved/there.txt');
        assert.equal(d.failed(mv), true);
        assert.equal(d.statusOf(mv), 404);
        assert.deepEqual(onDisk(), ['other.txt']);
        assert.deepEqual(await tombstonePaths(), []);
      });

      it('a file held under its NFC name is deleted and moved as before (control)', async () => {
        put(NAME);
        await rowAt(NAME);
        assert.equal(d.failed(await d.move(via, NAME, 'moved/there.txt')), false);
        assert.deepEqual(onDisk(), ['moved/there.txt']);
        assert.equal(d.failed(await d.del(via, 'moved/there.txt')), false);
        assert.deepEqual(onDisk(), []);
      });
    });
  }

  it('a directory held under its decomposed name is listed by its NFC name, on both doors (4)', async (t) => {
    if (!needsDecomposed(t)) return;
    put(path.join(DIR.normalize('NFD'), 'inner.txt'));
    const listed = await d.files.listDir(S, DIR);
    assert.deepEqual(listed.map(e => e.name), ['inner.txt'], 'the listing of a directory held decomposed failed by its NFC name');
  });
});

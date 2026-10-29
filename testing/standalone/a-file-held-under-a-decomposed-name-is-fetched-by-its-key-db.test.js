/**
 * A file held under a decomposed (NFD) name is advertised by its KEY and fetched by it (Q-581).
 *
 * ## The rule
 *
 *  1. The manifest advertises each file under its NFC key (`path`), and keeps where the disk holds it (`diskPath`) for local use only.
 *  2. The manifest ROUTE sends exactly the four wire keys: `diskPath` never leaves the instance.
 *  3. The byte door finds a file held under another spelling of the key it was asked for, on both doors with one lookup and one
 *     answer: REST `GET /api/files/:space?path=` and MCP `read_file`.
 *  4. A path that leaves the space, and a symlinked entry that points outside it, are refused as before; a file that is held under no
 *     spelling is "not found" as before.
 *
 * ## Seen red
 *
 * On the base: 1 (the entry's path is the on-disk spelling), 2 (the entry carries no `diskPath`: the route had no projection to hold),
 * 3 on both doors ("Path not found" / "File not found" for a file the manifest advertised), and 5 (two spellings of one file are two entries).
 * 4 and the controls are green on the base: they pin what the lookup must not widen.
 *
 * The decomposed names are built with `normalize('NFD')` in the test. A file system that does not keep a decomposed name (it
 * normalises on write) cannot hold the fixture, and the suite says so and skips.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-file-held-under-a-decomposed-name-is-fetched-by-its-key-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const S = 'nfdbytes';
const NFC_NAME = 'Café.txt';
const NFD_NAME = NFC_NAME.normalize('NFD');
const NFC_DIR = 'Dossier été';
const NFD_DIR = NFC_DIR.normalize('NFD');
const ADMIN_RIGHTS = async () => {
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  return { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
};

let door, root, rights, getHandler, manifestRoute, callTool, buildFileManifest;

/** GET /api/files/:space?path= through the router's own handler: the status, the body bytes as text, and the headers. */
async function restGet(p) {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  Object.assign(res, {
    code: 200, headers: {}, json: undefined, jsonBody: undefined,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  });
  const done = new Promise(resolve => {
    res.json = (b) => { res.jsonBody = b; resolve(); return res; };
    res.on('finish', resolve);
    res.destroy = () => { resolve(); return res; };
  });
  const req = { method: 'GET', params: { spaceId: S }, query: { path: p }, headers: {}, authToken: { id: 't', name: 'test', rights }, get: () => undefined };
  await getHandler(req, res);
  await done;
  return { code: res.code, text: Buffer.concat(chunks).toString('utf8'), json: res.jsonBody };
}

async function mcpRead(p) {
  const out = await callTool({ name: 'read_file', args: { space: S, path: p },
    caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  return { isError: !!out.result.isError, text, sc: out.result.structuredContent ?? {} };
}

const put = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

/** Whether this file system keeps the decomposed spelling as written: the fixture cannot exist where it does not. */
function keepsDecomposedNames() {
  const probe = path.join(root, `probe-${NFD_NAME}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(probe, 'x');
  const kept = fs.readdirSync(root).includes(`probe-${NFD_NAME}`);
  fs.rmSync(probe, { force: true });
  return kept;
}

describe('a file held under a decomposed name is advertised and fetched by its key', { skip }, () => {
  let keeps = false;
  before(async () => {
    door = await openPushDoor({ suite: 'nfdbytes', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    root = path.join(process.env['DATA_ROOT'], 'files', S);
    rights = await ADMIN_RIGHTS();
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['get']);
    assert.ok(layer, 'no GET /:spaceId on the file router - re-anchor this test');
    getHandler = layer.route.stack.at(-1).handle;
    const { syncManifestRouter } = await import('../../server/dist/api/sync/manifest.js');
    const m = syncManifestRouter.stack.find(l => l.route?.path === '/manifest' && l.route.methods['get']);
    assert.ok(m, 'no GET /manifest on the sync manifest router - re-anchor this test');
    manifestRoute = m.route.stack.at(-1).handle;
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ buildFileManifest } = await import('../../server/dist/files/manifest.js'));
    assert.notEqual(NFD_NAME, NFC_NAME, 'the fixture name has no decomposed form');
    keeps = keepsDecomposedNames();
  });
  after(async () => { await door?.close(); });
  beforeEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); });

  const needsDecomposed = (t) => { if (!keeps) { t.skip('this file system normalises a decomposed name on write: the fixture cannot exist here'); return false; } return true; };

  it('the manifest names the NFC key and keeps the disk spelling local (rule 1)', async (t) => {
    if (!needsDecomposed(t)) return;
    put(NFD_NAME, 'bytes held decomposed');
    put(path.join(NFD_DIR, NFD_NAME), 'bytes in a decomposed directory');
    put('plain.txt', 'bytes under a plain name');
    const entries = await buildFileManifest(S);
    const byKey = Object.fromEntries(entries.map(e => [e.path, e.diskPath]));
    assert.deepEqual(Object.keys(byKey).sort(), [`${NFC_DIR}/${NFC_NAME}`, NFC_NAME, 'plain.txt'].sort(), 'an entry is advertised under a spelling that is not its key');
    assert.equal(byKey[NFC_NAME], NFD_NAME, 'the disk spelling is not kept for local use');
    assert.equal(byKey[`${NFC_DIR}/${NFC_NAME}`], `${NFD_DIR}/${NFD_NAME}`);
    assert.equal(byKey['plain.txt'], 'plain.txt');
  });

  it('the manifest route sends exactly the four wire keys: a disk path never leaves the instance (rule 2)', async (t) => {
    if (!needsDecomposed(t)) return;
    put(NFD_NAME, 'bytes held decomposed');
    const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await manifestRoute({ query: { spaceId: S }, authToken: { id: 't', name: 'test', rights, peerInstanceId: undefined }, get: () => undefined, headers: {} }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.manifest.length, 1);
    assert.deepEqual(Object.keys(res.body.manifest[0]).sort(), ['modifiedAt', 'path', 'sha256', 'size']);
    assert.equal(res.body.manifest[0].path, NFC_NAME);
  });

  describe('the byte door finds the file under the spelling its holder keeps (rule 3)', () => {
    it('REST GET by the NFC key returns the bytes of a file held decomposed', async (t) => {
      if (!needsDecomposed(t)) return;
      put(NFD_NAME, 'the decomposed file');
      const got = await restGet(NFC_NAME);
      assert.equal(got.code, 200, `the door answered ${got.code} ${JSON.stringify(got.json)} for a file the manifest advertises`);
      assert.equal(got.text, 'the decomposed file');
    });

    it('REST GET finds the file when a DIRECTORY on its path is held decomposed too', async (t) => {
      if (!needsDecomposed(t)) return;
      put(path.join(NFD_DIR, NFD_NAME), 'in a decomposed directory');
      const got = await restGet(`${NFC_DIR}/${NFC_NAME}`);
      assert.equal(got.code, 200, JSON.stringify(got.json));
      assert.equal(got.text, 'in a decomposed directory');
    });

    it('MCP read_file finds the same file by the same key', async (t) => {
      if (!needsDecomposed(t)) return;
      put(NFD_NAME, 'the decomposed file');
      const got = await mcpRead(NFC_NAME);
      assert.equal(got.isError, false, got.text);
      assert.equal(got.sc.content, 'the decomposed file');
    });

    it('a file held under its NFC name is served as before (control)', async () => {
      put(NFC_NAME, 'the composed file');
      assert.equal((await restGet(NFC_NAME)).text, 'the composed file');
      assert.equal((await mcpRead(NFC_NAME)).sc.content, 'the composed file');
    });

    it('a name held under no spelling is not found, with the one answer each door gave before', async () => {
      const rest = await restGet('nothing-here.txt');
      assert.equal(rest.code, 404);
      assert.equal(rest.json.error, 'Path not found');
      const mcp = await mcpRead('nothing-here.txt');
      assert.equal(mcp.isError, true);
      assert.match(mcp.text, /File not found: nothing-here\.txt/);
    });
  });

  describe('what the lookup must not widen (rule 4)', () => {
    it('a path that leaves the space is refused on both doors', async () => {
      put('inside.txt', 'x');
      const rest = await restGet('../outside.txt');
      assert.equal(rest.code, 404, 'a traversal answered something other than not found');
      assert.equal(rest.text, '');
      const mcp = await mcpRead('../outside.txt');
      assert.equal(mcp.isError, true);
    });

    it('a decomposed DIRECTORY that is a link to a directory outside the space is refused', async (t) => {
      if (!needsDecomposed(t)) return;
      const outside = path.join(path.dirname(root), 'outside-dir');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, NFC_NAME), 'secret');
      // A junction needs no privilege on Windows; on POSIX the type is ignored and it is a symlink.
      fs.symlinkSync(outside, path.join(root, NFD_DIR), 'junction');
      const rest = await restGet(`${NFC_DIR}/${NFC_NAME}`);
      assert.notEqual(rest.text, 'secret', 'the byte door served a file outside the space through a link');
      assert.notEqual(rest.code, 200);
      const mcp = await mcpRead(`${NFC_DIR}/${NFC_NAME}`);
      assert.notEqual(mcp.sc.content, 'secret', 'read_file served a file outside the space through a link');
      assert.equal(mcp.isError, true);
    });
  });

  it('two spellings of one file are ONE manifest entry, the one that is the key, and the other is said once per window (rule 5)', async (t) => {
    if (!needsDecomposed(t)) return;
    put(NFC_NAME, 'composed');
    put(NFD_NAME, 'decomposed');
    const first = await logLinesDuring(() => buildFileManifest(S));
    const entries = first.result.filter(e => e.path === NFC_NAME);
    assert.equal(first.result.length, 1, `the file is ${first.result.length} manifest entries`);
    assert.equal(entries[0].diskPath, NFC_NAME, 'the spelling that IS the key did not win');
    const said = (lines) => lines.filter(l => l.includes('two spellings of one file'));
    assert.equal(said(first.lines).length, 1, `said ${said(first.lines).length} times: ${JSON.stringify(first.lines)}`);
    const second = await logLinesDuring(() => buildFileManifest(S));
    assert.equal(said(second.lines).length, 0, 'said again inside its window');
  });
});

/**
 * The upload door refuses a PEER's push at an existing path it cannot look at: `409 path_unreadable`, answered before the body is read
 * (bundle-70, Q-350 b, slice S2; vet reliability R7, integration I4, performance P9).
 *
 * ## The defect
 *
 * A path whose existing entry cannot be looked at (a permission refused on the file or a directory above it, an I/O fault) is a path the
 * door cannot judge: it cannot tell a file there from none, so it cannot decide whether the pushed bytes replace, conflict with or
 * duplicate what is there. Today the door reads the whole body, then runs into the fault somewhere in the write (or writes through
 * it), and answers a `500` or a store failure the sender reads as "try again next cycle": the whole file, again, every cycle.
 *
 * ## The rule
 *
 *  1. A peer's push (`POST /api/files/:space?path=`, single body or the first range of a chunked upload) at a path whose existing entry
 *     cannot be looked at (one `lstat`, no hash of existing bytes) is answered `409` with `code: 'path_unreadable'`.
 *  2. The look is made BEFORE the body is read: the door has not touched `req.body` (a body of 10 GiB is not read for an answer that does not need it).
 *  3. Nothing is stored (no bytes, no row), and the answer names no path, errno or data root.
 *  4. Only a peer's push is asked: a person's upload at the same path is not answered with this code, a path that is simply absent is stored,
 *     and a readable existing path is replaced, as before.
 *
 * ## How
 *
 * The route's real layers after the size guard (the raw-body capture and the handler, and any layer the fix adds there), in order, on a request built
 * here whose `body` is a getter that records every read (the raw-body capture is told the body is already parsed, so the getter is touched
 * only by what the handler itself does). The failure is injected through the `fs/promises` seam (`_path-look-faults.mjs`).
 *
 * ## Seen red
 *
 * 1 to 3 on the base: the handler reads the body (the getter records it) and answers something other than `409 path_unreadable`. The controls
 * (a person, an absent path, a readable existing path) are green on the base.
 *
 * Run: node --test testing/standalone/the-upload-door-refuses-a-peer-push-at-a-path-it-cannot-look-at-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { peerToken } from './_push-door.mjs';
import { USER_TOKEN } from './_byte-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { lookFaultsAround } from './_path-look-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'unreadupl';
const EXISTING = 'u/x.txt';

let door, layers;

/** Run the route's layers after the size guard, in order, as express would, and read what it answered and how often the body was touched. */
async function post({ p, bytes, token, range }) {
  const reads = [];
  const req = {
    method: 'POST', params: { spaceId: S }, query: { path: p }, authToken: token, ip: '127.0.0.1',
    headers: { 'content-type': 'application/octet-stream', ...(range ? { 'content-range': range } : {}) },
    get: () => undefined, is: () => true,
  };
  Object.defineProperty(req, 'body', { get() { reads.push(new Error('body read').stack); return bytes; }, set() {}, configurable: true });
  const res = {
    code: 200, body: undefined, headersSent: false, headers: {},
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; },
    on() { return this; }, once() { return this; }, emit() { return false; },
  };
  const pending = [];
  let i = 0;
  const next = (err) => {
    if (err) throw err;
    const h = layers[i++];
    if (!h) return undefined;
    const run = Promise.resolve(h(req, res, next));
    pending.push(run);
    return run;
  };
  next();
  for (let k = 0; k < pending.length; k++) await pending[k];
  assert.ok(res.headersSent, `POST /api/files/${S} settled without answering`);
  return { code: res.code, body: res.body, reads: reads.length };
}

const rows = (p) => door.coll(S, 'files').countDocuments({ _id: p });
const onDisk = (p) => { const abs = path.join(door.localFilesRoot(S), p); return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; };
/** `post` under the faults: its answer, plus `fired` (the look calls the faults answered), asserted AFTER the answer so a door that never looks fails on its answer. */
async function underLookFaults(root, rules, ask) {
  const { result, fired } = await lookFaultsAround(root, rules, ask);
  return { ...result, fired };
}
const refuseLook = [{ fn: 'lstat', match: rel => rel === EXISTING }, { fn: 'stat', match: rel => rel === EXISTING }];

describe('the upload door refuses a peer push at a path it cannot look at', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'unreadupl', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['post']);
    assert.ok(layer, 'no POST /:spaceId on the file router - re-anchor this test');
    const handles = layer.route.stack.map(l => l.handle);
    const at = handles.findIndex(h => h.name === 'enforceSizeLimit');
    assert.ok(at >= 0, 'the upload route no longer has an `enforceSizeLimit` layer - re-anchor this test to the layers the door really runs');
    layers = handles.slice(at + 1);
    assert.ok(layers.length >= 2, 'the layers after the size guard are fewer than [raw-body capture, handler]');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    door.writeLocalFile(S, EXISTING, 'old bytes');
  });

  describe('a peer\'s push (rules 1 to 3)', () => {
    it('one body at an unreadable existing path: 409 path_unreadable, the body unread, nothing stored', async () => {
      const a = await underLookFaults(door.localFilesRoot(S), refuseLook, () => post({ p: EXISTING, bytes: Buffer.from('new bytes'), token: peerToken(PEER) }));
      assert.equal(a.code, 409, `the door answered ${a.code} ${JSON.stringify(a.body)}`);
      assert.equal(a.body.code, 'path_unreadable', JSON.stringify(a.body));
      assert.equal(a.reads, 0, 'the door read the body before it looked at the path: a body is read for an answer that does not need it');
      assert.equal(onDisk(EXISTING), 'old bytes', 'the existing bytes were replaced or removed');
      assert.equal(await rows(EXISTING), 0, 'a row was written for a push that was refused');
      assert.ok(a.fired > 0, 'the injected look never fired: the 409 was not reached through the fault');
    });

    it('the first range of a chunked upload is answered the same way, before its body is read and before anything is staged', async () => {
      const a = await underLookFaults(door.localFilesRoot(S), refuseLook, () => post({ p: EXISTING, bytes: Buffer.from('new '), token: peerToken(PEER), range: 'bytes 0-3/9' }));
      assert.equal(a.code, 409, `the door answered ${a.code} ${JSON.stringify(a.body)}`);
      assert.equal(a.body.code, 'path_unreadable', JSON.stringify(a.body));
      assert.equal(a.reads, 0, 'the chunked door read the body before it looked at the path');
      assert.equal(onDisk(EXISTING), 'old bytes');
      assert.ok(a.fired > 0, 'the injected look never fired: the 409 was not reached through the fault');
    });

    it('the answer names no path, no errno and no data root', async () => {
      const a = await underLookFaults(door.localFilesRoot(S), refuseLook, () => post({ p: EXISTING, bytes: Buffer.from('new bytes'), token: peerToken(PEER) }));
      assert.equal(a.code, 409);
      const wire = JSON.stringify(a.body);
      const dataRoot = process.env['DATA_ROOT'];
      for (const form of [dataRoot, dataRoot.replaceAll('\\', '\\\\'), dataRoot.replaceAll('\\', '/'), 'EACCES', EXISTING]) {
        assert.ok(!wire.includes(form), `the answer carries ${JSON.stringify(form)}: ${wire}`);
      }
    });
  });

  describe('what it does not widen (rule 4)', () => {
    it('a person\'s upload at the same path is not answered path_unreadable (the door asks a peer only)', async () => {
      const a = await underLookFaults(door.localFilesRoot(S), refuseLook, () => post({ p: EXISTING, bytes: Buffer.from('new bytes'), token: USER_TOKEN }));
      assert.ok(!(a.code === 409 && a.body?.code === 'path_unreadable'), `a person's upload was refused as a peer's: ${a.code} ${JSON.stringify(a.body)}`);
    });

    it('a peer\'s push at a path that is absent is stored', async () => {
      const a = await post({ p: 'fresh/y.txt', bytes: Buffer.from('fresh bytes'), token: peerToken(PEER) });
      assert.ok([200, 201, 202].includes(a.code), `${a.code} ${JSON.stringify(a.body)}`);
      assert.equal(onDisk('fresh/y.txt'), 'fresh bytes');
    });

    it('a peer\'s push over a readable existing path replaces it', async () => {
      const a = await post({ p: EXISTING, bytes: Buffer.from('replacement'), token: peerToken(PEER) });
      assert.ok([200, 201, 202].includes(a.code), `${a.code} ${JSON.stringify(a.body)}`);
      assert.equal(onDisk(EXISTING), 'replacement');
    });
  });
});

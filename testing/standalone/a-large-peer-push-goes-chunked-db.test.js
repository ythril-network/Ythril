/**
 * A file above the receiver's single-body limit is pushed CHUNKED, and the chunked door refuses bytes that are not the bytes
 * it was promised (bundle-48, Q-296, design D8).
 *
 * ## The defect
 *
 * The sync push reads the whole stored file (`readStored`) and sends it as ONE `POST /api/files/:space` body. The receiver
 * accepts one body up to `maxUploadBodyBytes` (default 50 MiB: `enforceSizeLimit` and `express.raw`), and answers `413` to
 * anything above it. So a file above the limit is refused by every receiver on every cycle, for ever: the sender cannot tell
 * the refusal from a failure, remembers nothing, and sends the whole file again. The chunked door exists for exactly this
 * (`Content-Range`, `maxChunkedUploadBytes`, 10 GiB by default) and no peer ever reaches it.
 *
 * ## The rule (design D8)
 *
 * When a file exceeds the peer's single-body limit the sender streams it to the CHUNKED door, each request under that
 * limit, with the expected sha256 of the whole file in a header the chunked door binds to the assembly. And the door's half
 * of that bargain: an assembly whose hash is not the header's is REFUSED and stores nothing, so a chunk that arrived altered
 * (or from a different file under the same path and size) cannot become the file.
 *
 * ## What is real and what is the test's
 *
 * The RECEIVER is the real upload route, with its real guards (`enforceSizeLimit`, the `express.raw` parser, then the
 * handler that does chunk staging, assembly, the shadow question and the metadata write) taken from `fileStoreRouter`, over
 * the pull door's peer-side space; only the auth and rate-limit layers in front of them are replaced by a peer token. The
 * limit is lowered through the real config key (`maxUploadBodyBytes`) so the fixture is a few hundred KiB, generated here,
 * not stored. The SENDER is the real engine (`runSyncForPeer`), pushing to that receiver through `peerSafeFetch`.
 *
 * The control (a file under the limit goes as one body) is green on the base and keeps a red result for the large file from
 * being a harness that never reached the push.
 *
 * ## One name this file assumes
 *
 * The expected-hash header is `EXPECTED_HASH_HEADER` below. The design says "the expected sha256 in a header" and does not
 * name it; the constant is the one place to change when the implementation does.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27219 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-large-peer-push-goes-chunked-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { peerToken } from './_push-door.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** The header the chunked door reads the whole file's expected sha256 from (assumed; see the header comment). */
const EXPECTED_HASH_HEADER = 'x-expected-sha256';

const S = 'pullbig';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const KIB = 1024;
/** The receiver's single-body limit, lowered from 50 MiB so the fixture is small. */
const LIMIT = 256 * KIB;
/** Several limits long, so a chunked upload has to be more than two requests and the last one is a remainder. */
const BIG_BYTES = 5 * LIMIT + 12_345;

/** A deterministic body of `n` bytes that is not repetitive (a repeating pattern would hide a chunk landing in the wrong place). */
function fixture(n, seed) {
  const out = Buffer.alloc(n);
  for (let off = 0, i = 0; off < n; i++) {
    const block = createHash('sha256').update(`${seed}:${i}`).digest();
    block.copy(out, off, 0, Math.min(block.length, n - off));
    off += block.length;
  }
  return out;
}

let door, peer, originalUrl, originalLimit;

/**
 * This file's receiver: the real upload route's last three layers behind a peer token, in front of the pull door's own fake
 * peer, which answers every other route. Every upload it sees is logged with its framing.
 */
async function openReceiver(real) {
  const { fileStoreRouter } = await import('../../server/dist/api/files.js');
  const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['post']);
  assert.ok(layer, 'no POST /:spaceId on the file router — re-anchor this file');
  const handles = layer.route.stack.map(l => l.handle);
  assert.equal(handles.at(-3)?.name, 'enforceSizeLimit',
    'the upload route no longer ends [enforceSizeLimit, raw-body capture, handler] — re-anchor this file to the layers the receiver really runs');
  const target = new URL(real.url);
  const uploads = [];
  const app = express();
  app.post('/api/files/:spaceId', (req, res, next) => {
    req.authToken = peerToken('pullbig-sender');
    const log = { path: String(req.query.path ?? ''), range: req.headers['content-range'], length: Number(req.headers['content-length'] ?? -1),
      expectedHash: req.headers[EXPECTED_HASH_HEADER], answer: undefined };
    uploads.push(log);
    const json = res.json.bind(res);
    res.json = (b) => { log.answer = { code: res.statusCode, body: b }; return json(b); };
    next();
  }, ...handles.slice(-3));
  app.use((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // own-listener: binds every interface, because the push reaches a peer only by its LAN address (loopback is refused)
  const server = await new Promise(resolve => { const s = app.listen(0, '0.0.0.0', () => resolve(s)); });
  return {
    uploads, url: `http://${privateHostAddress()}:${server.address().port}`,
    reset() { uploads.length = 0; },
    close: () => new Promise(r => server.close(r)),
  };
}

/** What the receiver holds at `p`: its bytes and its file row. */
const landedBytes = (p) => fsp.readFile(path.join(door.peerFilesRoot(S), p)).catch(() => null);
const landedRow = (p) => door.coll(door.peerSide(S), 'files').findOne({ _id: p });

describe('a large peer push goes through the chunked door', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'pullbig', spaces: [S], files: true, direction: 'both', meta: { [S]: { suppressEmbeddings: true } } });
    peer = await openReceiver(door);
    originalUrl = door.member().url;
    door.member().url = peer.url;
    originalLimit = door.config().maxUploadBodyBytes;
    door.config().maxUploadBodyBytes = LIMIT;
  });
  after(async () => {
    if (door) {
      door.member().url = originalUrl;
      if (originalLimit === undefined) delete door.config().maxUploadBodyBytes; else door.config().maxUploadBodyBytes = originalLimit;
    }
    await peer?.close();
    await door?.close();
  });
  beforeEach(async () => { await door.reset(); door.configure({ direction: 'both' }); peer.reset(); });

  describe('the sender (the real engine)', () => {
    it('control: a file under the limit is pushed as ONE body and lands', async () => {
      const small = fixture(4 * KIB, 'small');
      door.writeLocalFile(S, 'small.bin', small);
      await door.sync();
      const sent = peer.uploads.filter(u => u.path === 'small.bin');
      assert.ok(sent.length >= 1, 'the sender never pushed the small file — the case is not reached');
      assert.ok(sent.every(u => u.range === undefined), `a file under the limit was chunked: ${JSON.stringify(sent.map(u => u.range))}`);
      assert.deepEqual(await landedBytes('small.bin'), small);
    });

    it('a file above the limit lands byte for byte, in requests that each fit under it', async () => {
      const big = fixture(BIG_BYTES, 'big');
      door.writeLocalFile(S, 'big.bin', big);
      // Two cycles: a sender that learns the limit from a refusal may take the second to use the chunked door. The base fails
      // both identically (413 each time), which is the defect.
      await door.sync();
      if ((await landedBytes('big.bin')) === null) await door.sync();

      const sent = peer.uploads.filter(u => u.path === 'big.bin');
      assert.ok(sent.length >= 1, 'the sender never pushed the large file — the case is not reached');
      const refused = sent.filter(u => u.answer?.code === 413);
      assert.deepEqual(refused.map(u => u.length), [],
        `the receiver answered 413 to ${refused.length} push(es) of the large file: it was sent as one body of ${refused[0]?.length} bytes against a limit of ${LIMIT}`);
      assert.deepEqual(await landedBytes('big.bin'), big, 'the large file did not land at the receiver, or landed altered');
      assert.equal((await landedRow('big.bin'))?.sha256, sha(big), 'the receiver holds no row naming the large file\'s hash');
      const ranged = sent.filter(u => u.range !== undefined);
      assert.ok(ranged.length >= Math.ceil(BIG_BYTES / LIMIT), `the large file went in ${ranged.length} chunked request(s), fewer than the ${Math.ceil(BIG_BYTES / LIMIT)} its size needs under a limit of ${LIMIT}`);
      for (const u of ranged) assert.ok(u.length <= LIMIT, `a chunk of ${u.length} bytes is over the receiver's single-body limit of ${LIMIT}`);
    });

    it('the whole file\'s hash travels with a chunked push, and it is the hash of the file', async () => {
      const big = fixture(BIG_BYTES, 'big-hash');
      door.writeLocalFile(S, 'hashed.bin', big);
      await door.sync();
      if ((await landedBytes('hashed.bin')) === null) await door.sync();
      const ranged = peer.uploads.filter(u => u.path === 'hashed.bin' && u.range !== undefined);
      assert.ok(ranged.length >= 2, `the large file was never pushed chunked (${peer.uploads.filter(u => u.path === 'hashed.bin').length} whole-body push(es) instead), so no chunk carries its hash`);
      assert.deepEqual([...new Set(ranged.map(u => u.expectedHash))], [sha(big)],
        `every chunk carries ${EXPECTED_HASH_HEADER}: the sha256 of the whole file, which the chunked door binds to the assembly`);
    });
  });

  describe('the chunked door (the real handler)', () => {
    /** The route's handler, called as `_byte-door.mjs` calls it but with the request's headers settable (its `post` takes none). */
    async function handler() {
      const { fileStoreRouter } = await import('../../server/dist/api/files.js');
      const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['post']);
      return layer.route.stack.at(-1).handle;
    }
    async function postRange(handle, { space, p, bytes, range, headers }) {
      const req = {
        method: 'POST', params: { spaceId: space }, query: { path: p }, body: bytes, authToken: peerToken(PEER),
        headers: { 'content-type': 'application/octet-stream', 'content-range': range, ...headers }, get: () => undefined, is: () => false,
      };
      const res = {
        code: 200, body: undefined, headersSent: false, headers: {},
        status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; },
      };
      await handle(req, res);
      assert.ok(res.headersSent, 'the upload handler settled without answering');
      return { code: res.code, body: res.body };
    }
    /** An upload in three ranges, in order, each carrying `headers`; stops at the first refusal. Returns every answer. */
    async function upload(p, content, headers) {
      const handle = await handler();
      const third = Math.ceil(content.length / 3);
      const answers = [];
      for (let start = 0; start < content.length; start += third) {
        const end = Math.min(start + third, content.length);
        const a = await postRange(handle, { space: S, p, bytes: content.subarray(start, end), range: `bytes ${start}-${end - 1}/${content.length}`, headers });
        answers.push(a);
        if (a.code >= 400) break;
      }
      return answers;
    }
    const CONTENT = fixture(30 * KIB, 'door');
    const onDisk = (p) => fsp.readFile(path.join(door.localFilesRoot(S), p)).catch(() => null);

    it('control: a chunked upload whose header is the hash of the whole file is assembled and stored', async () => {
      const answers = await upload('ok.bin', CONTENT, { [EXPECTED_HASH_HEADER]: sha(CONTENT) });
      assert.deepEqual(answers.map(a => a.code < 300), answers.map(() => true), `a matching chunked upload was refused: ${JSON.stringify(answers)}`);
      assert.deepEqual(await onDisk('ok.bin'), CONTENT);
    });

    it('an assembly whose hash is not the header\'s is refused, and nothing is stored at the path', async () => {
      const promised = sha(fixture(30 * KIB, 'a different file of the same size'));
      const answers = await upload('forged.bin', CONTENT, { [EXPECTED_HASH_HEADER]: promised });
      const refusal = answers.find(a => a.code >= 400 && a.code < 500);
      assert.ok(refusal, `the chunked door assembled bytes whose hash is not the one promised in ${EXPECTED_HASH_HEADER}: ${JSON.stringify(answers)}`);
      assert.equal(await onDisk('forged.bin'), null, 'bytes that did not match the promised hash were stored at the path');
      assert.equal(await door.coll(S, 'files').findOne({ _id: 'forged.bin' }), null, 'a row names a file whose bytes did not match the promised hash');
    });
  });
});

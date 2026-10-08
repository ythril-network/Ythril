/**
 * A file's bytes are PULLED as a stream, bounded by the size the peer declared, and verified before anything is committed
 * (bundle-48, Q-296, design D8).
 *
 * ## The defect
 *
 * The manifest pull downloads a file with `Buffer.from(await dl.arrayBuffer())` and only then hashes it. The peer chooses the
 * body, so the cost of a pull is the peer's to set: a body ten thousand times the size the manifest declared is read whole
 * into this process's memory, and so is every honest large file. Under it `peerSafeFetch` buffers every non-redirect response
 * (`ssrfSafeFetch` detaches from the pinned connection with `arrayBuffer()`), so a streaming pull cannot be built on top of
 * the fetch as it stands.
 *
 * ## The rule (design D8)
 *
 * The body streams through ONE hashing tap, capped at the declared size, and the tap decides in its `flush`; a body that
 * runs past the declared size, a body whose hash is not the manifest's, and a body that dies on the way each leave THE STORED
 * FILE AT THAT PATH UNTOUCHED and NO STAGED TEMP FILE behind. It is stated over every way a body can be wrong, and over both
 * starting states of the path (a file the peer's change would REPLACE, and a path this instance does not hold yet).
 *
 * ## What is observed, and why it is not a probe of memory
 *
 * "Consumed as a stream" is observed from the PEER's side, which is the only side a test can see without instrumenting the
 * server: the fake peer sends a body far larger than it declared, in chunks that wait for the socket to drain, and records how
 * many bytes it managed to send before the connection was closed on it. A receiver that reads the whole body (`arrayBuffer`)
 * lets the peer send every byte of it; one that streams through a tap capped at the declared size stops reading, and closes
 * the connection, within the declared size plus what the socket buffers hold.
 *
 * The control cases (a body that is honest lands; a hash mismatch of the right length is refused) are green on the base and
 * are here so a red result for the oversize body cannot be a harness that never reached the pull.
 *
 * The fake peer is this file's own: it forwards every route to the pull door's real handlers and answers the one byte
 * download itself, because the door's canned download route serves what is on the peer's disk and cannot say anything else.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27219 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-pull-streams-and-verifies-in-flush-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'pullstream';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const MIB = 1024 * 1024;
const MODIFIED = '2026-10-01T00:00:00.000Z';

/** What this instance holds, and what the peer changes it to. Both small: the bodies below are what is large. */
const HELD = Buffer.from('the version both instances last agreed on\n'.repeat(64));
const NEXT = Buffer.from('the version the peer changed it to, honestly\n'.repeat(64));
/** A same-length body whose hash is NOT the manifest's. */
const FORGED = Buffer.alloc(NEXT.length, 0x66);
/** Far past the declared size, and past anything a socket's buffers hold between two processes on one host. */
const OVERSIZE = 64 * MIB;
/** What the peer may have sent when the receiver closed on it: the declared size plus generous socket buffering. */
const STREAMED_AT_MOST = 16 * MIB;

let door, peer;

/**
 * This file's fake peer: an HTTP server in front of the pull door's own, forwarding every request to it untouched, except
 * `GET /api/files/:space` (the byte download), which `peer.download` answers when set, and `GET /api/sync/manifest`, which
 * `peer.manifest` answers when set. Set per case; `reset` clears both.
 */
async function openFrontPeer(real) {
  const target = new URL(real.url);
  const state = { download: null, manifest: null, downloads: 0, served: [] };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && pathname.startsWith('/api/files/') && state.download) {
      state.downloads++;
      state.download(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/sync/manifest' && state.manifest) { state.manifest(req, res); return; }
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  return {
    state, url: `http://${privateHostAddress()}:${server.address().port}`,
    reset() { state.download = null; state.manifest = null; state.downloads = 0; state.served = []; },
    close: () => new Promise(r => server.close(r)),
  };
}

/**
 * Answer a download with `prefix` followed by filler up to `total` bytes, in 256 KiB writes that each wait for the socket to
 * drain — so what the peer has SENT tracks what the receiver has READ. No Content-Length: the declared size is the
 * manifest's, and a body that does not honour it is the case. `failAfter` kills the connection once that many bytes are out.
 * Returns what happened, settled when the connection is closed by either side.
 */
function streamBody(res, { prefix, total, failAfter }) {
  const outcome = { sent: 0, ended: false, closed: false, settled: undefined };
  outcome.settled = new Promise(resolve => res.on('close', () => { outcome.closed = true; resolve(); }));
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  const CHUNK = 256 * 1024;
  const filler = Buffer.alloc(CHUNK, 0x78);
  void (async () => {
    let first = true;
    while (outcome.sent < total && !res.destroyed) {
      const buf = first ? Buffer.concat([prefix, filler.subarray(0, Math.max(0, CHUNK - prefix.length))]) : filler;
      first = false;
      outcome.sent += buf.length;
      if (!res.write(buf)) {
        await new Promise(r => { const done = () => { res.off('drain', done); res.off('close', done); r(); }; res.once('drain', done); res.once('close', done); });
      }
      if (failAfter !== undefined && outcome.sent >= failAfter) { res.socket?.destroy(); return; }
    }
    if (!res.destroyed) { outcome.ended = true; res.end(); }
  })();
  return outcome;
}

/** Answer a download with exactly `bytes` and a Content-Length — an ordinary honest (or forged) body. */
function wholeBody(res, bytes) {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
  res.end(bytes);
}

/** Advertise one file with the size and hash the peer DECLARES, whatever it then serves. */
const advertise = (p, { sha256, size }) => {
  peer.state.manifest = (_req, res) => {
    const body = Buffer.from(JSON.stringify({ spaceId: S, manifest: [{ path: p, sha256, size, modifiedAt: MODIFIED }] }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  };
};

const onDisk = async (p) => fsp.readFile(path.join(door.localFilesRoot(S), p)).catch(() => null);
const rowOf = (p) => door.coll(S, 'files').findOne({ _id: p });
const tmpDir = () => path.join(path.resolve(door.localFilesRoot(S), '..', '..'), '.stored-tmp');
/** Every temp file the stored-bytes door has staged, by name. */
const stagedNames = async () => (await fsp.readdir(tmpDir()).catch(() => [])).filter(n => n.endsWith('.tmp')).sort();

/** Wait until the peer's side of a download is closed (the receiver ended it or read it to the end), bounded. */
async function settled(outcome) {
  await Promise.race([outcome.settled, new Promise((_r, rej) => setTimeout(() => rej(new Error('the download was never closed by either side')), 20_000).unref())]);
}

describe('a pulled file is streamed, capped at its declared size, and verified before it lands', { skip }, () => {
  let originalUrl;
  before(async () => {
    door = await openPullDoor({ suite: 'pullstream', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    peer = await openFrontPeer(door);
    originalUrl = door.member().url;
    door.member().url = peer.url;
  });
  after(async () => {
    if (door) door.member().url = originalUrl;
    await peer?.close();
    await door?.close();
  });
  beforeEach(async () => { await door.reset(); peer.reset(); });

  /** Put HELD on the peer and on this instance by a real pull, so the next cycle's change is one the pull REPLACES. */
  async function holdAgreedVersion(p) {
    door.seedPeerFile(S, p, HELD);
    advertise(p, { sha256: sha(HELD), size: HELD.length });
    await door.sync();
    assert.deepEqual(await onDisk(p), HELD, 'the setup pull did not store the agreed version — the cases below are not reached');
    peer.reset();
  }

  describe('control: the harness reaches the pull', () => {
    it('an honest body replaces the file the peer changed, and the row follows', async () => {
      await holdAgreedVersion('doc.bin');
      advertise('doc.bin', { sha256: sha(NEXT), size: NEXT.length });
      peer.state.download = (_req, res) => wholeBody(res, NEXT);
      await door.sync();
      assert.equal(peer.state.downloads, 1, 'the receiver did not download the changed file');
      assert.deepEqual(await onDisk('doc.bin'), NEXT);
      assert.equal((await rowOf('doc.bin'))?.sha256, sha(NEXT));
      assert.deepEqual(await stagedNames(), [], 'a staged temp file was left behind by a pull that landed');
    });
  });

  /**
   * Every way a body can be wrong, each over both starting states of the path. A case names what the peer declared and what
   * it served; the assertions are the rule and are the same for all of them.
   */
  const WRONG = [
    {
      name: 'a body of the right size whose hash is not the manifest\'s',
      declared: { sha256: sha(NEXT), size: NEXT.length },
      serve: (res) => wholeBody(res, FORGED),
    },
    {
      name: 'a body that runs far past the declared size',
      declared: { sha256: sha(NEXT), size: NEXT.length },
      serve: (res) => streamBody(res, { prefix: NEXT, total: OVERSIZE }),
      streamsAtMost: STREAMED_AT_MOST,
    },
    {
      name: 'a body that is cut short, then the connection dies',
      declared: { sha256: sha(NEXT), size: 8 * MIB },
      serve: (res) => streamBody(res, { prefix: NEXT, total: 8 * MIB, failAfter: MIB }),
    },
  ];

  for (const start of ['a file the peer\'s change would REPLACE', 'a path this instance does not hold yet']) {
    describe(`over ${start}`, () => {
      const replacing = start.includes('REPLACE');
      const target = replacing ? 'doc.bin' : 'fresh.bin';

      for (const wrong of WRONG) {
        it(`${wrong.name}: the stored file is untouched, no row changes, no temp file is left${wrong.streamsAtMost ? ', and the body was consumed as a stream' : ''}`, async () => {
          if (replacing) await holdAgreedVersion(target);
          const heldRow = await rowOf(target);
          const heldBytes = await onDisk(target);
          const stagedBefore = await stagedNames();
          advertise(target, wrong.declared);
          let outcome;
          peer.state.download = (_req, res) => { outcome = wrong.serve(res); };

          await door.sync();

          assert.equal(peer.state.downloads, 1, 'the receiver never downloaded the file — the case is not reached');
          if (outcome) await settled(outcome);
          assert.deepEqual(await onDisk(target), heldBytes,
            replacing ? 'the stored file at the path was changed by a body that did not verify' : 'a body that did not verify was stored at a path this instance did not hold');
          const row = await rowOf(target);
          assert.equal(row?.sha256, heldRow?.sha256, 'the file row now names bytes that were never verified');
          assert.deepEqual(await stagedNames(), stagedBefore, 'a staged temp file was left behind by a body that did not verify');
          if (wrong.streamsAtMost) {
            assert.ok(outcome.sent < wrong.streamsAtMost,
              `the peer sent ${outcome.sent} of ${OVERSIZE} bytes before the receiver let go: a body past its declared size of ${wrong.declared.size} was read whole `
              + '(arrayBuffer) instead of stopped at the cap, so the peer, not this instance, chose what the pull cost');
            assert.equal(outcome.ended, false, 'the peer was allowed to send the whole oversize body to the end');
          }
        });
      }
    });
  }
});

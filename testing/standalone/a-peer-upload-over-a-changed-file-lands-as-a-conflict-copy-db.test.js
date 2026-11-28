/**
 * A peer's upload over a live file holding other bytes is decided as the pull decides it (bundle-47, Q-410).
 *
 * ## What was true before
 *
 * The byte door a peer pushes to (`POST /api/files/:spaceId`) asked only whether a held tombstone shadows the bytes, then stored them
 * over the live file. The pull side decides the same situation by `decideFilePull`: skip, replace when only the peer changed it since
 * the hash both last held (`syncBase`), otherwise keep ours and save theirs as a conflict copy. A push relied on the SENDER's decision
 * alone, so a sender with no agreed hash whose clock ran ahead, or any client holding a peer token, overwrote local work.
 *
 * ## What holds now, on both byte branches (a single body and a chunked one)
 *
 * - live file with other bytes and no agreed hash: the live file is untouched, the peer's bytes land under a conflict-copy name, a
 *   conflict record names both paths and the peer, and the answer is `200 { conflict: { path } }` (an error would make the sender
 *   upload again every cycle);
 * - live file still at the agreed hash: the peer's bytes replace it (only the peer changed it);
 * - the peer sends the agreed hash while ours moved on: nothing is stored, `200 { skipped: 'older' }`;
 * - the S-A.7 order (peer upload, local delete, local re-create, the peer re-sends the erased bytes): the re-created file survives.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peer-upload-over-a-changed-file-lands-as-a-conflict-copy-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'peerconflict';
const sha = (s) => createHash('sha256').update(s).digest('hex');

let door; let server; let peerKey; let adminKey; let mongo; let spaceCollection;

/** One upload: `single` sends the body whole, `chunked` as one Content-Range covering it, as file push sends a large file. */
async function put(key, p, text, shape = 'single') {
  const body = Buffer.from(text);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/octet-stream' };
  if (shape === 'chunked') {
    headers['Content-Range'] = `bytes 0-${body.length - 1}/${body.length}`;
    headers['x-expected-sha256'] = sha(text);
  }
  const r = await fetch(`${server.url}/api/files/${S}?path=${encodeURIComponent(p)}`, { method: 'POST', headers, body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const read = async (p) => {
  const r = await fetch(`${server.url}/api/files/${S}?path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${adminKey}` } });
  return r.ok ? r.text() : null;
};
const remove = (p) => fetch(`${server.url}/api/files/${S}?path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminKey}` } });
const files = () => mongo.getDb().collection(spaceCollection(S, 'files'));
const conflicts = () => mongo.getDb().collection(spaceCollection(S, 'conflicts')).find({}).toArray();
const agree = (p, text) => files().updateOne({ _id: p }, { $set: { [`syncBase.${PEER}`]: sha(text) } });

describe('a peer upload over a changed file lands as a conflict copy', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'peerconflict', spaces: [S] });
    mongo = await import('../../server/dist/db/mongo.js');
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: area } } })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
  });
  after(async () => { await server?.close(); await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await mongo.getDb().collection(spaceCollection(S, 'conflicts')).deleteMany({});
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
    await files().deleteMany({});
  });

  for (const shape of ['single', 'chunked']) {
    it(`${shape}: other bytes over a live file with no agreed hash keep ours and save theirs as a conflict copy`, async () => {
      const p = `doc-${shape}.txt`;
      assert.ok((await put(adminKey, p, 'local edit')).status < 300, 'the local upload failed: the fixture is wrong');
      const a = await put(peerKey, p, 'their edit', shape);
      assert.equal(a.status, 200, `the conflicting push was not answered 200: ${JSON.stringify(a.body)}`);
      assert.equal(await read(p), 'local edit', 'the peer\'s push overwrote the live file');
      const copy = a.body.conflict?.path;
      assert.ok(typeof copy === 'string' && copy !== p, `the answer names no conflict copy: ${JSON.stringify(a.body)}`);
      assert.equal(await read(copy), 'their edit', 'the conflict copy does not hold the peer\'s bytes');
      const docs = await conflicts();
      assert.deepEqual(docs.map(d => [d.originalPath, d.conflictPath, d.peerInstanceId]), [[p, copy, PEER]], 'no conflict record, or the wrong one');
    });

    it(`${shape}: a live file still at the agreed hash is replaced by the peer's bytes`, async () => {
      const p = `agreed-${shape}.txt`;
      await put(adminKey, p, 'version one');
      await agree(p, 'version one');
      const a = await put(peerKey, p, 'version two', shape);
      assert.ok(a.status < 300, `the push over the agreed hash failed: ${JSON.stringify(a.body)}`);
      assert.equal(await read(p), 'version two', 'the peer\'s change over the agreed version did not replace it');
      assert.deepEqual(await conflicts(), [], 'a replacement over the agreed version raised a conflict');
    });

    it(`${shape}: the peer re-sending the agreed hash after ours moved on stores nothing`, async () => {
      const p = `older-${shape}.txt`;
      await put(adminKey, p, 'ours, newer');
      await agree(p, 'the agreed one');
      const a = await put(peerKey, p, 'the agreed one', shape);
      assert.equal(a.status, 200);
      assert.equal(a.body.skipped, 'older', `an older version was not answered as skipped: ${JSON.stringify(a.body)}`);
      assert.equal(await read(p), 'ours, newer', 'the older version overwrote ours');
      assert.deepEqual(await conflicts(), [], 'an older version raised a conflict');
    });

    it(`${shape}: the S-A.7 order (peer upload, delete, local re-create, peer re-sends) keeps the re-created file`, async () => {
      const p = `sa7-${shape}.txt`;
      assert.ok((await put(peerKey, p, 'erased bytes', shape)).status < 300, 'the first peer upload failed: the fixture is wrong');
      assert.ok((await remove(p)).ok, 'the local delete failed: the fixture is wrong');
      assert.ok((await put(adminKey, p, 're-created here')).status < 300, 'the local re-create failed: the fixture is wrong');
      const a = await put(peerKey, p, 'erased bytes', shape);
      assert.ok(a.status < 300, `the re-send was refused: ${JSON.stringify(a.body)}`);
      assert.equal(await read(p), 're-created here', `the peer's re-send overwrote the re-created file (${JSON.stringify(a.body)})`);
    });
  }
});

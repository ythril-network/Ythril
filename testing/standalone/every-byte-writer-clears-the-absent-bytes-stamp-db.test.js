/**
 * Every writer that puts bytes at a path clears that path's `bytesAbsentSince` in the same write (bundle-70, Q-337, slice S4).
 *
 * ## What it prevents
 *
 * The sweep stamps a record whose bytes are gone and later removes it, but only while the stamp is still the one it wrote (the retire carries the stamp
 * in its filter). A writer that puts bytes back and leaves the stamp makes a LIVE file look like a record that has been waiting for bytes for a day: the
 * next pass would count it as waiting and could retire the record of a file that is on disk. The stamp must therefore go in the writer's own write, for
 * every door that writes bytes, and the dangerous one is the same-hash arrival, which today writes NOTHING (`recordArrivedFile`: bytes equal to what the
 * live row records are no change), so a stamp-clearing that rides on the row write would never run for it.
 *
 * ## What is held, one case each (each seeds a record whose bytes are gone, stamped, then writes through the door)
 *
 *  - REST upload and MCP `write_file` over the path;
 *  - a byte arrival from a peer with a NEW hash, and with the SAME hash and size (the no-write path);
 *  - `upsertFileMeta` (the shared writer of an import's rows and of every door that records a file);
 *  - a move: the destination row does not carry the source's stamp.
 *
 * Not held here: a chunked upload's finish, and a restore's and an import's clearing (the restore/import slice).
 *
 * Red on 8ee92312: no writer knows the field, so each leaves the stamp in place.
 *
 * Run: node --test testing/standalone/every-byte-writer-clears-the-absent-bytes-stamp-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { NOW, SHA_ORPHAN, SHA_PRESENT, orphan } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'absentwriters';
const STAMP = NOW.toISOString();
const PEER = Object.freeze({ instanceId: 'writer-peer', instanceLabel: 'Writer peer' });

let acts, meta;
const rows = () => acts.door.coll(S, 'files');
const rowOf = (p) => rows().findOne({ _id: p });
/** A record whose bytes are gone and that a pass has stamped. */
const stamped = async (p) => { await rows().insertOne(orphan(S, p, { bytesAbsentSince: STAMP })); assert.equal((await rowOf(p)).bytesAbsentSince, STAMP); };
/** What a writer must leave: a row that is there (live) and carries no stamp. */
async function assertClear(p, writer) {
  const row = await rowOf(p);
  assert.ok(row && row.deletedAt === undefined && row.feedMarker !== true, `${writer}: the row is not live after the write: ${JSON.stringify(row)}`);
  assert.equal(row.bytesAbsentSince, undefined, `${writer} put bytes at ${p} and left bytesAbsentSince ${JSON.stringify(row.bytesAbsentSince)}: a live file reads as waiting for its bytes, and a pass can retire it`);
}

describe('every writer of bytes clears the absent-bytes stamp (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'absentwriters', space: S });
    meta = await import('../../server/dist/files/file-meta.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('REST upload', async () => {
    await stamped('up.txt');
    const res = await acts.post('upload', { query: { path: 'up.txt' }, body: { content: 'new bytes' }, headers: { 'content-type': 'application/json' } });
    assert.ok(res.code < 300, `fixture: the upload answered ${res.code} ${JSON.stringify(res.body)}`);
    await assertClear('up.txt', 'REST upload');
  });

  it('MCP write_file', async () => {
    await stamped('wf.txt');
    const out = await acts.mcp('write_file', { path: 'wf.txt', content: 'new bytes' });
    assert.ok(!out.isError, `fixture: write_file answered ${out.text}`);
    await assertClear('wf.txt', 'MCP write_file');
  });

  it('a byte arrival with a NEW hash', async () => {
    await stamped('arr.txt');
    await acts.files.writeFile(S, 'arr.txt', 'bytes from a peer');
    await meta.recordArrivedFile(S, 'arr.txt', 17, 'ee'.repeat(32), PEER);
    await assertClear('arr.txt', 'a byte arrival with a new hash');
  });

  it('a byte arrival with the SAME hash and size, which writes no new row (the stamp must still go)', async () => {
    await stamped('same.txt');
    await acts.files.writeFile(S, 'same.txt', 'bytes of the recorded hash');
    await meta.recordArrivedFile(S, 'same.txt', 12, SHA_ORPHAN, PEER);
    await assertClear('same.txt', 'a same-hash arrival');
  });

  it('upsertFileMeta, the writer an import\'s rows and every door that records a file share', async () => {
    await stamped('ups.txt');
    await acts.files.writeFile(S, 'ups.txt', 'bytes');
    await meta.upsertFileMeta(S, 'ups.txt', 5, { sha256: SHA_PRESENT });
    await assertClear('ups.txt', 'upsertFileMeta');
  });

  it('a move: the destination row does not carry the source\'s stamp', async () => {
    await acts.seed('src.txt', { sha256: SHA_PRESENT, seq: 1, bytesAbsentSince: STAMP });   // bytes are here; the stamp is stale
    const out = await acts.mcp('move_file', { src: 'src.txt', dst: 'dst.txt' });
    assert.ok(!out.isError, `fixture: move_file answered ${out.text}`);
    await assertClear('dst.txt', 'move_file');
  });
});

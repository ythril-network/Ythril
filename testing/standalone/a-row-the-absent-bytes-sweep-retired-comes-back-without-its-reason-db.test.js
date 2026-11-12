/**
 * A file row the absent-bytes sweep retired comes back LIVE without its retirement reason, and a person's later delete of it is a person's delete
 * (bundle-70 lens fix, finding 1).
 *
 * ## The defect
 *
 * With soft delete on, the sweep flags a row whose bytes are gone and writes `retiredBy: 'bytes-lost'` on the flag. The writers that bring a
 * flagged row back (an upload, `upsertFileMeta`; bytes arriving from a peer, `recordArrivedFile`) unset `deletedAt` and `bytesAbsentSince` but
 * never `retiredBy`, so the LIVE row still carried it: a peer pulling `/filemeta` was served the key, which its strict `IncomingFileMetaDoc`
 * refuses, and a person's later delete (which flags again without a reason) was told by the change feed as `reason: 'bytes_lost'`.
 *
 * ## The rule
 *
 *  - a row the sweep retired and an upload revives carries no `retiredBy`, and the pull page a peer reads does not carry it;
 *  - the same for bytes a peer delivers over the flagged row;
 *  - a person's delete of the revived row is in the change feed with no reason.
 *
 * The source half (every reviving writer names `RETIRED_BY`) is `every-writer-of-a-file-rows-bytes-clears-the-absent-bytes-stamp`.
 *
 * Red on 92e1ca8f: the revived row keeps `retiredBy` (each case), the pull page serves it, and the feed says `bytes_lost` for a person's delete.
 *
 * Run: node --test testing/standalone/a-row-the-absent-bytes-sweep-retired-comes-back-without-its-reason-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { THE_TWO_PASSES, SHA_PRESENT, SHA_ORPHAN, passesAt, resetSweepSteps, orphan, retired } from './_absent-bytes-sweep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'retiredback';
const PEER = Object.freeze({ instanceId: 'retired-peer', instanceLabel: 'Retired peer' });

let acts, loader, meta, knownKeys;
const rows = () => acts.door.coll(S, 'files');
const rowOf = (p) => rows().findOne({ _id: p });
const entryOf = () => loader.getConfig().spaces.find(s => s.id === S);

/** Three healthy files and `p` lost; two passes a day apart flag `p` (soft delete on) with the sweep's reason. */
async function sweptAway(p) {
  for (let i = 0; i < 3; i++) await acts.seed(`ok${i}.txt`, { sha256: SHA_PRESENT, seq: 1 });
  await rows().insertOne(orphan(S, p));
  await passesAt(...THE_TWO_PASSES);
  const flagged = await rowOf(p);
  assert.ok(retired(flagged) && typeof flagged.deletedAt === 'string', `fixture: the sweep did not flag ${p}: ${JSON.stringify(flagged)}`);
  assert.equal(flagged.retiredBy, 'bytes-lost', 'fixture: the flag carries no reason');
}

describe('a row the absent-bytes sweep retired comes back without its reason (real MongoDB)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'retiredback', space: S });
    loader = await import('../../server/dist/config/loader.js');
    meta = await import('../../server/dist/files/file-meta.js');
    knownKeys = Object.keys(entryOf());
  });
  after(async () => { await resetSweepSteps(); await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    const entry = entryOf();
    for (const k of Object.keys(entry).filter(k => !knownKeys.includes(k))) delete entry[k];
    loader.getConfig().softDeleteFileMeta = true;
  });
  afterEach(() => { loader.getConfig().softDeleteFileMeta = false; });

  it('an upload revives the row with no retiredBy, and the pull page a peer reads does not carry the key', async () => {
    await sweptAway('back.txt');
    await acts.files.writeFile(S, 'back.txt', 'the bytes again');
    await meta.upsertFileMeta(S, 'back.txt', 15, { sha256: SHA_ORPHAN });

    const live = await rowOf('back.txt');
    assert.equal(live.deletedAt, undefined, 'fixture: the upload did not revive the row');
    assert.equal(live.retiredBy, undefined, `the revived row still carries retiredBy ${JSON.stringify(live.retiredBy)}: a peer's strict schema refuses it, a later delete is told as bytes lost`);
    const said = JSON.stringify(await acts.door.pull('/filemeta', { spaceId: S }));
    assert.ok(said.includes('back.txt'), `fixture: the pull page does not serve the revived row: ${said.slice(0, 300)}`);
    assert.ok(!said.includes('retiredBy'), 'the pull page serves retiredBy: the peer refuses the whole document');
  });

  it('bytes a peer delivers over the flagged row revive it with no retiredBy', async () => {
    await sweptAway('arrived.txt');
    await acts.files.writeFile(S, 'arrived.txt', 'bytes a peer had');
    await meta.recordArrivedFile(S, 'arrived.txt', 16, SHA_PRESENT, PEER);

    const live = await rowOf('arrived.txt');
    assert.equal(live.deletedAt, undefined, 'fixture: the arrival did not revive the row');
    assert.equal(live.retiredBy, undefined, `the row an arrival revived still carries retiredBy ${JSON.stringify(live.retiredBy)}`);
  });

  it('a person\'s delete of the revived row is in the change feed with no reason', async () => {
    const { readFileChanges } = await import('../../server/dist/files/file-changes.js');
    await sweptAway('again.txt');
    await acts.files.writeFile(S, 'again.txt', 'the bytes again');
    await meta.upsertFileMeta(S, 'again.txt', 15, { sha256: SHA_ORPHAN });
    const gone = await acts.mcp('delete_file', { path: 'again.txt' });
    assert.ok(!gone.isError, `fixture: the person's delete was refused: ${gone.text}`);

    const flagged = await rowOf('again.txt');
    assert.ok(typeof flagged?.deletedAt === 'string', `fixture: the delete did not flag the row: ${JSON.stringify(flagged)}`);
    assert.equal(flagged.retiredBy, undefined, 'the person\'s delete kept the sweep\'s reason on the flag');
    const out = await readFileChanges(S, {});
    assert.ok(out.ok, JSON.stringify(out));
    const item = out.body.items.find(i => i.path === 'again.txt');
    assert.equal(item?.deleted, true, `fixture: the feed does not say again.txt was deleted: ${JSON.stringify(item)}`);
    assert.equal(item.reason, undefined, 'the feed tells a person\'s delete as bytes lost: a client mirroring the space keeps a copy the person deleted');
  });
});

/**
 * A write a receiver makes to a file it did not author never makes its copy outrank the publisher's (`Q-143`).
 *
 * ## The defect
 *
 * A file's metadata replicates by `seq`: an arriving record replaces the stored one only when its `seq` is higher.
 * Three writes on the RECEIVING instance stamped the file with the receiver's own next `seq`, as if somebody there
 * had edited it:
 *
 *  - the file-sync pull, recording the bytes it had just downloaded (`upsertFileMeta`);
 *  - the media worker, writing the converted document's excerpt (`updateFileMeta({ excerpt })`) — a field that
 *    never replicates;
 *  - the media worker, writing a derived description (`setDerivedDescriptionIfUnset`).
 *
 * After any of them the receiver's copy compared newer, so the publisher's next description or tag edit was skipped
 * on arrival (`filemeta {upserted: 0, skipped: 1}`) — seen in the sync suite as a subscriber that never received a
 * published file's description. `seq` and `updatedAt` are also in the file hash, so the same stamp faked a Merkle
 * divergence.
 *
 * ## The rule
 *
 * A file write advances `seq` and `updatedAt` only when it changes a field that replicates (`P-32`: an authored write
 * advances the counter). A derived description is written only on a file this instance authored: it is hashed, and a
 * receiver-local one could not replicate.
 *
 * Run: node --test testing/standalone/a-receivers-own-file-writes-do-not-outrank-its-publisher-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const FILE = 'guide/onboarding.md';
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };
const PEER_STAMP = { seq: 7, updatedAt: '2026-09-01T00:00:00.000Z' };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-file-arrival-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, meta, wire;

const files = () => mongo.col(`${SPACE}_files`);
const stored = async () => await files().findOne({ _id: FILE });

/**
 * A file as it lands from the publisher: its authored half, stamped with the publisher's seq — and the space counter
 * raised to that seq, as an ingest does, so this instance's next local stamp sorts above it.
 */
async function peerAuthoredFile(extra = {}) {
  await mongo.col('ythril_counters').updateOne({ _id: SPACE }, { $max: { seq: PEER_STAMP.seq } }, { upsert: true });
  await files().insertOne({
    _id: FILE, spaceId: SPACE, path: FILE, tags: ['onboarding'], author: PEER,
    createdAt: PEER_STAMP.updatedAt, ...PEER_STAMP, sizeBytes: 12, ...extra,
  });
}

describe('a receiver\'s own file writes do not outrank its publisher (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { ...LOCAL, spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('filearrival');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
    wire = await import('../../server/dist/api/sync/_shared.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
  });

  it('none of the fields the file module treats as local travels on the wire', () => {
    // Derived from the ingest schema, so a field that starts replicating cannot stay on the local list unnoticed.
    const wireKeys = Object.keys(wire.IncomingFileMetaDoc.shape);
    assert.ok(wireKeys.length > 5, `the ingest schema declares ${wireKeys.length} keys — nothing is being checked`);
    const local = [...(meta.LOCAL_FILE_FIELDS ?? [])];
    assert.ok(local.length > 0, 'file-meta.ts exports no LOCAL_FILE_FIELDS');
    for (const f of local) assert.ok(!wireKeys.includes(f), `${f} is on the local list and also replicates`);
  });

  it('the excerpt the media worker writes leaves the publisher\'s seq and updatedAt', async () => {
    await peerAuthoredFile();
    await meta.updateFileMeta(SPACE, FILE, { excerpt: 'The opening prose of the guide.' });
    const d = await stored();
    assert.equal(d.excerpt, 'The opening prose of the guide.');
    assert.equal(d.seq, PEER_STAMP.seq, `the excerpt stamped seq ${d.seq}: the publisher's next edit at seq 8 would be skipped`);
    assert.equal(d.updatedAt, PEER_STAMP.updatedAt, 'the excerpt moved updatedAt, which is hashed');
  });

  it('control: an authored edit on the same record still advances seq', async () => {
    await peerAuthoredFile();
    await meta.updateFileMeta(SPACE, FILE, { description: 'Written here by a person' });
    const d = await stored();
    assert.ok(d.seq > PEER_STAMP.seq, `an authored edit left seq at ${d.seq}, so it would never page to a peer`);
    assert.notEqual(d.updatedAt, PEER_STAMP.updatedAt);
  });

  it('bytes arriving for a known file record their size and hash and leave the stamp', async () => {
    assert.equal(typeof meta.recordArrivedFile, 'function', 'file-meta.ts exports no recordArrivedFile');
    await peerAuthoredFile();
    await meta.recordArrivedFile(SPACE, FILE, 40, 'a'.repeat(64), PEER);
    const d = await stored();
    assert.equal(d.sizeBytes, 40);
    assert.equal(d.sha256, 'a'.repeat(64));
    assert.equal(d.seq, PEER_STAMP.seq, `arriving bytes stamped seq ${d.seq}`);
    assert.equal(d.updatedAt, PEER_STAMP.updatedAt);
    assert.deepEqual(d.author, PEER, 'arriving bytes re-authored the file as this instance');
  });

  it('bytes arriving before their metadata create a record any authored metadata outranks', async () => {
    assert.equal(typeof meta.recordArrivedFile, 'function', 'file-meta.ts exports no recordArrivedFile');
    await meta.recordArrivedFile(SPACE, FILE, 40, 'b'.repeat(64), PEER);
    const d = await stored();
    assert.equal(d.seq, 0, `a placeholder at seq ${d.seq} would outrank the publisher's first metadata`);
    assert.deepEqual(d.author, PEER);
    assert.equal(d.sizeBytes, 40);
  });

  it('the file-sync pull records arriving bytes as an arrival, never as an authored upload', () => {
    // The authored writer is still right for an upload, so the arrival path must not reach it — on base it did, and
    // that call is what stamped the receiver's seq.
    const src = stripComments(fs.readFileSync('server/src/sync/file-sync.ts', 'utf8'));
    assert.ok(src.includes('recordArrivedFile('), 'file-sync.ts does not record arriving bytes through recordArrivedFile');
    assert.ok(!src.includes('upsertFileMeta('), 'file-sync.ts writes arriving bytes through upsertFileMeta, the authored-upload writer');
  });

  it('a derived description is not written on a file the publisher authored', async () => {
    await peerAuthoredFile();
    const wrote = await meta.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived here', 'generated');
    const d = await stored();
    assert.equal(wrote, false, 'a receiver derived a description that cannot replicate, and would hash differently');
    assert.equal(d.description, undefined);
    assert.equal(d.seq, PEER_STAMP.seq);
  });

  it('control: a derived description is still written on a file this instance authored', async () => {
    await meta.upsertFileMeta(SPACE, FILE, 12, { tags: ['local'] });
    const before = (await stored()).seq;
    assert.equal(await meta.setDerivedDescriptionIfUnset(SPACE, FILE, 'Derived here', 'generated'), true);
    const d = await stored();
    assert.equal(d.description, 'Derived here');
    assert.ok(d.seq > before, 'the author\'s derived description must page to its peers');
  });
});

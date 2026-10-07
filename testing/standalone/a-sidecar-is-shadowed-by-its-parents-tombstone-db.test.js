/**
 * A sidecar's deletion is its PARENT's: a held tombstone for a file shadows the arrival of that file's `_converted/` and
 * `_extracted/` sidecars — bytes and metadata, at every door — under the same conditions it shadows the file (bundle-71, Q-349).
 *
 * ## The defect
 *
 * A converted file's sidecars are derived rows at the instance that converted it, and derived rows never replicate. A peer
 * that never converted holds them as ORDINARY files: bytes, and a top-level row made by `recordArrivedFile`. When the parent
 * is deleted, the tombstone names the parent only; the sidecar has no tombstone, no version and no author of its own at the
 * receiver. So a peer that still holds the sidecar re-advertises it (the manifest pull downloads it, the upload door stores
 * it, its metadata batch writes the row) and nothing refuses it — the deleted file's text comes back without the file.
 *
 * ## The rule (what a tombstone held for the PARENT does to an arriving sidecar)
 *
 *   A sidecar of `p` — `_converted/<p>.md` and anything under `_extracted/<p>/` — is shadowed exactly when `p` is shadowed
 *   by a tombstone that erased REAL content here, and `p` has not been re-created:
 *
 *   - **erased real content**: the tombstone carries a `contentHash`. One stored for a path nobody held has none, so a peer
 *     cannot block a path's sidecars by sending a tombstone for a path it guessed.
 *   - **not re-created**: no live row at `p` whose bytes hash differs from the tombstone's `contentHash`, and none that is
 *     newer BY THE SAME AUTHOR. A `rowSeq` alone, across authors, is never the test (two instances' counters are not one clock).
 *   - a path that only LOOKS like a sidecar of a held path (a name that merely starts with it) is nobody's sidecar.
 *
 * It is asked at every door a sidecar arrives by — the metadata batch, the pull of the metadata family, the single and the
 * chunked upload of a peer's bytes, the manifest pull — and the answers are the ones the parent's own arrival gets:
 * `200 { tombstoned: true }` and nothing stored at the byte door, no download from the manifest, `filemeta.tombstoned` counted
 * at the batch. A person's upload is never asked.
 *
 * ## Seen red
 *
 * On the base nothing refuses a sidecar (a tombstone is read by the sidecar's own path only), so every "shadowed" row below
 * is stored. The "admitted" rows state what the rule must still allow, and are green on the base.
 *
 * Run: node --test testing/standalone/a-sidecar-is-shadowed-by-its-parents-tombstone-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor, USER_TOKEN } from './_byte-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'scsh';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const HELD_AT = '2026-09-01T00:00:05.000Z';
/** What the deleted parents held, and what a re-created one holds. */
const ERASED = 'the content the owner deleted';
const RECREATED = 'a different file written at the same path later';

let door, bytes, cascade, LOCAL;

const row = (id) => door.coll(S, 'files').findOne({ _id: id });
const tombstoneFor = (p, { rowSeq, contentHash, issuer } = {}) => door.coll(S, 'file_tombstones').insertOne({
  _id: `held-${p}`, spaceId: S, path: p, deletedAt: HELD_AT, positionAt: HELD_AT,
  ...(rowSeq !== undefined ? { rowSeq } : {}), ...(contentHash !== undefined ? { contentHash } : {}), ...(issuer !== undefined ? { issuer } : {}),
});
/** A live parent here: its row and its bytes, agreeing with each other. */
async function liveParent(p, content, seq, author) {
  door.writeLocalFile(S, p, content);
  await door.coll(S, 'files').insertOne(build.filemeta(S, p, seq, { author, sizeBytes: content.length, sha256: sha(content) }));
}

/** The two sidecar paths a parent has: its converted Markdown and an extracted image. */
const sidecarsOf = (p) => [`_converted/${p}.md`, `_extracted/${p}/x.jpg`];

/**
 * Every parent the rule is asked about, with the state it is in and whether its sidecars must be refused. Each parent has a
 * path of its own, so one delivery answers every row and a verdict that leaked from one to the next fails a row it did not name.
 * `doors: 'bytes'` rows are about a deletion this instance made itself (its tombstone is issued by itself, which the metadata
 * door reads through the record rule and the bytes door does not read at all).
 */
const SCENARIOS = [
  { parent: 'docs/s-erased.txt', shadowed: true, note: 'a tombstone that erased real content (rowSeq, contentHash), no live parent',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); } },
  { parent: 'docs/s-deleted-here.txt', shadowed: true, doors: 'bytes', note: 'this instance deleted the parent itself (a real local delete)',
    async set(p) { await liveParent(p, ERASED, 5, LOCAL); await cascade.deleteFileCascade(S, p); } },
  { parent: 'docs/s-recreated-other-bytes.txt', shadowed: false, note: 'the parent was re-created with different bytes: a live row whose hash differs',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, RECREATED, 6, PEER_AUTHOR); } },
  { parent: 'docs/s-recreated-same-author.txt', shadowed: false, note: 'the parent was re-created by the same author at a newer version, even with the same bytes',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, ERASED, 20, PEER_AUTHOR); } },
  { parent: 'docs/s-newer-other-author.txt', shadowed: true, note: 'a live row at a higher seq by ANOTHER author with the erased bytes: rowSeq alone across authors is not the test',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, ERASED, 99, LOCAL); } },
  { parent: 'docs/s-guessed.txt', shadowed: false, note: 'a tombstone for a path nobody held (no contentHash), at a very high version',
    async set(p) { await tombstoneFor(p, { rowSeq: 1_000_000, issuer: PEER }); } },
  { parent: 'docs/s-never-deleted.txt', shadowed: false, note: 'no tombstone for the parent at all', async set() { /* none */ } },
  { parent: 'docs/s-erased.txtx', shadowed: false, note: 'a name that merely starts with a deleted parent\'s (no tombstone of its own)', async set() { /* none */ } },
];

/** The sidecars each scenario's rule is asked about at a door: the metadata doors carry only the rows about whom the door's reading is defined. */
const askedAt = (kind) => SCENARIOS.filter(s => kind === 'bytes' || s.doors !== 'bytes');
const allSidecars = (list) => list.flatMap(s => sidecarsOf(s.parent).map(id => ({ id, scenario: s })));

const meta = (id) => build.filemeta(S, id, 1, { author: PEER_AUTHOR });

describe('a held tombstone shadows its parent\'s sidecars at every arrival', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'sidecarshadow', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    cascade = await import('../../server/dist/files/delete-cascade.js');
    LOCAL = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.coll(S, 'filemeta').deleteMany({});
    for (const s of SCENARIOS) await s.set(s.parent);
  });

  it('the scenarios are in place: each held tombstone is there, and the table has both kinds of row (the fixture reached its states)', async () => {
    const held = (await door.coll(S, 'file_tombstones').find({}).toArray()).map(t => t.path).sort();
    assert.deepEqual(held, SCENARIOS.filter(s => !['docs/s-never-deleted.txt', 'docs/s-erased.txtx'].includes(s.parent)).map(s => s.parent).sort(),
      'a scenario did not leave its tombstone');
    assert.ok(SCENARIOS.filter(s => s.shadowed).length >= 3 && SCENARIOS.filter(s => !s.shadowed).length >= 4, 'the table shrank to one kind of row');
  });

  /** Check one door's outcome against the table: the ids it must have stored, and the ids it must have refused. */
  function verdict(rows, stored) {
    const wrong = [];
    for (const { id, scenario } of rows) {
      const got = stored.has(id);
      if (got === scenario.shadowed) {
        wrong.push(`${id} (${scenario.note}): ${got ? 'STORED' : 'refused'}, want ${scenario.shadowed ? 'refused' : 'stored'}`);
      }
    }
    return wrong;
  }

  describe('arriving metadata', () => {
    const DOORS = {
      push: { async deliver(docs) { return door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) }); } },
      pull: { async deliver(docs) { door.state.records[S] = { filemeta: docs }; await door.sync(); return undefined; } },
    };
    for (const [name, d] of Object.entries(DOORS)) {
      it(`${name}: a sidecar of a parent a tombstone erased is refused; any other is stored`, async () => {
        const rows = allSidecars(askedAt('meta'));
        const answer = await d.deliver(rows.map(r => meta(r.id)));
        const stored = new Set();
        for (const r of rows) if ((await row(r.id)) !== null) stored.add(r.id);
        assert.deepEqual(verdict(rows, stored), [], 'what a door stored (or refused) against the rule — every row is one sidecar');
        if (name === 'push') {
          assert.equal(answer.body.filemeta.tombstoned, rows.filter(r => r.scenario.shadowed).length,
            `the batch answer does not count the shadowed sidecars: ${JSON.stringify(answer.body.filemeta)}`);
        }
      });
    }
  });

  describe('arriving bytes', () => {
    const asPeer = (p, content) => bytes.post({ space: S, path: p, bytes: Buffer.from(content), token: peerToken(PEER) });
    const chunkedAsPeer = async (p, content) => {
      const b = Buffer.from(content);
      const mid = Math.floor(b.length / 2);
      const first = await bytes.post({ space: S, path: p, bytes: b.subarray(0, mid), token: peerToken(PEER), range: `bytes 0-${mid - 1}/${b.length}` });
      const last = await bytes.post({ space: S, path: p, bytes: b.subarray(mid), token: peerToken(PEER), range: `bytes ${mid}-${b.length - 1}/${b.length}` });
      return { first, last };
    };
    /** Whether the door answered "stored" or "tombstoned", and checks that its answer is the one the parent's own arrival gets. */
    const stored = (res, p) => {
      const tomb = res.code === 200 && res.body?.tombstoned === true;
      const ok = [201, 202].includes(res.code) && res.body?.tombstoned === undefined;
      assert.ok(tomb || ok, `${p}: the byte door answered neither "stored" nor 200 { tombstoned: true }: ${JSON.stringify(res)}`);
      return ok;
    };

    it('a PEER\'s single upload of a sidecar of an erased parent is answered 200 { tombstoned: true } and stores nothing', async () => {
      const wrong = [];
      for (const { id, scenario } of allSidecars(askedAt('bytes'))) {
        const res = await asPeer(id, `sidecar text of ${id}`);
        const gotStored = stored(res, id);
        if (gotStored === scenario.shadowed) wrong.push(`${id} (${scenario.note}): ${gotStored ? 'STORED' : 'tombstoned'}, want ${scenario.shadowed ? 'tombstoned' : 'stored'}`);
        if (!gotStored && (door.localFileExists(S, id) || (await row(id)) !== null)) wrong.push(`${id}: answered tombstoned but left bytes or a row`);
      }
      assert.deepEqual(wrong, []);
    });

    it('a PEER\'s chunked upload of a sidecar of an erased parent is answered 200 { tombstoned: true } at assembly and stores nothing', async () => {
      const wrong = [];
      for (const { id, scenario } of allSidecars(askedAt('bytes'))) {
        const { first, last } = await chunkedAsPeer(id, `sidecar text of ${id}, long enough to split in two`);
        assert.equal(first.code, 202, `${id}: the first chunk: ${JSON.stringify(first)}`);
        const gotStored = stored(last, id);
        if (gotStored === scenario.shadowed) wrong.push(`${id} (${scenario.note}): ${gotStored ? 'STORED' : 'tombstoned'}, want ${scenario.shadowed ? 'tombstoned' : 'stored'}`);
        if (!gotStored && (door.localFileExists(S, id) || (await row(id)) !== null)) wrong.push(`${id}: answered tombstoned but left bytes or a row`);
      }
      assert.deepEqual(wrong, []);
    });

    it('a PERSON\'s upload to a sidecar path of an erased parent always stores: only a peer\'s arrival is asked', async () => {
      const id = sidecarsOf('docs/s-erased.txt')[0];
      const res = await bytes.post({ space: S, path: id, bytes: Buffer.from('a person put this here'), token: USER_TOKEN });
      assert.ok([201, 202].includes(res.code) && res.body?.tombstoned === undefined, `a person's upload was refused: ${JSON.stringify(res)}`);
      assert.ok(door.localFileExists(S, id) && (await row(id)) !== null);
    });
  });

  describe('the manifest pull', () => {
    it('does not download a sidecar of an erased parent, and downloads every other', async () => {
      const rows = allSidecars(askedAt('bytes'));
      for (const { id } of rows) door.seedPeerFile(S, id, `sidecar text of ${id}`);
      await door.sync();
      const downloaded = new Set(door.state.fileDownloads.map(x => x.path));
      const gotStored = new Set(rows.filter(r => door.localFileExists(S, r.id)).map(r => r.id));
      assert.deepEqual(verdict(rows, gotStored), [], 'what the manifest pull stored (or skipped) against the rule');
      for (const { id, scenario } of rows) {
        if (scenario.shadowed) assert.ok(!downloaded.has(id), `${id}: a sidecar of an erased parent was fetched on every cycle`);
      }
    });
  });
});

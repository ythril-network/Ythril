/**
 * A sidecar's fate is its PARENT's, and since bundle-48 no peer's sidecar arrives to be shadowed: a conversion's `_converted/`
 * and `_extracted/` trees are INSTANCE-LOCAL, so a peer's offer of one is ignored at every door whatever state its parent is in
 * (bundle-71 Q-349 wrote this file as "a held tombstone shadows the arrival of the parent's sidecars"; bundle-48 D1 moved the
 * answer from "refused when the parent was erased" to "never taken").
 *
 * ## The defect it began with, and where it ends now
 *
 * A converted file's sidecars are derived rows at the instance that converted it. A peer that never converted held them as
 * ORDINARY files: bytes, and a top-level row made by `recordArrivedFile`. When the parent was deleted the tombstone named the
 * parent only, so a peer that still held the sidecar re-advertised it at every door and nothing refused it — the deleted file's
 * text came back without the file. The first answer was to ask the parent's tombstone at each door. The second, which is this
 * one, removes the question: a sidecar is each instance's own derivation of the file by its own configuration (the receiver
 * applies its rules), so none travels, none is taken, and a deleted file's text cannot come back from a peer because no peer
 * can deliver it. A receiver whose conversion is off holds no derived text at all.
 *
 * ## The rule (what an arriving sidecar meets)
 *
 *   An offer of a path under `_converted/` or `_extracted/` AT THE ROOT (`isInDerivedTree`; `a/_converted/x` is a user's file) by a
 *   PEER is ignored — in the state of its parent too: erased by a peer's tombstone, deleted here, re-created, never deleted,
 *   a tombstone nobody earned, a name that merely starts with a deleted parent's:
 *
 *   - the byte door (single and chunked): `200 { ignored: 'instance-local' }`, before the body is looked at; nothing stored, no row,
 *     and counted `ythril_sync_file_arrivals_total{door="push",outcome="ignored_instance_local"}`; an older sender reads the 200 and
 *     records a base instead of retrying for ever
 *   - the metadata batch and the pull of the metadata family: no row is written
 *   - the manifest pull: the sidecar is not downloaded, and the files beside it still are
 *   - a PERSON's upload to a sidecar path is never asked (an operator may put a file there; it is theirs)
 *
 * ## What a LOCAL sidecar keeps
 *
 * The sidecar this instance's own pipeline wrote is a derived row beside its bytes. A peer's differing offer at the same path,
 * at any door, replaces nothing and leaves no conflict copy beside it; and when the file is deleted here the cascade takes the
 * local sidecars with it (`a-file-delete-removes-what-its-conversion-and-its-peers-left-db`), so after the delete there is
 * nothing for a peer to bring back and nothing a peer's offer can store.
 *
 * ## Seen red
 *
 * On the base (a sidecar is an ordinary file) every "ignored" row below is stored, or is refused only where a tombstone said so.
 * The controls state what must still happen — a peer's non-sidecar file is stored, a person's upload to a sidecar path is stored —
 * so a door that ignores everything fails them.
 *
 * Run: node --test testing/standalone/a-sidecar-is-shadowed-by-its-parents-tombstone-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
const MINE = 'the text THIS instance\'s own conversion derived';
const THEIRS = 'a conversion by another instance, by its own configuration';

let door, bytes, cascade, metrics, LOCAL;

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
/** A sidecar of `parent` as THIS instance's own conversion writes it: the bytes, and a derived row pointing at the parent. */
async function localSidecar(id, parent, text = MINE) {
  door.writeLocalFile(S, id, text);
  await door.coll(S, 'files').insertOne(build.filemeta(S, id, 4, { author: LOCAL, parentFileId: parent, sizeBytes: text.length }));
}
const onDisk = (id) => (door.localFileExists(S, id) ? fs.readFileSync(path.join(door.localFilesRoot(S), id), 'utf8') : null);
/** Every file under the space's root that is a sidecar-tree path or a conflict copy: what a stray store would leave. */
function derivedTreeFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (/^(_converted|_extracted)\//.test(r) || /conflict/i.test(r)) out.push(r);
    }
  };
  walk(door.localFilesRoot(S), '');
  return out.sort();
}

/** The two sidecar paths a parent has: its converted Markdown and an extracted image. */
const sidecarsOf = (p) => [`_converted/${p}.md`, `_extracted/${p}/x.jpg`];

/**
 * Every parent the offer is made about, with the state the parent is in. Each parent has a path of its own, so one delivery
 * answers every row and a verdict that leaked from one to the next fails a row it did not name. The rule does not read
 * the state any more, which is what the table is here to show: every row is ignored. `live` marks the parents that have a row and
 * bytes here, whose sidecars the local-sidecar cases seed.
 */
const SCENARIOS = [
  { parent: 'docs/s-erased.txt', state: 'erased', note: 'a tombstone that erased real content (rowSeq, contentHash), no live parent',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); } },
  { parent: 'docs/s-deleted-here.txt', state: 'erased', note: 'this instance deleted the parent itself (a real local delete)',
    async set(p) { await liveParent(p, ERASED, 5, LOCAL); await cascade.deleteFileCascade(S, p); } },
  { parent: 'docs/s-recreated-other-bytes.txt', state: 'live', note: 'the parent was re-created with different bytes: a live row whose hash differs',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, RECREATED, 6, PEER_AUTHOR); } },
  { parent: 'docs/s-recreated-same-author.txt', state: 'live', note: 'the parent was re-created by the same author at a newer version, even with the same bytes',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, ERASED, 20, PEER_AUTHOR); } },
  { parent: 'docs/s-newer-other-author.txt', state: 'live', note: 'a live row at a higher seq by ANOTHER author with the erased bytes',
    async set(p) { await tombstoneFor(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER }); await liveParent(p, ERASED, 99, LOCAL); } },
  { parent: 'docs/s-guessed.txt', state: 'none', note: 'a tombstone for a path nobody held (no contentHash), at a very high version',
    async set(p) { await tombstoneFor(p, { rowSeq: 1_000_000, issuer: PEER }); } },
  { parent: 'docs/s-never-deleted.txt', state: 'none', note: 'no tombstone for the parent at all', async set() { /* none */ } },
  { parent: 'docs/s-erased.txtx', state: 'none', note: 'a name that merely starts with a deleted parent\'s (no tombstone of its own)', async set() { /* none */ } },
];
/** Parents nobody erased and nobody holds: their OWN files are ordinary, and are the controls a pull must still fetch. */
const PLAIN_PARENTS = ['docs/s-never-deleted.txt', 'docs/s-erased.txtx'];
/** A path that only a peer offers and that is NOT a sidecar: the control every door must still take. */
const CONTROL = 'docs/s-control.txt';

const allSidecars = (list = SCENARIOS) => list.flatMap(s => sidecarsOf(s.parent).map(id => ({ id, scenario: s })));
const meta = (id) => build.filemeta(S, id, 1, { author: PEER_AUTHOR });

/** What `ythril_sync_file_arrivals_total{<door>, ignored_instance_local}` has counted so far: one counter for every door. */
async function ignoredCount(door = 'push') {
  const { values } = await metrics.syncFileArrivalsTotal.get();
  return values.find(v => v.labels.door === door && v.labels.outcome === 'ignored_instance_local')?.value ?? 0;
}

describe('a peer\'s sidecar is ignored at every door, and a local one is left alone', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'sidecarshadow', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
    cascade = await import('../../server/dist/files/delete-cascade.js');
    metrics = await import('../../server/dist/metrics/registry.js');
    LOCAL = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    await door.coll(S, 'filemeta').deleteMany({});
    for (const s of SCENARIOS) await s.set(s.parent);
  });

  const asPeer = (p, content) => bytes.post({ space: S, path: p, bytes: Buffer.from(content), token: peerToken(PEER) });
  const chunkedAsPeer = async (p, content) => {
    const b = Buffer.from(content);
    const mid = Math.floor(b.length / 2);
    const first = await bytes.post({ space: S, path: p, bytes: b.subarray(0, mid), token: peerToken(PEER), range: `bytes 0-${mid - 1}/${b.length}` });
    const last = await bytes.post({ space: S, path: p, bytes: b.subarray(mid), token: peerToken(PEER), range: `bytes ${mid}-${b.length - 1}/${b.length}` });
    return { first, last };
  };
  const pushMeta = (ids) => door.push('/batch-upsert', { filemeta: ids.map(meta) }, { spaceId: S, token: peerToken(PEER) });
  const pullMeta = async (ids) => { door.state.records[S] = { filemeta: ids.map(meta) }; await door.sync(); };

  it('the scenarios are in place: each held tombstone is there, and the table has every kind of parent (the fixture reached its states)', async () => {
    const held = (await door.coll(S, 'file_tombstones').find({}).toArray()).map(t => t.path).sort();
    assert.deepEqual(held, SCENARIOS.filter(s => !PLAIN_PARENTS.includes(s.parent)).map(s => s.parent).sort(),
      'a scenario did not leave its tombstone');
    assert.ok((await row('docs/s-recreated-other-bytes.txt')) && door.localFileExists(S, 'docs/s-recreated-same-author.txt'), 'a re-created parent is not live here');
    assert.ok(!door.localFileExists(S, 'docs/s-deleted-here.txt'), 'the locally deleted parent is still on disk');
    for (const state of ['erased', 'live', 'none']) assert.ok(SCENARIOS.some(s => s.state === state), `the table has no ${state} parent: the rule would be asked about one kind`);
  });

  describe('arriving metadata', () => {
    for (const [name, deliver] of [['push', pushMeta], ['pull', pullMeta]]) {
      it(`${name}: a sidecar row is never written, whatever its parent's state; a row beside it still is`, async () => {
        const rows = allSidecars();
        const counted = await ignoredCount('metadata');
        const answer = await deliver([...rows.map(r => r.id), CONTROL]);
        // The same recorder the byte door counts through, with its own door label: an ignored row is counted, never silent.
        assert.ok(await ignoredCount('metadata') - counted >= rows.length,
          'every ignored sidecar row is counted on ythril_sync_file_arrivals_total{door="metadata",outcome="ignored_instance_local"}');
        const stored = [];
        for (const r of rows) if ((await row(r.id)) !== null) stored.push(`${r.id} (${r.scenario.note})`);
        assert.deepEqual(stored, [], 'sidecar rows a metadata door STORED: a peer\'s sidecar row is another instance\'s derivation and is nobody\'s to keep');
        assert.ok(await row(CONTROL), 'the control row was not stored either: the door ignores everything, so the cases above prove nothing');
        if (name === 'push') {
          // Ignored rows are skipped (the writer's `derived`), not tombstoned: no held tombstone is consulted, whatever the state.
          assert.deepEqual(answer.body.filemeta, { upserted: 1, skipped: rows.length, rejected: 0 },
            `the batch answer counts the control as stored and every sidecar as skipped, none as tombstoned: ${JSON.stringify(answer.body.filemeta)}`);
        }
      });
    }
  });

  describe('an arriving file tombstone', () => {
    it('for a sidecar is ignored (not applied, not stored) and counted on the one arrival counter, with its own door label', async () => {
      const rows = allSidecars();
      const counted = await ignoredCount('tombstone');
      const tombstones = rows.map(({ id }, i) => ({
        _id: `ft-${id}`, spaceId: S, path: id, deletedAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, issuer: PEER, rowSeq: 3,
      }));
      const answer = await door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) });
      assert.ok(answer.code === 200 || answer.code === 201, `the tombstone push was refused: ${JSON.stringify(answer)}`);
      assert.equal(await ignoredCount('tombstone') - counted, rows.length, 'every ignored tombstone is counted once on ythril_sync_file_arrivals_total{door="tombstone"}');
      for (const { id } of rows) assert.equal(await door.coll(S, 'file_tombstones').findOne({ path: id, _id: `ft-${id}` }), null, `${id}: a tombstone for a sidecar was stored`);
    });
  });

  describe('arriving bytes', () => {
    it('a PEER\'s single upload of a sidecar is answered 200 { ignored: instance-local }, counted, and stores nothing', async () => {
      const counted = await ignoredCount();
      const wrong = [];
      const rows = allSidecars();
      for (const { id, scenario } of rows) {
        const res = await asPeer(id, `sidecar text of ${id}`);
        if (res.code !== 200 || res.body?.ignored !== 'instance-local') wrong.push(`${id} (${scenario.note}): ${JSON.stringify(res)}`);
        if (door.localFileExists(S, id) || (await row(id)) !== null) wrong.push(`${id}: answered ignored but left bytes or a row`);
      }
      assert.deepEqual(wrong, []);
      assert.equal(await ignoredCount() - counted, rows.length, 'every ignored offer is counted once on ythril_sync_file_arrivals_total');
    });

    it('a PEER\'s chunked upload of a sidecar is answered 200 { ignored: instance-local } at the first chunk and stages and stores nothing', async () => {
      const wrong = [];
      for (const { id, scenario } of allSidecars()) {
        const { first } = await chunkedAsPeer(id, `sidecar text of ${id}, long enough to split in two`);
        if (first.code !== 200 || first.body?.ignored !== 'instance-local') wrong.push(`${id} (${scenario.note}): the first chunk answered ${JSON.stringify(first)}`);
        if (door.localFileExists(S, id) || (await row(id)) !== null) wrong.push(`${id}: answered ignored but left bytes or a row`);
      }
      assert.deepEqual(wrong, []);
    });

    it('controls: a PEER\'s single and chunked upload of a file that is not a sidecar is stored (the door is not closed to everything)', async () => {
      const single = await asPeer('docs/s-control.txt', 'an ordinary file');
      assert.ok([201, 202].includes(single.code) && single.body?.ignored === undefined, `a peer's ordinary upload was refused: ${JSON.stringify(single)}`);
      // `a/_converted/x` is a user's file, not the ROOT tree a conversion writes to.
      const nested = await asPeer('a/_converted/x.md', 'a user keeps files under any name');
      assert.ok([201, 202].includes(nested.code) && nested.body?.ignored === undefined, `a file under \`a/_converted\` was ignored as a sidecar: ${JSON.stringify(nested)}`);
      const { first, last } = await chunkedAsPeer('docs/s-control-chunked.txt', 'an ordinary file, long enough to split in two');
      assert.equal(first.code, 202, JSON.stringify(first));
      assert.ok([201, 202].includes(last.code) && last.body?.ignored === undefined, JSON.stringify(last));
      assert.ok(door.localFileExists(S, 'docs/s-control.txt') && door.localFileExists(S, 'a/_converted/x.md') && door.localFileExists(S, 'docs/s-control-chunked.txt'));
    });

    it('a PERSON\'s upload to a sidecar path always stores: only a peer\'s arrival is asked', async () => {
      const id = sidecarsOf('docs/s-erased.txt')[0];
      const res = await bytes.post({ space: S, path: id, bytes: Buffer.from('a person put this here'), token: USER_TOKEN });
      assert.ok([201, 202].includes(res.code) && res.body?.ignored === undefined, `a person's upload was ignored: ${JSON.stringify(res)}`);
      assert.ok(door.localFileExists(S, id) && (await row(id)) !== null);
    });
  });

  describe('the manifest pull', () => {
    it('does not download a sidecar, whatever its parent\'s state, and still downloads the files beside it', async () => {
      const rows = allSidecars();
      for (const { id } of rows) door.seedPeerFile(S, id, `sidecar text of ${id}`);
      for (const p of PLAIN_PARENTS) door.seedPeerFile(S, p, `content of ${p}`);
      await door.sync();
      const downloaded = new Set(door.state.fileDownloads.map(x => x.path));
      const fetched = rows.filter(r => downloaded.has(r.id) || door.localFileExists(S, r.id)).map(r => `${r.id} (${r.scenario.note})`);
      assert.deepEqual(fetched, [], 'sidecars the manifest pull downloaded or stored: each instance derives its own');
      for (const p of PLAIN_PARENTS) {
        assert.ok(downloaded.has(p) && door.localFileExists(S, p), `${p} (a neighbour, not a sidecar) was not pulled: the pull skips everything`);
      }
    });
  });

  describe('a LOCAL sidecar', () => {
    /** The parents whose own file is live here: the sidecars this instance's conversion would have written for them. */
    const LIVE = SCENARIOS.filter(s => s.state === 'live');

    it('is not replaced, overwritten or copied beside by a peer\'s different version at any door', async () => {
      const mine = [];
      for (const s of LIVE) for (const id of sidecarsOf(s.parent)) { await localSidecar(id, s.parent); mine.push({ id, parent: s.parent }); }
      const before = derivedTreeFiles();
      assert.equal(before.length, mine.length, 'fixture: the local sidecars are not all on disk');
      const rows = mine.map(m => ({ id: m.id }));
      await pushMeta(rows.map(r => r.id));
      for (const { id } of rows) { await asPeer(id, THEIRS); await chunkedAsPeer(id, `${THEIRS}, long enough to split in two`); }
      for (const { id } of rows) door.seedPeerFile(S, id, THEIRS);
      await pullMeta(rows.map(r => r.id));   // the metadata family and, in the same cycle, the manifest
      const wrong = [];
      for (const m of mine) {
        if (onDisk(m.id) !== MINE) wrong.push(`${m.id}: the bytes are now ${JSON.stringify(onDisk(m.id))}`);
        const r = await row(m.id);
        if (!r || r.parentFileId !== m.parent || r.author?.instanceId !== LOCAL.instanceId) wrong.push(`${m.id}: the local derived row became ${JSON.stringify(r)}`);
      }
      assert.deepEqual(wrong, [], 'a peer\'s offer changed a sidecar this instance\'s own conversion wrote');
      assert.deepEqual(derivedTreeFiles(), before, 'a peer\'s offer left a file (a conflict copy, a second sidecar) beside this instance\'s own');
    });

    it('goes with its parent when the file is deleted here, so nothing is left for a peer to bring back, and no door brings it', async () => {
      const p = 'docs/s-deleted-with-sidecars.txt';
      await liveParent(p, ERASED, 5, LOCAL);
      const sidecars = sidecarsOf(p);
      for (const id of sidecars) await localSidecar(id, p);
      assert.equal(derivedTreeFiles().filter(f => sidecars.includes(f)).length, sidecars.length, 'fixture: the sidecars are not there before the delete');
      await cascade.deleteFileCascade(S, p);
      for (const id of sidecars) assert.ok(!door.localFileExists(S, id) && (await row(id)) === null, `${id} survived its parent's delete`);
      // The peer still holds them and offers them at every door.
      for (const id of sidecars) door.seedPeerFile(S, id, THEIRS);
      await pushMeta(sidecars);
      for (const id of sidecars) { await asPeer(id, THEIRS); await chunkedAsPeer(id, `${THEIRS}, long enough to split in two`); }
      await pullMeta(sidecars);
      for (const id of sidecars) {
        assert.ok(!door.localFileExists(S, id) && (await row(id)) === null, `${id}: the deleted file's text came back through a door without the file`);
      }
    });
  });
});

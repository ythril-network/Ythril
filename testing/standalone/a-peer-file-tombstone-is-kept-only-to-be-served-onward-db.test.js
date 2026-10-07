/**
 * A peer's file tombstone is KEPT only so that it can be served onward — and a tombstone already held is never applied
 * twice (bundle-51 Q-242, Q-229's loop).
 *
 * ## What a stored file tombstone is for, and what storing it costs
 *
 * `<space>_file_tombstones` exists so a deletion travels: this instance stores a tombstone it applied and serves it to the
 * members it carries the space to, so they delete their copy too (a pub/sub middle node, a braintree node, a club).
 * A file tombstone's `path` is often personal in itself, so every stored one keeps the deleted file's NAME. That is the price
 * of relaying, and it is paid only where there is someone to relay to:
 *
 *  1. **A leaf applies and keeps nothing.** An instance that serves the space to no other member removes the file and does
 *     not retain its path (privacy: the name of a deleted file is not kept where nothing needs it).
 *  2. **Where the space is served onward, the tombstone is stored once**, retagged to the space the door admitted (never the
 *     tombstone's own `spaceId`), with the ISSUER kept: a relayed tombstone keeps who deleted the file, so the next hop judges
 *     it as the original issuer's. An issuer-less one (an older peer's) is stored with its DELIVERER as issuer, so attribution
 *     starts at the first hop that has any.
 *  3. **A stored tombstone is positioned by THIS instance's clock** (`positionAt`): the receive time, not the sender's
 *     `deletedAt` — a relayed deletion from long ago is not pruned before it was ever served, and a foreign clock never
 *     enters a local position. And the wire shape served onward carries `issuer`, never the local fields.
 *  4. **An id already held is a no-op.** The pull re-reads every tombstone every cycle; one already held is not applied again
 *     and not counted again. Applied again, it deleted the file a peer had since re-created, which the next manifest pull
 *     downloaded, which the next tombstone read deleted: a loop that ran for as long as the tombstone was held.
 *
 * Each is held on the push door and the pull door.
 *
 * Run: node --test testing/standalone/a-peer-file-tombstone-is-kept-only-to-be-served-onward-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftkeep';
const THIRD = 'third-party-author';

let door, register;

const tombs = () => door.coll(S, 'file_tombstones').find({}).toArray();
const tombOf = (path) => door.coll(S, 'file_tombstones').findOne({ path });
const row = (id) => door.coll(S, 'files').findOne({ _id: id });
async function seedFile(path, author = PEER_AUTHOR, seq = 3, extra = {}) {
  door.writeLocalFile(S, path, `bytes of ${path}`);
  await door.coll(S, 'files').insertOne(build.filemeta(S, path, seq, { author, sizeBytes: 11, ...extra }));
}
const tomb = (path, extra = {}) => ({ _id: `ft-${path}`, spaceId: S, path, deletedAt: '2026-09-01T00:00:05.000Z', issuer: PEER, rowSeq: 3, ...extra });

const DOORS = {
  push: {
    async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(PEER) }); },
    /** The same tombstones again: the sender re-sends them. */
    async again(tombstones) { return this.deliver(tombstones); },
  },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
    /** The peer still holds them, and the pull reads every one of them every cycle. */
    async again() { return door.sync(); },
  },
};

/** The applied counter, summed over every series that names a file; `null` when the metric is not registered. */
async function appliedFiles() {
  const m = (await register.getMetricsAsJSON()).find(x => x.name === 'ythril_sync_tombstones_applied_total');
  return m ? m.values.filter(v => /file/.test(String(v.labels.kind ?? ''))).reduce((a, v) => a + v.value, 0) : null;
}

describe('a peer file tombstone is kept only to be served onward', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftkeeps', spaces: [S], files: true });
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(`${name} door`, () => {
      it('a leaf (the space is served to no other member) removes the file and keeps no tombstone', async () => {
        await seedFile('leaf.txt');
        await d.deliver([tomb('leaf.txt')]);
        assert.equal(await row('leaf.txt'), null, 'fixture: the file was not removed, so the rule is not reached');
        assert.deepEqual((await tombs()).map(t => t.path), [],
          'a leaf retained the NAME of a file it deleted, though it serves the space to nobody');
      });

      it('where the space is served onward the tombstone is stored once, retagged to the admitted space, with its issuer', async () => {
        door.configure({ lateral: true });
        await seedFile('onward.txt');
        await d.deliver([tomb('onward.txt', { spaceId: 'a-space-the-sender-named' })]);
        assert.equal(await row('onward.txt'), null, 'fixture: the file was not removed');
        const all = await tombs();
        assert.deepEqual(all.map(t => [t._id, t.path, t.spaceId, t.issuer]), [['ft-onward.txt', 'onward.txt', S, PEER]],
          'the tombstone is not stored exactly once, in the admitted space, with the issuer that signed the deletion');
      });

      it('a relayed tombstone keeps its ORIGINAL issuer; an issuer-less one is stored with its deliverer as issuer', async () => {
        door.configure({ lateral: true });
        // The peer is the upstream here, and delivered both files: the first deletion was issued by a third instance.
        await seedFile('relayed.txt', { instanceId: THIRD, instanceLabel: THIRD }, 3, { deliveredBy: PEER });
        await seedFile('older-peer.txt');
        const issuerless = tomb('older-peer.txt', { _id: 'ft-issuerless' });
        delete issuerless.issuer;
        await d.deliver([tomb('relayed.txt', { issuer: THIRD }), issuerless]);
        assert.equal(await row('older-peer.txt'), null, 'an issuer-less tombstone from the file\'s own author was not applied');
        assert.equal((await tombOf('relayed.txt'))?.issuer, THIRD, 'the original issuer was replaced by the relaying peer');
        assert.equal((await tombOf('older-peer.txt'))?.issuer, PEER,
          'an issuer-less tombstone was stored with no attribution, so the next hop cannot tell who deleted the file');
      });

      it('the stored tombstone is positioned by THIS instance\'s clock, not the sender\'s', async () => {
        door.configure({ lateral: true });
        await seedFile('old.txt');
        const startedAt = new Date().toISOString();
        await d.deliver([tomb('old.txt', { deletedAt: '2020-01-01T00:00:00.000Z' })]);
        const t = await tombOf('old.txt');
        assert.ok(t, 'fixture: the tombstone was not stored');
        assert.equal(typeof t.positionAt, 'string', 'a stored relayed tombstone has no local position');
        assert.ok(t.positionAt >= startedAt,
          `positionAt ${t.positionAt} is not this instance's receive time (>= ${startedAt}): a relayed deletion with an old deletedAt is pruned before it is served`);
      });

      it('what is served onward carries the issuer and none of the local fields', async () => {
        door.configure({ lateral: true });
        await seedFile('served.txt');
        await d.deliver([tomb('served.txt')]);
        const served = (await door.pull('/file-tombstones', { spaceId: S })).tombstones;
        const t = served.find(x => x.path === 'served.txt');
        assert.ok(t, 'the stored tombstone is not served to the members this instance carries the space to');
        assert.equal(t.issuer, PEER);
        assert.deepEqual(Object.keys(t).filter(k => ['positionAt', 'storedVia', 'contentHash', 'pending', 'move'].includes(k)), [],
          'a local field is on the wire');
      });

      it('a tombstone already held is a no-op: the file a peer re-created since is NOT deleted again, and nothing is counted twice', async () => {
        door.configure({ lateral: true });
        await seedFile('loop.txt');
        await d.deliver([tomb('loop.txt')]);
        assert.equal(await row('loop.txt'), null, 'fixture: the first delivery did not apply');
        assert.ok(await tombOf('loop.txt'), 'fixture: the tombstone was not stored, so "already held" is not reached');
        // The peer re-created the file: a row at the same seq the tombstone erased (so only the held id can save it) and its bytes.
        await seedFile('loop.txt');
        const before = await appliedFiles();
        await d.again([tomb('loop.txt')]);
        assert.ok(await row('loop.txt'), 'the held tombstone was applied a second time and deleted the re-created file');
        assert.ok(door.localFileExists(S, 'loop.txt'), 'the held tombstone removed the re-created bytes');
        if (before !== null) assert.equal(await appliedFiles(), before, 'an id already held was counted as applied again');
        assert.equal((await tombs()).filter(t => t.path === 'loop.txt').length, 1, 'the held tombstone was stored again');
      });
    });
  }
});

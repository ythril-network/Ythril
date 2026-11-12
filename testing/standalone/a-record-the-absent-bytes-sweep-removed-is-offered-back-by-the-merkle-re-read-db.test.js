/**
 * A file record the absent-bytes sweep removed HERE, which a peer still holds live, is offered back by the merkle re-read and lands live again
 * (bundle-70, ADR 21: "a record no peer holds bytes for may be offered back by the Merkle re-read, wait again and be removed again").
 *
 * ## What it prevents
 *
 * The sweep's removal is a feed marker carrying `retiredBy: 'bytes-lost'` and no tombstone, so nothing travels: the peer keeps its row. When no
 * peer has the bytes either, the file manifests agree, and the ONLY difference between the two instances is the row itself. The merkle check sees
 * it and arms the file-row re-read; the re-read delivers the peer's row, the accept admits it (no tombstone shadows it, and a marker has no `seq`
 * to lose to), and the merge must then make the row LIVE. It merged the peer's keys INTO the marker instead: the row kept `feedMarker`,
 * `deletedAt` and `retiredBy` beside the tags, no live read saw it, the roots still differed, and every attempt of the re-read ended the same.
 *
 * ## How it is driven
 *
 * One real receiver and the fake peer of `_pull-door.mjs`, which serves the record from its own storage through the real page handler and reports
 * as its merkle root the root this instance had while it held the record live (the two instances agreed then; only the removal differs). The
 * receive mark is past the record, so only the re-read can deliver it. The removal is the sweep's own writer (`removeFileHere`, narrowed,
 * `retiredBy: 'bytes-lost'`), so the merkle check sees it as it would after a real sweep.
 *
 * Red on 127a77e4: three attempts of the re-read, and the row is the marker with the peer's tags merged into it (the sync suite's
 * `a-record-the-absent-bytes-sweep-removed-comes-back-whole-from-its-peer`, second case, Full run 43160388370).
 *
 * Run: node --test testing/standalone/a-record-the-absent-bytes-sweep-removed-is-offered-back-by-the-merkle-re-read-db.test.js
 * (requires a prior `npm run build -w @ythril/server`, and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'bounce';
const SEQ = 5;
/** The receive mark, past the record: an ordinary pull from here never serves it again, so only the re-read can. */
const WATERMARK = 10;
const SHA = 'b'.repeat(64);

let door, merkle, removal;
let n = 0;
const files = () => door.coll(S, 'files');
const net = () => door.config().networks.find(x => x.id === door.NET);
const rowOf = (id) => files().findOne({ _id: id });

/** The record as both instances hold it, live: the peer's, with a person's tags. */
const record = (id) => build.filemeta(S, id, SEQ, { tags: ['bounce'], description: 'kept by the peer', author: PEER_AUTHOR, sizeBytes: 11, sha256: SHA });

/** Both sides hold `id` live and agree: the peer serves it, this instance stores it, and the peer's root is this instance's root now. */
async function heldOnBoth() {
  const id = `bounce/row-${++n}.txt`;
  await files().insertOne({ ...record(id), spaceId: S, deliveredBy: PEER });
  await door.seedPeerRecords(S, 'filemeta', [record(id)]);
  door.state.family = door.serveFamily;
  door.member().lastPosReceived = { [S]: WATERMARK };
  const agreed = (await merkle.computeMerkleRoot(S)).root;
  door.state.merkle = (_req, res) => res.json({ root: agreed, leafCount: 1 });
  return id;
}

describe('a record the absent-bytes sweep removed is offered back by the merkle re-read (real MongoDB, fake peer)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b70_bounce', spaces: [S] });
    merkle = await import('../../server/dist/brain/merkle.js');
    ({ removeFileHere: removal } = await import('../../server/dist/files/remove-file-here.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    net().merkle = true;
  });

  it('control: with nothing removed the roots agree and nothing is re-read', async () => {
    const id = await heldOnBoth();
    await door.sync();
    assert.equal(door.member().fileMetaRereadAt?.[S], undefined, 'the roots of two instances that agree were read as different');
    assert.equal((await rowOf(id))?.feedMarker, undefined);
  });

  it('removed by the sweep: offered back by the re-read, lands live with its tags and without the sweep\'s reason', async () => {
    const id = await heldOnBoth();
    const taken = await removal(S, id, { failure: 'throw', retireOnlyIf: {}, retiredBy: 'bytes-lost' });
    assert.equal(taken, true, 'fixture: the sweep\'s writer did not take the row');
    assert.equal((await rowOf(id))?.feedMarker, true, 'fixture: the removal did not leave a feed marker');

    for (let i = 0; i < 3 && (await rowOf(id))?.feedMarker === true; i++) await door.sync();

    const row = await rowOf(id);
    assert.ok(row && row.feedMarker !== true && row.deletedAt === undefined,
      `the peer's record was not offered back live by the re-read (mark ${JSON.stringify(door.member().fileMetaRereadAt?.[S])}): ${JSON.stringify(row)}`);
    assert.deepEqual(row.tags, ['bounce'], 'the record came back without what a person wrote on it');
    assert.equal(row.retiredBy, undefined, 'the record came back live still carrying the sweep\'s reason');
    assert.equal(door.member().fileMetaRereadAt?.[S], undefined, 'the record is back, yet the roots still differ');
  });
});

/**
 * A file row that drifted from its author's is re-read and converged after a merkle check finds the roots differ — and
 * only then (bundle-89, Q-419, plan rev 3 §E3 items 5-8).
 *
 * ## Why a re-read is needed at all
 *
 * The heal half of Q-419 converges a row when the author delivers it again at the same seq. An ordinary pull never does:
 * it starts at the receive watermark, and a row that drifted is BEHIND it. So without a re-read the convergence rule is
 * correct and never runs, and `MERKLE_DIVERGENCE` is logged every cycle for a space where nobody disagrees about anything.
 *
 * ## What is asserted
 *
 *  - **The control first.** The drifted row behind the watermark, nothing armed: one cycle leaves it drifted. Without
 *    this, every case below could be passing because the ORDINARY pull converged the row — the fake peer's canned route
 *    ignores `sinceSeq`, which is why every case here serves through the real handler (`door.serveFamily`).
 *  - **Arming.** A merkle check that finds the roots differ arms the re-read; one that finds them equal, or learns nothing
 *    (404, no root), arms nothing.
 *  - **The re-read.** Armed, the next cycle reads the member's file rows from the start, the drifted row converges, the
 *    attempt is marked done — and the RECEIVE WATERMARK does not move: the re-read is a repair, not a position in the
 *    stream, and the ordinary pull's place must survive it.
 *  - **The cap.** Once the last attempt has read to the end and the roots still differ, that is said ONCE and the
 *    re-read stops; a difference the re-read cannot fix is not re-read for ever.
 *  - **The gauge.** An owed re-read is visible to an operator before anything is logged.
 *
 * Run: node --test testing/standalone/a-drifted-file-row-is-re-read-on-a-merkle-mismatch-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'reread';
const CREATED_AT = '2026-08-01T00:00:00.000Z';
/** What this instance holds: a timestamp the author's copy does not have. */
const DRIFTED_AT = '2026-10-01T00:00:00.000Z';
/** The author's own value — what the row must converge to. */
const AUTHORS_AT = '2026-09-01T00:00:00.000Z';
const SEQ = 5;
/** The receive watermark, PAST the drifted row: an ordinary pull from here never serves it again. */
const WATERMARK = 10;

let door, merkle, register, CAP;
let n = 0;
const files = () => door.coll(S, 'files');
const freshId = () => `reread/row-${++n}.md`;
const mark = () => door.member().fileMetaRereadAt?.[S];
const net = () => door.config().networks.find(x => x.id === door.NET);

/**
 * A row the member authored, held here with a drifted `updatedAt`, and the member serving its own copy at the same seq
 * with the author's value. The receive watermark is set past it, so only a re-read can deliver it again.
 */
async function driftedRow() {
  const id = freshId();
  await files().insertOne({
    _id: id, spaceId: S, path: id, tags: ['t'], description: 'd', createdAt: CREATED_AT,
    updatedAt: DRIFTED_AT, seq: SEQ, author: PEER_AUTHOR, deliveredBy: PEER, sizeBytes: 11, sha256: 'a'.repeat(64),
  });
  await door.seedPeerRecords(S, 'filemeta', [build.filemeta(S, id, SEQ, {
    tags: ['t'], description: 'd', createdAt: CREATED_AT, updatedAt: AUTHORS_AT, author: PEER_AUTHOR, sizeBytes: 11, sha256: 'a'.repeat(64),
  })]);
  door.state.family = door.serveFamily;
  door.member().lastSeqReceived = { [S]: WATERMARK };
  return id;
}
const updatedAtOf = async (id) => (await files().findOne({ _id: id }))?.updatedAt;

/** The peer reports this instance's own root (a match), a different one (a mismatch), or a body with none. */
const peerRoot = {
  same: () => { door.state.merkle = async (_req, res) => res.json({ root: (await merkle.computeMerkleRoot(S)).root, leafCount: 1 }); },
  different: () => { door.state.merkle = (_req, res) => res.json({ root: 'f'.repeat(64), leafCount: 1 }); },
  missing: () => { door.state.merkle = (_req, res) => res.json({ leafCount: 1 }); },
};

describe('a drifted file row is re-read on a merkle mismatch (real MongoDB, fake peer)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b89_e3_reread', spaces: [S] });
    merkle = await import('../../server/dist/brain/merkle.js');
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    ({ FILE_META_REREAD_CAP: CAP } = await import('../../server/dist/sync/file-meta-reread.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    net().merkle = true;
  });

  it('control: behind the watermark and nothing armed, one cycle leaves the row drifted', async () => {
    const id = await driftedRow();
    await door.sync();
    assert.equal(await updatedAtOf(id), DRIFTED_AT,
      'the ORDINARY pull converged a row behind its own watermark — every case below would then pass without a re-read');
  });

  describe('arming', () => {
    it('a merkle check that finds the roots DIFFER arms the first attempt, from the start', async () => {
      peerRoot.different();
      await door.sync();
      assert.equal(mark(), '1:0', 'a divergence armed nothing: the drifted rows behind the watermark stay drifted for ever');
    });
    it('a check that finds them EQUAL arms nothing', async () => {
      peerRoot.same();
      await door.sync();
      assert.equal(mark(), undefined);
    });
    it('a check that learns nothing — the peer 404s, or answers no root — arms nothing', async () => {
      await door.sync();   // unscripted: the fake peer 404s the route
      assert.equal(mark(), undefined, 'a 404 was read as a divergence');
      peerRoot.missing();
      await door.sync();
      assert.equal(mark(), undefined, 'a body with no root was read as a divergence');
    });
    it('with merkle OFF, nothing is checked and nothing is armed — the repair is opt-in', async () => {
      net().merkle = false;
      peerRoot.different();
      await door.sync();
      assert.equal(mark(), undefined);
    });
  });

  describe('the re-read', () => {
    it('armed, the next cycle converges the drifted row, marks the attempt done, and leaves the receive watermark alone', async () => {
      const id = await driftedRow();
      door.member().fileMetaRereadAt = { [S]: '1:0' };
      peerRoot.same();   // so this cycle's own check does not re-arm what the re-read just finished

      await door.sync();

      assert.equal(await updatedAtOf(id), AUTHORS_AT, 'the re-read did not converge the drifted row on its author\'s value');
      assert.equal(door.member().lastSeqReceived[S], WATERMARK,
        'the re-read moved the receive watermark: a repair is not a position in the stream, and the ordinary pull\'s place must survive it');
      assert.ok(door.state.familyRequests.some(q => q.family === 'filemeta' && String(q.sinceSeq) === '0'),
        'no request read the member\'s file rows from the start');
      assert.equal(mark(), undefined, 'the roots matched after the re-read, so the mark is cleared');
    });

    it('a re-read that reads to the end while the roots still differ is marked done, and the next difference is attempt 2', async () => {
      await driftedRow();
      door.member().fileMetaRereadAt = { [S]: '1:0' };
      peerRoot.different();
      await door.sync();
      assert.equal(mark(), '2:0', 'attempt 1 read to the end, the roots still differed, and the next attempt was not armed');
    });
  });

  describe('the cap', () => {
    it('the last attempt read to the end and the roots still differ: said ONCE, and not re-read again', async () => {
      door.member().fileMetaRereadAt = { [S]: `${CAP}:done` };
      peerRoot.different();

      const first = await door.logsDuring(() => door.sync());
      assert.equal(mark(), 'spent', 'the cap was reached and the re-read carried on regardless');
      const said = first.lines.filter(l => /re-?read/i.test(l) && l.includes(S));
      assert.equal(said.length, 1, `the cap must be said exactly once, got: ${JSON.stringify(first.lines)}`);

      door.state.familyRequests.length = 0;
      const second = await door.logsDuring(() => door.sync());
      assert.equal(second.lines.filter(l => /re-?read/i.test(l) && l.includes(S)).length, 0, 'the spent cap was said again on the next cycle');
      assert.ok(!door.state.familyRequests.some(q => q.family === 'filemeta' && String(q.sinceSeq) === '0'),
        'a spent re-read read from the start again');
    });
  });

  it('the gauge: an owed re-read is counted before anything is logged, and a finished one is not', async () => {
    const owed = async () => {
      const metric = (await register.getMetricsAsJSON()).find(m => m.name === 'ythril_sync_file_meta_rereads_owed');
      assert.ok(metric, 'ythril_sync_file_meta_rereads_owed is not registered: an operator cannot see an owed re-read');
      return metric.values.reduce((sum, v) => sum + v.value, 0);
    };
    door.member().fileMetaRereadAt = { [S]: '1:0' };
    assert.equal(await owed(), 1, 'an armed re-read is not counted');
    door.member().fileMetaRereadAt = { [S]: '1:done' };
    assert.equal(await owed(), 0, 'a finished attempt is counted as owed');
  });
});

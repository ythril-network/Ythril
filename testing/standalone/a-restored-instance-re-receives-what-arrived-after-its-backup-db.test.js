/**
 * A restored instance receives again what arrived after its backup, and keeps what it SENT (bundle-157, Q-554; design rev 2).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A restore puts the database back to the backup's moment, and the config is not in the backup: every member's receive mark still
 * says "I have read this space up to seq N", where N is what arrived AFTER the backup. So the next exchange asks the peer for what is
 * above N, and everything between the backup and N - records and the tombstones of deletions - is never asked for again. The
 * restored instance is silently behind its peers for good.
 *
 * The rule (rev 2): the restore act's completion forgets the RECEIVE marks of the space in every network that carries it
 * (`lastSeqReceived`, `tombstoneRereadAt`, `fileMetaRereadAt`), and KEEPS the send-side marks (`lastSeqPushed`, `lastSeqServed`,
 * `lastFileTombstoneAckedAt`): clearing what was pushed would re-send restored records whose deletions peers already pruned.
 *
 * ## What is asserted, by identity
 *
 * The fake peer (a publisher, `openPullDoor`) serves its pages through the REAL page handler, which honours `sinceSeq`. Before the
 * backup the instance pulled `p1` and `p3`; after it, `p2` and a tombstone deleting `p3`. The restore brings back `p1` and `p3` and no
 * tombstone. Then:
 *
 * - every receive mark of the space is gone, and every send-side mark is the value it had (sentinels set before the restore);
 * - one exchange later `p2` is stored again, `p3` is deleted again and its tombstone is stored again.
 *
 * The restore goes through the data router's own `POST /restore`; whatever it answers, the restore acts it registered are run to
 * their end (`restoreToTheEnd`), so the red is about the outcome. The fake peer keeps its storage in the same database, so the restore
 * rolls the PEER back too: its post-backup state is written again after the restore, as a real peer's would still be.
 *
 * ## Seen red
 *
 * On 14005a5c the route restores inline and forgets nothing: `lastSeqReceived` still names the post-backup seq.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restored-instance-re-receives-what-arrived-after-its-backup-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { resetRunnerForTest } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreToTheEnd } from './_restore-act.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'rereceive';
const S = 'rerecv';
const RECEIVE = ['lastSeqReceived', 'tombstoneRereadAt', 'fileMetaRereadAt'];
const KEPT = ['lastSeqPushed', 'lastSeqServed', 'lastFileTombstoneAckedAt'];
const SENTINEL = { lastSeqPushed: 77, lastSeqServed: 88, lastFileTombstoneAckedAt: '2026-10-01T00:00:00.000Z', tombstoneRereadAt: '2026-10-02T00:00:00.000Z', fileMetaRereadAt: '2026-10-03T00:00:00.000Z' };

let door, mods;
const fact = (id, seq) => build.fact(S, id, seq, { author: PEER_AUTHOR });
const stored = (part, id) => door.coll(S, part).findOne({ _id: id });

/** The peer's state after the backup: p2 added, p3 deleted and its tombstone served. Idempotent, so it can be written again. */
async function peerAfterBackup() {
  const side = door.peerSide(S);
  await door.mongo.col(`${side}_facts`).deleteMany({ _id: { $in: ['p2', 'p3'] } });
  await door.mongo.col(`${side}_tombstones`).deleteMany({ _id: 'p3' });
  await door.seedPeerRecords(S, 'facts', [fact('p2', 3)]);
  await door.seedPeer(S, [build.tombstone(S, 'p3', 'fact', 4, { instanceId: PEER_AUTHOR.instanceId })]);
}

describe('a restored instance re-receives what arrived after its backup (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: SUITE, spaces: [S] });
    mods = await restoreModules();
    door.state.family = door.serveFamily;
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });

  it('the restore forgets the receive marks, keeps the send marks, and the next exchange brings back records and tombstones', { timeout: 90_000 }, async () => {
    await door.seedPeerRecords(S, 'facts', [fact('p1', 1), fact('p3', 2)]);
    await door.sync();
    assert.ok(await stored('facts', 'p1') && await stored('facts', 'p3'), 'fixture: the first exchange did not store p1 and p3');
    const backup = await takeBackup(SUITE, `rereceive-${Date.now()}`);

    await peerAfterBackup();
    await door.sync();
    assert.ok(await stored('facts', 'p2'), 'fixture: the post-backup exchange did not store p2');
    assert.equal(await stored('facts', 'p3'), null, 'fixture: the post-backup tombstone did not delete p3');
    assert.ok(await stored('tombstones', 'p3'), 'fixture: the post-backup tombstone was not stored');
    const received = door.member().lastSeqReceived?.[S];
    assert.ok(received >= 3, `fixture: the receive mark did not reach the post-backup seq: ${received}`);
    mods.loader.mutateConfig(cfg => {
      const m = cfg.networks.find(n => n.id === door.NET).members[0];
      for (const [k, v] of Object.entries(SENTINEL)) m[k] = { ...(m[k] ?? {}), [S]: v };
    });

    await restoreToTheEnd(mods, { backupId: backup.id });
    assert.ok(await stored('facts', 'p3'), 'fixture: the restore did not bring back p3');
    assert.equal(await stored('facts', 'p2'), null, 'fixture: the restore did not remove p2');

    const member = door.member();
    const notForgotten = RECEIVE.filter(k => member[k]?.[S] !== undefined).map(k => `${k}=${JSON.stringify(member[k][S])}`);
    assert.deepEqual(notForgotten, [], `after the restore completed the space's receive marks still stand, so what arrived after the backup is never asked for again: ${notForgotten.join(', ')}`);
    const notKept = KEPT.filter(k => member[k]?.[S] !== SENTINEL[k]).map(k => `${k}=${JSON.stringify(member[k]?.[S])}`);
    assert.deepEqual(notKept, [], `the restore changed a send-side mark it must keep: ${notKept.join(', ')}`);

    await peerAfterBackup();
    await door.sync();
    assert.ok(await stored('facts', 'p2'), 'p2, which arrived after the backup, was not received again');
    assert.equal(await stored('facts', 'p3'), null, 'p3, deleted after the backup, is live again: its tombstone was not received again');
    assert.ok(await stored('tombstones', 'p3'), 'the tombstone of p3 was not stored again');
  });
});

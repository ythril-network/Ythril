/**
 * On pub/sub a SUBSCRIBER's deletion or wipe is a local act, and the PUBLISHER's deletion acts at once and tells (bundle-106 R-D40a-e, R-X10b, R-X10c,
 * R-X10e; design v5 section 2.9; owner D-40, 2026-10-15).
 *
 * ## The rules this holds
 *
 * - **A subscriber opens no round** (R-D40a, R-D40b). Its wipe empties its own copy through the runner and FORGETS its receive marks for the space
 *   with its publisher, so the next pull starts at seq 0 and the copy refills (a wipe keeps the marks, and a pull from a kept mark never brings the
 *   records back). Its deletion takes the space out of the network on this instance's record only, adds the network's space id to `dismissedSpaces`,
 *   and removes the own copy. Nothing is served, notified or relayed to the publisher.
 * - **A publisher refuses a round it did not open, twice** (R-D40c, R-X10c). On pub/sub every other member is a subscriber, so such a round can only be
 *   a subscriber's: adoption refuses it, AND the pass rule never passes a `space_deletion` or `space_wipe` on a publisher unless `proposedHere`, so a
 *   subscriber's round an OLDER publisher stored before the upgrade ends `expired` instead of emptying the publisher's whole space.
 * - **The publisher's deletion acts at once and queues a notice** to its subscribers (R-D40d), BEFORE the space leaves the network, because
 *   `queueChangeNote` refuses a space the network does not carry.
 * - **A mixed space** (a subscriber in pub/sub AND a club member) opens rounds in the club only (R-D40e).
 *
 * ## Absence is asserted next to its positive twin
 *
 * "The publisher was not told" is read after the runner is idle, in a test whose twin tells a CLUB member through the same send path (design X19, TS-6).
 *
 * Run: node --test testing/standalone/a-subscribers-acts-are-local-and-the-publishers-tell-db.test.js
 * (requires a prior server build, the test MongoDB and a private LAN address)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, allowEngineToDialPrivatePeers, settled, callRoute } from './_vote-round-instance.mjs';
import { startVotesPeer } from './_vote-round-sites.mjs';
import { untilRunnerIdle, resetRunnerForTest, entriesOf, deferred } from './_space-act-harness.mjs';
import { SELF, M1, M2, tempInstance, networkOf, boot, seedFacts, factCount, roundsOf, doors, until, untilOrBound, requireRunner, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-pubsub-local-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const HOUR = 3_600_000;
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

describe('pub/sub: a subscriber acts locally, the publisher acts at once and tells', { skip }, () => {
  let mongo; let publisher; let club;
  before(async () => {
    allowEngineToDialPrivatePeers();
    publisher = await startVotesPeer();
    club = await startVotesPeer();
    mongo = await openTestMongo('pubsub_local');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await publisher?.close(); await club?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  const told = (peer) => peer.seen.filter(s => s.method === 'POST' && (s.url === '/api/notify' || /\/votes\//.test(s.url)));
  /** SELF as a SUBSCRIBER: its one member is the publisher, whom it pulls from. The marks stand at positions a refill must restart from. */
  const subscriberNet = (extra = {}, spaces = ['general', 'notes']) => {
    const net = networkOf('pubsub', [M1], { spaces, extra: { origin: 'joined', ...extra }, memberExtra: { direction: 'pull' } });
    Object.assign(net.members[0], { url: publisher.url, lastSeqReceived: { notes: 50 }, lastSeqServed: { notes: 30 } });
    return net;
  };
  const publisherNet = (extra = {}, memberExtra = {}) => {
    const net = networkOf('pubsub', [M1], { spaces: ['general', 'notes'], extra, memberExtra: { direction: 'push', ...memberExtra } });
    net.members[0].url = publisher.url;
    return net;
  };
  const settleAfterAct = async (loader) => { const runner = await import('../../server/dist/spaces/space-act-runner.js').catch(() => null); if (runner) await untilRunnerIdle(runner, loader); return runner; };

  it('R-D40a: a subscriber\'s wipe opens no round, tells the publisher nothing, empties its own copy and forgets its marks for the space; the same send path DOES tell a club member', async () => {
    const clubNet = networkOf('club', [M2], { id: 'club-1', spaces: ['general', 'other'] });
    clubNet.members[0].url = club.url;
    const loader = await boot(dir, { spaces: ['notes', 'other'], networks: [subscriberNet(), clubNet] });
    await seedFacts(mongo, 'notes', 3, 'sub-wipe');
    await seedFacts(mongo, 'other', 1, 'club-wipe');
    publisher.seen.length = 0; club.seen.length = 0;
    const res = await doors.wipeSpace('notes');
    assert.equal(res.code, 200, `${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}`);
    assert.equal(res.body.status, 'wiped');
    assert.equal(res.body.refills, true, 'the answer says the copy refills from the publisher');
    assert.equal(roundsOf(loader, 'net-1').length, 0, 'a subscriber opened a round for a wipe of its own copy');
    // The twin: a wipe of the space only the club carries goes through the notify path and DOES tell its member.
    assert.equal((await doors.wipeSpace('other')).code, 200);
    await until(() => told(club).some(s => /space_wipe_pending/.test(s.body)), 'the club member was told');
    const runner = await settleAfterAct(loader);
    assert.deepEqual(told(publisher), [], 'the publisher was told of a subscriber\'s local wipe');
    assert.equal(await factCount(mongo, 'notes'), 0);
    const m = loader.getConfig().networks[0].members[0];
    assert.deepEqual([m.lastSeqReceived?.notes, m.lastSeqServed?.notes], [undefined, undefined], 'the marks survived the wipe: a pull from a kept mark never brings the records back');
    if (runner) resetRunnerForTest(runner);
  });

  it('R-D40b: a subscriber\'s deletion leaves the network on its own record, dismisses the space and removes its copy — and answers 204', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [subscriberNet()] });
    await seedFacts(mongo, 'notes', 1, 'sub-del');
    publisher.seen.length = 0;
    const res = await doors.deleteSpace('notes');
    assert.equal(res.code, 204, `${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}`);
    await settleAfterAct(loader);
    const net = loader.getConfig().networks[0];
    assert.deepEqual([net.spaces.includes('notes'), net.dismissedSpaces?.includes('notes'), roundsOf(loader, 'net-1').length], [false, true, 0]);
    assert.ok(!loader.getConfig().spaces.some(s => s.id === 'notes'), 'the own copy stays');
    assert.deepEqual(told(publisher), []);
  });

  it('R-D40e: a space a subscriber shares with a club opens a round in the club only', async () => {
    const clubNet = networkOf('club', [M2], { id: 'club-1', spaces: ['general', 'notes'] });
    clubNet.members[0].url = club.url;
    const loader = await boot(dir, { spaces: ['notes'], networks: [subscriberNet(), clubNet] });
    const res = await doors.deleteSpace('notes');
    assert.ok([200, 202].includes(res.code), JSON.stringify(res.body)?.slice(0, 200));
    assert.deepEqual([roundsOf(loader, 'net-1').length, roundsOf(loader, 'club-1', 'space_deletion').length], [0, 1]);
  });

  it('R-D40c: a publisher does not adopt a deletion round a subscriber (an older release) serves', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [publisherNet({ origin: 'created' })] });
    loader.getConfig().networks[0].members[0].version = '1.0.0';
    loader.getConfig().networks[0].members[0].versionCheckedAt = new Date().toISOString();
    publisher.serve([{ roundId: 'sub-round', type: 'space_deletion', spaceId: 'notes', networkSpaceId: 'notes', subjectInstanceId: M1, subjectLabel: 'm1', subjectUrl: '',
      openedAt: minutesAgo(5), deadline: new Date(Date.now() + 23 * HOUR).toISOString(), votes: [{ instanceId: M1, vote: 'yes', castAt: minutesAgo(4) }], concluded: false }]);
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(M1);
    await settled(() => roundsOf(loader, 'net-1').length);
    assert.deepEqual(roundsOf(loader, 'net-1'), [], 'the publisher adopted a round only a subscriber can have opened');
  });

  it('R-X10c: a subscriber\'s wipe round stored open on a publisher never passes there — by relay or by gossip — and ends expired', async () => {
    const stored = { roundId: 'old-sub', type: 'space_wipe', spaceId: 'notes', networkSpaceId: 'notes', subjectInstanceId: M1, subjectLabel: 'm1', subjectUrl: '',
      openedAt: minutesAgo(5), deadline: new Date(Date.now() + 23 * HOUR).toISOString(), votes: [{ instanceId: M1, vote: 'yes', castAt: minutesAgo(4) }], concluded: false };
    const loader = await boot(dir, { spaces: ['notes'], networks: [publisherNet({ origin: 'created', pendingRounds: [stored] })] });
    await seedFacts(mongo, 'notes', 2, 'x10c');
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    const relayed = await callRoute(syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
      params: { networkId: 'net-1', roundId: 'old-sub' }, body: { instanceId: M1, vote: 'yes', castAt: new Date().toISOString() }, authToken: { peerInstanceId: M1, rights: { instanceAdmin: false } },
    });
    assert.ok(relayed.code < 500, JSON.stringify(relayed.body));
    const gossip = async () => {
      loader.getConfig().networks[0].members[0].version = '1.0.0';
      loader.getConfig().networks[0].members[0].versionCheckedAt = new Date().toISOString();
      publisher.serve([{ ...stored, votes: [{ instanceId: M1, vote: 'yes', castAt: minutesAgo(4) }] }]);
      await (await import('../../server/dist/sync/engine.js')).runSyncForPeer(M1);
    };
    await gossip();
    const round = () => roundsOf(loader, 'net-1', 'space_wipe').find(r => r.roundId === 'old-sub');
    await untilOrBound(mongo, async () => (await factCount(mongo, 'notes')) === 0, 600);
    assert.equal(round().passed === true, false, 'a subscriber\'s round passed on the publisher: its yes alone passes a pub/sub round (governance: yes >= 1), so it would empty the publisher\'s whole space');
    assert.equal(await factCount(mongo, 'notes'), 2);
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    runRoundExpiryTick(Date.now() + 24 * HOUR);
    assert.deepEqual([round()?.concluded, round()?.outcome], [true, 'expired']);
  });

  it('R-D40d: the publisher\'s deletion acts at once, and a notice to its subscribers was queued before the space left the network', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [publisherNet({ origin: 'created' })] });
    await seedFacts(mongo, 'notes', 1, 'pub-del');
    await mongo.col('_change_notes').deleteMany({});
    const res = await doors.deleteSpace('notes');
    assert.equal(res.code, 200, `${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}: one yes passes a pub/sub round, so the publisher's deletion acts in the request`);
    await settleAfterAct(loader);
    const notes = await untilOrBound(mongo, async () => (await mongo.col('_change_notes').countDocuments({ networkId: 'net-1', direction: 'out' })) > 0, 1500);
    assert.equal(notes, true, 'no notice was queued: queueChangeNote refuses a space the network no longer carries, so it must run BEFORE the settle');
    const note = await mongo.col('_change_notes').findOne({ networkId: 'net-1', direction: 'out' });
    assert.match(note.note, /deleted the space/);
    assert.match(note.note, /leave/i, 'the notice names the member\'s alternative (D-41): leave the network');
    assert.deepEqual(note.pendingFor, [M1]);
  });

  it('R-X10b (control): a member that declined a space and is removed and re-added comes back with no memory of the decline', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [publisherNet({ origin: 'created' }, { declinedSpaces: ['notes'] })] });
    assert.equal((await doors.removeMember('net-1', M1)).code, 204);
    const add = await doors.addMember('net-1', { instanceId: M1, label: 'm1', url: 'https://m1.example.com', token: 'again', direction: 'push' });
    assert.equal(add.code, 201, JSON.stringify(add.body)?.slice(0, 200));
    assert.equal(loader.getConfig().networks[0].members.find(m => m.instanceId === M1).declinedSpaces, undefined);
  });

  it('R-X10e: a subscriber wipe that crashes between its batches and its completion resumes into the write that forgets the marks', async () => {
    const runner = await requireRunner();
    const loader = await boot(dir, { spaces: ['notes'], networks: [subscriberNet()] });
    await seedFacts(mongo, 'notes', 2, 'x10e');
    let crash = true;
    runner.setSpaceActHooksForTest({ beforeComplete: async () => { if (crash) { crash = false; throw new Error('crash before the completion'); } } });
    const res = await doors.wipeSpace('notes');
    assert.ok([200, 202, 500].includes(res.code), JSON.stringify(res.body)?.slice(0, 200));
    await until(() => entriesOf(loader).some(e => e.state === 'owed'), 'the wipe is owed after the crash');
    assert.equal(loader.getConfig().networks[0].members[0].lastSeqReceived?.notes, 50, 'the marks were forgotten before the completion write');
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    runRoundExpiryTick(Date.now() + 3 * HOUR);
    await untilRunnerIdle(runner, loader, { now: Date.now() + 3 * HOUR });
    assert.equal(loader.getConfig().networks[0].members[0].lastSeqReceived?.notes, undefined, 'the next pull would not start at seq 0');
    assert.deepEqual(entriesOf(loader), []);
    resetRunnerForTest(runner);
    void deferred; void SELF;
  });
});

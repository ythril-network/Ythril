/**
 * A passed deletion or wipe settles by what this instance has to DO for it — never owed for ever, never applied to a later re-add, never skipped
 * for being late (bundle-106; design v5 section 2.1 and 2.7: R-W5, R-X7a-d, R-X8a-c).
 *
 * ## The defects this holds
 *
 * - **Q-520 (R-X7a, R-X7b).** `applyConcludedSpaceRounds` does `if (!action) continue;` BEFORE it sets `appliedHere`, and the action is `null` for a
 *   space the network does not carry here. So a passed wipe of a space held only as a pending offer (or dismissed, or not held at all) is stored
 *   un-applied, the gossip pass hands every held round to the same code on every changed pass, and the day the space is added or accepted the stored
 *   wipe EMPTIES it. A round with nothing to do here settles `not-carried` at once, in the same synchronous call, and one stored by an older build is
 *   settled the first time the tick meets it, in one save.
 * - **R-X7c, R-X7d.** A proposer's deletion whose network half ran and whose own-copy half then failed resolves to no network space — the
 *   not-carried shape — so its own copy was never removed; and the mirror: an owed deletion whose local space is gone while the network still lists
 *   it must still take the space out of the network.
 * - **R-W5.** A round concluded and saved whose application never ran (a crash between the save and the act) is OWED, retried by the tick and completed.
 * - **R-X8.** A member that concludes a passed wipe applies it whatever the (unsigned, relayer-movable) `castAt` says and forgets its receive marks
 *   for that space, so its next pull starts at seq 0; a crash between the last batch and the completion resumes into the same single write.
 *
 * Run: node --test testing/standalone/a-concluded-space-round-settles-by-what-it-has-to-do-here-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, settled, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { startVotesPeer } from './_vote-round-sites.mjs';
import { passedSpaceRound, entriesOf, untilRunnerIdle, resetRunnerForTest } from './_space-act-harness.mjs';
import {
  SELF, M1, tempInstance, networkOf, boot, seedFacts, factCount, requireExport, requireRunner, untilOrBound, retryEveryHeldRound,
  databaseTakesCollections, warmSpaceCreation,
} from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-settle-here-');
const skip = await mongoSkipReason();
const admin = { rights: { instanceAdmin: true } };
const club = (rounds, extra = {}, spaces = ['general']) => networkOf('club', [M1], { spaces, extra: { origin: 'joined', pendingRounds: rounds, ...extra } });
const offer = { networkId: 's', localId: 's', why: 'announced', from: M1, at: '2026-10-01T00:00:00.000Z' };

describe('a passed round with nothing to do here settles at once, and one this instance must act on is owed', { skip }, () => {
  let mongo;
  before(async () => {
    mongo = await openTestMongo('settle_here');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await closeTestMongo(); });

  it('R-X7a (Q-520): a passed wipe of a space held only as a pending offer is never owed, and accepting the space afterwards wipes nothing', async () => {
    const loader = await boot(dir, { spaces: ['s'], networks: [club([passedSpaceRound('w1', 'space_wipe', 's', { proposedHere: false })], { pendingSpaces: [offer] })] });
    await seedFacts(mongo, 's', 3);
    await retryEveryHeldRound(loader);
    const round = () => loader.getConfig().networks[0].pendingRounds.find(r => r.roundId === 'w1');
    assert.equal(round().appliedHere, true, 'a wipe with nothing to do here is stored un-applied: it will act on the space the day it is carried (Q-520)');
    assert.deepEqual(entriesOf(loader), [], 'a not-carried round registered an act entry: it would be owed for ever');
    const res = await (await import('../../server/dist/networks/network-acts.js')).resolvePendingSpaceAct(admin, 'net-1', { spaceId: 's', action: 'accept' });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.ok(loader.getConfig().networks[0].spaces.includes('s'), 'the offer was not accepted');
    await retryEveryHeldRound(loader);
    const wiped = await untilOrBound(mongo, async () => (await factCount(mongo, 's')) === 0);
    assert.equal(wiped, false, 'accepting the space re-applied the stored wipe and emptied it');
    assert.equal(await factCount(mongo, 's'), 3);
  });

  it('R-X7b: a passed, un-applied wipe of an uncarried space stored by an older build is settled by the first tick, in one save, and acts on nothing', async () => {
    const loader = await boot(dir, { spaces: ['s'], networks: [club([passedSpaceRound('w1', 'space_wipe', 's', { proposedHere: false })])] });
    await mongo.col('s_facts').deleteMany({});   // the row above leaves its three records in `s`, on purpose: this row counts its own
    await seedFacts(mongo, 's', 2, 'old');
    const configWriteGeneration = await requireExport('../../server/dist/config/loader.js', 'configWriteGeneration', 'design v5 section 6.1: a read-only export of the write generation, the way a save is counted');
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    const before = configWriteGeneration();
    runRoundExpiryTick(Date.now());
    assert.equal(loader.getConfig().networks[0].pendingRounds.find(r => r.roundId === 'w1').appliedHere, true, 'the tick left a round with nothing to do owed');
    assert.equal(configWriteGeneration() - before, 1, 'settling every such round is ONE save');
    runRoundExpiryTick(Date.now());
    assert.equal(configWriteGeneration() - before, 1, 'a second tick saved again: it found something to settle twice');
    assert.equal(await factCount(mongo, 's'), 2);
  });

  it('R-X7c: a proposer deletion whose network half ran and whose own copy remains removes the own copy, then completes', async () => {
    // The network no longer lists `s` (removeSpaceFromNetwork ran and forgot the alias); the local space is still here, with data.
    const round = passedSpaceRound('d1', 'space_deletion', 's', { networkSpaceId: 's', actLocalId: 's' });
    const loader = await boot(dir, { spaces: ['s'], networks: [club([round], { origin: 'created' })] });
    await seedFacts(mongo, 's', 2, 'own');
    await retryEveryHeldRound(loader);
    const gone = await untilOrBound(mongo, async () => !loader.getConfig().spaces.some(x => x.id === 's'));
    assert.equal(gone, true, 'the own-copy half was never retried: the round resolves to no network space and reads as having nothing to do');
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].appliedHere, true);
  });

  it('R-X7d (control): an owed deletion whose local space is gone while the network still lists it takes the space out of the network', async () => {
    const round = passedSpaceRound('d2', 'space_deletion', 's', { networkSpaceId: 's' });
    const loader = await boot(dir, { spaces: [], networks: [club([round], { origin: 'created' }, ['general', 's'])] });
    await retryEveryHeldRound(loader);
    const left = await untilOrBound(mongo, async () => !loader.getConfig().networks[0].spaces.includes('s'));
    assert.equal(left, true, 'a deletion whose own copy is gone skipped its network half');
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].appliedHere, true);
  });

  it('R-W5: a round concluded and saved whose act never ran is owed — retried by the tick and completed, and served as not concluded meanwhile', async () => {
    const round = passedSpaceRound('w5', 'space_wipe', 's', { networkSpaceId: 's' });
    const loader = await boot(dir, { spaces: ['s'], networks: [club([round], { origin: 'created' }, ['general', 's'])] });
    await seedFacts(mongo, 's', 3, 'owed');
    const owed = await requireExport('../../server/dist/networks/round-state.js', 'spaceActOwed', 'design v5 section 2.1: owed is one predicate of the round');
    assert.equal(owed(loader.getConfig().networks[0].pendingRounds[0]), true);
    const { roundForPeer } = await import('../../server/dist/networks/round-local-state.js');
    assert.equal(roundForPeer(loader.getConfig().networks[0].pendingRounds[0]).concluded, false, 'an owed round is served concluded: a peer would lift its hold over data not yet emptied here');
    const runner = await requireRunner();
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    runRoundExpiryTick(Date.now());
    // This is the file's first wipe body, and a cold one loads its modules on the way: the wait is bounded by store round trips,
    // as the rows below are, rather than by event-loop turns, which a cold body outlasts.
    await untilOrBound(mongo, async () => runner.spaceActsRunning() === 0 && entriesOf(loader).length === 0, 3000);
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount(mongo, 's'), 0, 'the tick did not complete the owed wipe');
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].appliedHere, true);
    assert.deepEqual(entriesOf(loader), []);
    resetRunnerForTest(runner);
  });
});

describe('a member that concludes a passed wipe applies it and forgets its receive marks', { skip: skip || privateAddressSkipReason() }, () => {
  let mongo; let peer;
  before(async () => {
    allowEngineToDialPrivatePeers();
    peer = await startVotesPeer();
    mongo = await openTestMongo('settle_here_marks');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await peer?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  const MARKS = ['lastSeqReceived', 'lastSeqPushed', 'lastSeqServed'];
  const marked = () => ({ lastSeqReceived: { s: 50 }, lastSeqPushed: { s: 40 }, lastSeqServed: { s: 30 }, version: '1.0.0', versionCheckedAt: new Date().toISOString() });
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const wipeServed = (castAt) => ({
    roundId: 'w8', type: 'space_wipe', spaceId: 's', networkSpaceId: 's', subjectInstanceId: M1, subjectLabel: 'm1', subjectUrl: '',
    openedAt: minutesAgo(10), deadline: new Date(Date.now() + 23 * 3_600_000).toISOString(), concluded: false,
    votes: [{ instanceId: M1, vote: 'yes', ...(castAt ? { castAt } : {}) }],
  });
  const marksOf = (loader) => Object.fromEntries(MARKS.map(k => [k, loader.getConfig().networks[0].members[0][k]?.s]));

  // The late joiner of W11: the network is NEWER than the yes that passed the wipe. v4 skipped this wipe and lifted the proposer's hold over data
  // that then refilled the network. v5 never skips: castAt is unsigned and a relayer can move it, and a cast with none is stamped with the receive time.
  for (const [what, castAt, createdAt] of [
    ['a yes that predates the network (the old skip)', minutesAgo(30), new Date(Date.now() + 3_600_000).toISOString()],
    ['a yes with no castAt at all', undefined, '2026-01-01T00:00:00.000Z'],
  ]) {
    it(`R-X8a/R-X8b: ${what} — the wipe is applied and the marks of that space are forgotten (the next pull starts at seq 0)`, async () => {
      const net = club([], { createdAt }, ['general', 's']);
      net.members = [{ instanceId: M1, label: 'm1', url: peer.url, tokenHash: 'h', direction: 'both', ...marked() }];
      const loader = await boot(dir, { spaces: ['s'], networks: [net] });
      await seedFacts(mongo, 's', 3, 'pre');
      peer.serve([wipeServed(castAt)]);
      const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
      await runSyncForPeer(M1);
      const emptied = await untilOrBound(mongo, async () => (await factCount(mongo, 's')) === 0, 2500);
      assert.equal(emptied, true, 'the wipe was skipped: castAt and net.createdAt decide nothing under v5');
      // The runner (design section 2.5) does not exist on the base commit; where it does not, the marks are read as they stand, which is the defect.
      const runner = await import('../../server/dist/spaces/space-act-runner.js').catch(() => null);
      if (runner) await untilRunnerIdle(runner, loader);
      assert.deepEqual(marksOf(loader), { lastSeqReceived: undefined, lastSeqPushed: undefined, lastSeqServed: undefined },
        'the receive marks of the wiped space survived: the next pull reads from the old mark and never brings the records back (and AM4: every mark of the space, not one family)');
      if (runner) resetRunnerForTest(runner);
    });
  }

  it('R-X8c: a crash between the last batch and the completion resumes into ONE write that removes the entry, forgets the marks and applies the round', async () => {
    const runner = await requireRunner();
    const round = passedSpaceRound('w8c', 'space_wipe', 's', { networkSpaceId: 's' });
    const net = club([round], { origin: 'created' }, ['general', 's']);
    net.members = [{ instanceId: M1, label: 'm1', url: peer.url, tokenHash: 'h', direction: 'both', ...marked() }];
    const loader = await boot(dir, { spaces: ['s'], networks: [net] });
    await seedFacts(mongo, 's', 3, 'crash');
    let throwOnce = true;
    runner.setSpaceActHooksForTest({ beforeComplete: async () => { if (throwOnce) { throwOnce = false; throw new Error('crash before the completion write'); } } });
    const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
    runRoundExpiryTick(Date.now());
    await untilOrBound(mongo, async () => entriesOf(loader).some(e => e.state === 'owed'), 3000);
    assert.equal(await factCount(mongo, 's'), 0, 'the deletes had run');
    assert.equal(marksOf(loader).lastSeqReceived, 50, 'the marks were forgotten BEFORE the completion write: a crash here loses the forget for good');
    assert.equal(entriesOf(loader).length, 1, 'the entry is the debt that survives the crash');
    // The restart: the retry past its backoff re-runs the (idempotent) body and then makes the one write.
    const observations = [];
    const watch = async () => { for (let i = 0; i < 6000 && entriesOf(loader).length > 0; i++) { observations.push({ entry: entriesOf(loader).length, marks: marksOf(loader).lastSeqReceived, applied: loader.getConfig().networks[0].pendingRounds[0].appliedHere === true }); await new Promise(r => setImmediate(r)); } };
    runRoundExpiryTick(Date.now() + 3 * 3_600_000);
    await watch();
    await untilRunnerIdle(runner, loader, { now: Date.now() + 3 * 3_600_000 });
    assert.deepEqual(marksOf(loader), { lastSeqReceived: undefined, lastSeqPushed: undefined, lastSeqServed: undefined });
    assert.equal(loader.getConfig().networks[0].pendingRounds[0].appliedHere, true);
    const partial = observations.filter(o => o.entry === 0 !== (o.marks === undefined) || (o.entry === 0 !== o.applied));
    assert.deepEqual(partial, [], 'the entry, the marks and the round changed in separate writes: a crash between them leaves a hold lifted over a stale mark (DI S7)');
    resetRunnerForTest(runner);
  });
});

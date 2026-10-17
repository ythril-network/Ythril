/**
 * A space that was deleted is not added back by its own earlier addition, and a passed deletion clears the offer of the space
 * (bundle-106 R3-a, R3-b, R3-c, the VR11 alias and date rows, and R-VR12; design v5 sections 2.3 and 2.4).
 *
 * ## The defect this holds
 *
 * `applyConcludedSpaceRounds` re-applies every held passed `space_addition` with no guard, and gossip hands it every held round on every changed
 * pass. For the proposer, `spaceAdditionTarget` answers `{ localId }` whenever the network no longer carries the space, and `addSpacesToNetwork`
 * creates the space when it is gone and puts it back. So a space added and then deleted inside one voting window COMES BACK EMPTY at the next
 * pass. And a member that pulls `[addition, deletion]` in one page keeps the addition as a pending offer, because the deletion finds nothing the
 * network carries and clears nothing: accepting the offer later re-adds a space the network voted away.
 *
 * ## What each row drives
 *
 * - R3-a: both rounds passed on the proposer, the deletion applied; one settle with every held round as the retry set. The space is not
 *   re-created and not carried, the addition is `appliedHere` (so the retirement outlives the deletion's prune), and one audit entry says so.
 * - R3-b: the same two rounds pulled by a member in ONE page, in either order: no local space, not carried, and NO pending offer (VR12).
 * - R3-c (control): a deletion opened BEFORE an addition does not retire it — a re-add after a delete lands (the owner's "or even readd").
 * - VR11: a deletion from an older release has no `networkSpaceId` and names the space by its LOCAL id; it is matched to the addition through the
 *   alias table. An undatable `openedAt` retires the addition (the safe side is not re-creating a space).
 *
 * Run: node --test testing/standalone/a-deleted-space-is-not-added-back-by-its-own-addition-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, settled, startFakePeer, allowEngineToDialPrivatePeers } from './_vote-round-instance.mjs';
import { startVotesPeer } from './_vote-round-sites.mjs';
import { auditRowsOf } from './_space-act-harness.mjs';
import { SELF, M1, tempInstance, networkOf, boot, databaseTakesCollections, warmSpaceCreation } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-readd-');
const skip = await mongoSkipReason();

const yes = (instanceId) => ({ instanceId, vote: 'yes', castAt: '2026-10-09T10:01:00.000Z' });
const round = (over) => ({
  subjectInstanceId: SELF, subjectLabel: 'self', subjectUrl: '', deadline: '2099-01-01T00:00:00.000Z', votes: [yes(SELF)],
  concluded: true, passed: true, outcome: 'passed', proposedHere: true, ...over,
});
const addition = (over = {}) => round({ roundId: 'add-1', type: 'space_addition', spaceId: 's', openedAt: '2026-10-09T10:00:00.000Z', ...over });
const deletion = (over = {}) => round({ roundId: 'del-1', type: 'space_deletion', spaceId: 's', networkSpaceId: 's', openedAt: '2026-10-09T10:05:00.000Z', appliedHere: true, ...over });

/** What a settle of every held round, as the retry set, may have changed — read once the deferred effects have stopped landing. */
const observe = (loader, id = 's') => {
  const cfg = loader.getConfig();
  const net = cfg.networks[0];
  const held = (rid) => net.pendingRounds.find(r => r.roundId === rid);
  return {
    local: cfg.spaces.some(s => s.id === id), carried: net.spaces.includes(id),
    pending: (net.pendingSpaces ?? []).map(p => p.networkId), additionApplied: held('add-1')?.appliedHere === true,
  };
};

/** The retry of every held round: the gossip pass's own call, through the one settle step where it exists. */
async function settleEverything(loader, id, mongo) {
  const mod = await import('../../server/dist/networks/round-conclusion.js');
  const cfg = loader.getConfig();
  const net = cfg.networks[0];
  const held = [...net.pendingRounds];
  if (typeof mod.settleRounds === 'function') {
    // The settle's own promise covers the deferred add (design v5 section 2.2), so the state is read when the act has ended. Saved at
    // once, as every caller of the settle saves: a marking left in memory is read away by any background writer's reload.
    const out = mod.settleRounds(net, cfg, [], 'retry', Date.now(), held);
    if (out.wrote) loader.saveConfig(cfg);
    await out.settled;
    return settled(() => observe(loader, id));
  }
  // The base commit's spelling of the same retry. Its deferred add (a dynamic import, then createSpace against Mongo, which builds the space's
  // indexes) is not awaitable and takes a second or more, so the defect is waited FOR — until the space appears — within a bound of database
  // round trips, never a delay. A space that never appears within the bound is the rule holding.
  mod.applyRoundConclusion(net, cfg, [], 'retry', held);
  for (let i = 0; i < 6000 && !observe(loader, id).local; i++) await mongo.getDb().command({ ping: 1 });
  return observe(loader, id);
}

describe('R3: a space deleted after its addition is not added back', { skip }, () => {
  let mongo;
  before(async () => { mongo = await openTestMongo('readd'); await databaseTakesCollections(mongo); await boot(dir, { networks: [] }); await warmSpaceCreation(); });
  after(async () => { await closeTestMongo(); });

  /** A club that no longer carries `s`, holding `rounds`; this instance has no local `s` either (the deletion removed it). */
  const proposer = (rounds, extra = {}) => boot(dir, {
    spaces: [], networks: [networkOf('club', [M1], { spaces: ['general'], extra: { pendingRounds: rounds, ...extra } })],
  });

  it('R3-a: the held addition is retired by the held deletion — not re-created, not carried, applied, audited once', async () => {
    const loader = await proposer([addition(), deletion()]);
    const got = await settleEverything(loader, 's', mongo);
    assert.deepEqual({ local: got.local, carried: got.carried }, { local: false, carried: false }, 'the deleted space came back at the next gossip pass');
    assert.equal(got.additionApplied, true, 'the addition is not marked appliedHere, so it will be tried again and its retirement is lost with the deletion\'s prune');
    const audit = await import('../../server/dist/audit/middleware.js');
    assert.equal(typeof audit.ROUND_ADDITION_RETIRED_OPERATION, 'string', 'server/src/audit/middleware.ts does not export ROUND_ADDITION_RETIRED_OPERATION (design v5 section 2.3: every retirement is audited)');
    // The audit write is queued, not awaited: poll for the entry (bounded by turns), then count — a read made at once is not a zero.
    await auditRowsOf(mongo, audit.ROUND_ADDITION_RETIRED_OPERATION, { atLeast: 1 });
    const rows = (await mongo.col('audit_log').find({}).toArray()).filter(r => JSON.stringify(r).includes(audit.ROUND_ADDITION_RETIRED_OPERATION));
    assert.equal(rows.length, 1, 'one audit entry per retired addition');
  });

  it('R3-a: the order the rounds are held in changes nothing', async () => {
    const loader = await proposer([deletion(), addition()]);
    const got = await settleEverything(loader, 's', mongo);
    assert.deepEqual({ local: got.local, carried: got.carried, applied: got.additionApplied }, { local: false, carried: false, applied: true });
  });

  it('R3-c (control): a deletion opened BEFORE the addition does not retire it — the re-add lands', async () => {
    const loader = await proposer([deletion({ openedAt: '2026-10-09T09:00:00.000Z' }), addition()]);
    const got = await settleEverything(loader, 's', mongo);
    assert.deepEqual({ local: got.local, carried: got.carried }, { local: true, carried: true }, 'a re-add after a delete must land');
  });

  it('VR11: a deletion from an older release names the space by its LOCAL id; the alias table matches it to the addition', async () => {
    // The network calls it 'shared'; this instance calls it 'mine'. The older deletion has no networkSpaceId and spaceId 'mine'.
    const loader = await proposer(
      [addition({ spaceId: 'shared' }), deletion({ spaceId: 'mine', networkSpaceId: undefined })],
      { spaceMap: { shared: 'mine' } },
    );
    const got = await settleEverything(loader, 'mine', mongo);
    assert.deepEqual({ local: got.local, carried: got.carried, applied: got.additionApplied }, { local: false, carried: false, applied: true },
      'a deletion that names the space by its local id did not retire the addition that names it by the network id');
  });

  it('VR11: an undatable openedAt on the deletion retires the addition (the safe side)', async () => {
    const loader = await proposer([addition(), deletion({ openedAt: 'not a date' })]);
    const got = await settleEverything(loader, 's', mongo);
    assert.deepEqual({ local: got.local, carried: got.carried, applied: got.additionApplied }, { local: false, carried: false, applied: true });
  });
});

describe('R3-b and R-VR12: a member that pulls the addition and the deletion together keeps no offer of the space', { skip: skip || privateAddressSkipReason() }, () => {
  let peer;
  let mongo;
  before(async () => { allowEngineToDialPrivatePeers(); peer = await startVotesPeer(); mongo = await openTestMongo('readd_member'); await databaseTakesCollections(mongo); });
  after(async () => { await peer?.close(); await closeTestMongo(); removeInstanceDir(dir); });

  // A round a peer serves must satisfy adoption: its deadline is within the cap of its openedAt and not past.
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const served = ({ openedMinutesAgo, ...over }) => ({
    subjectInstanceId: M1, subjectLabel: 'm1', subjectUrl: '', openedAt: minutesAgo(openedMinutesAgo), deadline: new Date(Date.now() + 23 * 3_600_000).toISOString(),
    votes: [{ instanceId: M1, vote: 'yes', castAt: minutesAgo(openedMinutesAgo - 1) }], concluded: false, ...over,
  });
  /** A member of a club created by M1 (below the version floor, so the cycle ends after governance has been exchanged). */
  const member = (extra = {}) => boot(dir, {
    spaces: [],
    networks: [networkOf('club', [], {
      spaces: ['general'], extra: { origin: 'joined', members: [{ instanceId: M1, label: 'm1', url: peer.url, tokenHash: 'h', direction: 'both', version: '1.0.0', versionCheckedAt: '2026-10-09T09:00:00.000Z' }], ...extra },
    })],
  });

  for (const order of ['addition first', 'deletion first']) {
    it(`R3-b: [${order}] in one page — no local space, not carried, no pending offer`, async () => {
      const loader = await member();
      const add = served({ roundId: 'add-1', type: 'space_addition', spaceId: 's', openedMinutesAgo: 10 });
      const del = served({ roundId: 'del-1', type: 'space_deletion', spaceId: 's', networkSpaceId: 's', openedMinutesAgo: 5 });
      peer.serve(order === 'addition first' ? [add, del] : [del, add]);
      const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
      await runSyncForPeer(M1);
      // The addition is held as a pending offer in a deferred step (a dynamic import): the defect is waited FOR within a bound of round trips.
      for (let i = 0; i < 1500 && observe(loader).pending.length === 0; i++) await mongo.getDb().command({ ping: 1 });
      const got = await settled(() => observe(loader));
      assert.deepEqual({ local: got.local, carried: got.carried }, { local: false, carried: false });
      assert.deepEqual(got.pending, [], 'the member keeps an offer of a space the network deleted: accepting it later re-adds a space the network voted away');
    });
  }

  it('R-VR12: a passed deletion clears the pending offer of a space this member never carried, and the round is applied', async () => {
    const loader = await member({ pendingSpaces: [{ networkId: 's', localId: 's', why: 'announced', from: M1, at: '2026-10-09T10:00:00.000Z' }] });
    peer.serve([served({ roundId: 'del-1', type: 'space_deletion', spaceId: 's', networkSpaceId: 's', openedMinutesAgo: 5 })]);
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(M1);
    const got = await settled(() => observe(loader));
    assert.deepEqual(got.pending, [], 'the pending offer survived the deletion of its space (VR12)');
    const held = loader.getConfig().networks[0].pendingRounds.find(r => r.roundId === 'del-1');
    assert.equal(held?.appliedHere, true, 'a deletion this instance has nothing to do for is settled: nothing owed here, the offer is cleared');
  });
});

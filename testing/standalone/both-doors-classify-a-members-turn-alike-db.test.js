/**
 * Both sync doors classify a member's turn ALIKE: one outcome, one effect on the failure counter, whichever door ran it
 * (bundle-39, Q-220 and Q-265's member-outcome half; plan D1 with the v2, v3 and v6 corrections).
 *
 * ## The defect
 *
 * A member's turn ended in one of several ways and the two doors that run it read them differently. The SCHEDULED door
 * (`engine.runSyncForNetwork`, what a cron tick and `network_sync` run) threw on any transfer that stopped early and counted
 * the member a failure; the MANUAL door (`engine.runSyncForPeer`) discarded what the turn returned and reset the counter, so
 * a peer that answered 500 every cycle never raised PEER UNREACHABLE from a manual sync, and a database fault on THIS
 * instance, caught while landing a pulled page, was counted against the PEER on the scheduled door (the operator was sent to
 * look at the network for a fault in their own store). Neither door said which of those had happened.
 *
 * ## The rule (what each case asserts, on BOTH doors, from `consecutiveFailures` seeded at 5)
 *
 * The member's outcome (`members[]` of the answer: `{ networkId, instanceId, label, outcome, reason }`) and its effect on the counter:
 *
 *  | fault                                                      | outcome          | counter |
 *  |------------------------------------------------------------|------------------|---------|
 *  | a local record write fails while a pulled page lands       | local-fault      | 0 (the peer ANSWERED: the page parsed) |
 *  | the store read at the top of the turn fails (positions)    | local-fault      | 5 (nothing was asked of the peer) |
 *  | no token stored for the peer (S10)                         | local-fault      | 5 |
 *  | the pull stops at the cycle cap                            | catching-up      | 0 |
 *  | the peer answers 500                                       | failed           | 6 |
 *  | the peer is below the version floor (`PeerBelowFloor`)     | peer-too-old     | 5 |
 *  | the peer answers a page in the 5.x shape (`PeerPagesBySeq`)| peer-too-old     | 5 |
 *  | the peer answers the push and refuses records              | records-refused  | 0 |
 *
 * On the SCHEDULED door only (the manual door writes neither): the cycle's history status and `ythril_sync_cycles_total{status}`
 * are the same word, `failed` for a cycle whose only member is failed or local-fault, `partial` for catching-up and
 * records-refused, `refused` for a peer too old (the history stops mapping it to `failed`).
 *
 * Also: a full re-read is not closed over a page that failed to land (`pullEnded`, D1 v2), and a local-fault STREAK of 3 turns the
 * network chip `degraded` although the counter resets (the lasting local fault stays visible, D1 v6 S7).
 *
 * ## How red shows
 *
 * Each case compares ONE object (`outcome`, `failures`, and on the scheduled door `history` and `metric`) with the expected one, so a
 * red run prints every wrong field at once: on the base the scheduled door counts a local fault `failures: 6` and the manual door
 * counts a peer that answered 500 `failures: 0`, and neither answer carries `members[]`, so `outcome` reads `(no members[] on the answer)`.
 * The re-read case's "stays catching" assertion holds at the base (a landing failure already ends the pull as incomplete there); it is the
 * regression guard for the design that moves local faults out of `incomplete`, and its `outcome` field is the red part.
 *
 * Faults are real where the store can be made to fail (the record write is the MongoNetworkError injection of
 * `a-pulled-page-lands-by-the-receivers-rules-db.test.js`); the read fault is the same error on the one counter read a turn starts with.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/both-doors-classify-a-members-turn-alike-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoNetworkError } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, readMark, setMark, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'bothdoors';
const SENTINEL = 3;
const SEEDED = 5;
/** Positions well above the sentinel. */
const BASE = 100;
const WRITE_METHODS = ['bulkWrite', 'replaceOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'findOneAndReplace', 'findOneAndUpdate'];

let door, engine, loader, syncCyclesTotal, forgetPositionsReady, fullReread, networkStatus, proto, ME;

/** Wrap `methods` of the collection prototype: a call on `collectionName` rejects with a store connection error. Returns `{ fired, restore }`. */
function injectStoreFault(methods, collectionName) {
  const originals = Object.fromEntries(methods.map(m => [m, proto[m]]));
  let fired = 0;
  for (const m of methods) {
    proto[m] = function faulty(...args) {
      if (this.collectionName === collectionName) { fired++; return Promise.reject(new MongoNetworkError('injected: connection reset')); }
      return originals[m].apply(this, args);
    };
  }
  return { fired: () => fired, restore: () => { Object.assign(proto, originals); } };
}

/** `facts` pages of ONE record each from the real handler (the cycle cap is 50 pages, so a peer holding more is read to the cap). */
function pagedAtOne() {
  return async (req, res, family) => {
    if (family === 'facts') Object.defineProperty(req, 'query', { value: { ...req.query, limit: '1' }, writable: true, configurable: true, enumerable: true });
    await door.serveFamily(req, res, family);
  };
}

const statusCount = async (status) => {
  const { values } = await syncCyclesTotal.get();
  return values.filter(v => v.labels.network === door.NET && v.labels.status === status).reduce((n, v) => n + v.value, 0);
};
const failures = () => door.member().consecutiveFailures ?? 0;
const factsSeed = (ids) => ids.map((id, i) => positioned(build.fact(S, id, BASE + i + 1, { author: PEER_AUTHOR })));

/** What the member's turn came to, read off an answer's `members[]`. */
function memberOf(out) {
  const mine = (Array.isArray(out?.members) ? out.members : []).filter(m => m.instanceId === PEER && m.networkId === door.NET);
  return mine.length === 1 ? mine[0] : undefined;
}
const NO_MEMBERS = '(no members[] entry for the peer on the answer)';

/**
 * Both doors, each as production runs it. `scheduled` is the network cycle (`runSyncForNetwork`) and reads the history row and the cycle metric
 * it wrote; `manual` is `runSyncForPeer` and writes neither.
 */
const DOORS = {
  async scheduled() {
    const since = new Date().toISOString();
    const before = { success: await statusCount('success'), partial: await statusCount('partial'), failed: await statusCount('failed'), refused: await statusCount('refused') };
    const out = await engine.runSyncForNetwork(door.NET);
    await door.settled();
    let row;
    await waitFor(async () => {
      row = (await door.mongo.col('_sync_history').find({ networkId: door.NET, triggeredAt: { $gte: since } }).toArray())[0];
      return row !== undefined;
    }, 10_000, 100, undefined, { what: 'the sync history row of the cycle' });
    const metric = {};
    for (const status of Object.keys(before)) { const d = await statusCount(status) - before[status]; if (d !== 0) metric[status] = d; }
    return { out, history: row.status, historyErrors: row.errors ?? [], metric };
  },
  async manual() {
    return { out: await door.sync() };
  },
};

/**
 * One case = what to install, the fault to cause, and what each door must say. `expect` is the member outcome and the counter; `scheduled` is what only
 * the scheduled door can show (the history word and the metric word, one cycle counted under it).
 */
const CASES = [
  {
    name: 'a local record write fails while a pulled page lands',
    direction: 'pull',
    expect: { outcome: 'local-fault', failures: 0 },
    scheduled: { history: 'failed', metric: { failed: 1 }, errorNamesThisInstance: true },
    async seed() { await door.seedPeerRecords(S, 'facts', factsSeed(['wf-1', 'wf-2'])); door.state.family = door.serveFamily; },
    async withFault(run) {
      const fault = injectStoreFault(WRITE_METHODS, `${S}_facts`);
      try { return await run(); } finally {
        fault.restore();
        assert.ok(fault.fired() > 0, 'fixture check: the injected write fault was never reached — the page was not written');
      }
    },
    async after() {
      assert.ok((readMark(door, 'received', S) ?? 0) < BASE + 1, `the receive mark moved to ${String(readMark(door, 'received', S))}, past a page that never landed`);
      assert.equal(await door.coll(S, 'facts').countDocuments({}), 0, 'fixture check: something landed');
    },
  },
  {
    name: 'the store read at the top of the turn fails (positions-ready), before the peer is asked for anything',
    direction: 'pull',
    expect: { outcome: 'local-fault', failures: SEEDED },
    scheduled: { history: 'failed', metric: { failed: 1 }, errorNamesThisInstance: true },
    async seed() { await door.seedPeerRecords(S, 'facts', factsSeed(['rf-1'])); door.state.family = door.serveFamily; forgetPositionsReady(S); },
    async withFault(run) {
      const fault = injectStoreFault(['findOne'], 'ythril_counters');
      try { return await run(); } finally {
        fault.restore();
        assert.ok(fault.fired() > 0, 'fixture check: the injected counter read fault was never reached — the turn did not read the positions marker');
        forgetPositionsReady(S);
      }
    },
    async after() { assert.equal(door.state.familyRequests.length, 0, 'the peer was asked for a page after this instance\'s own store failed'); },
  },
  {
    name: 'no token is stored for the peer on this instance (S10)',
    direction: 'pull',
    expect: { outcome: 'local-fault', failures: SEEDED },
    scheduled: { history: 'failed', metric: { failed: 1 }, errorNamesThisInstance: false },
    async seed() { door.state.family = door.serveFamily; },
    async withFault(run) {
      const tokens = loader.getSecrets().peerTokens;
      const held = tokens[PEER];
      assert.ok(held, 'fixture check: the door stores no token for the peer');
      delete tokens[PEER];
      try { return await run(); } finally { tokens[PEER] = held; }
    },
  },
  {
    name: 'the pull stops at the cycle cap (catching up)',
    direction: 'pull',
    expect: { outcome: 'catching-up', failures: 0 },
    scheduled: { history: 'partial', metric: { partial: 1 }, errorNamesThisInstance: false },
    async seed() {
      await door.seedPeerRecords(S, 'facts', factsSeed(Array.from({ length: 120 }, (_, i) => `cap-${String(i + 1).padStart(3, '0')}`)));
      door.state.family = pagedAtOne();
    },
    async after() {
      const have = await door.coll(S, 'facts').countDocuments({});
      assert.ok(have > 0 && have < 120, `control: ${have} of 120 records landed: the cycle did not stop at the cap with records left, so this is not a capped pull`);
    },
  },
  {
    name: 'the peer answers 500 on a page',
    direction: 'pull',
    expect: { outcome: 'failed', failures: SEEDED + 1 },
    scheduled: { history: 'failed', metric: { failed: 1 }, errorNamesThisInstance: false },
    async seed() {
      await door.seedPeerRecords(S, 'facts', factsSeed(['p5-1', 'p5-2']));
      door.state.family = async (req, res, family) => {
        if (family === 'facts') { res.status(500).json({ error: 'the peer failed on this page' }); return; }
        await door.serveFamily(req, res, family);
      };
    },
  },
  {
    name: 'the peer is below the version floor (PeerBelowFloor)',
    direction: 'pull',
    expect: { outcome: 'peer-too-old', failures: SEEDED },
    scheduled: { history: 'refused', metric: { refused: 1 }, errorNamesThisInstance: false },
    async seed() { door.state.family = door.serveFamily; door.member().version = '5.0.0'; },
    async after() { assert.equal(door.state.familyRequests.length, 0, 'a page was requested from a peer below the floor'); },
  },
  {
    name: 'the peer answers a page in the 5.x shape (PeerPagesBySeq)',
    direction: 'pull',
    expect: { outcome: 'peer-too-old', failures: SEEDED },
    scheduled: { history: 'refused', metric: { refused: 1 }, errorNamesThisInstance: false },
    // A 5.x page: no `through`, no `head`, no `positions` stamp.
    async seed() { door.state.family = (_req, res) => { res.json({ items: [], nextCursor: null }); }; },
  },
  {
    name: 'the peer answers the push and refuses the records (records refused by the receiver\'s rules)',
    direction: 'push',
    expect: { outcome: 'records-refused', failures: 0 },
    scheduled: { history: 'partial', metric: { partial: 1 }, errorNamesThisInstance: false },
    async seed() {
      await door.coll(S, 'facts').insertOne(positioned(build.fact(S, 'refused-1', 30, { author: ME }), { writtenHere: true }));
      await door.raiseVersionTo(S, 30);
      setMark(door, 'pushed', S, SENTINEL);
      door.state.batchUpsert = (key) => (key === 'facts' ? { body: { facts: { rejected: 1 } } } : undefined);
    },
  },
];

describe('both doors classify a member\'s turn alike', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b39A_both', spaces: [S], direction: 'pull' });
    engine = await import('../../server/dist/sync/engine.js');
    loader = await import('../../server/dist/config/loader.js');
    ({ syncCyclesTotal } = await import('../../server/dist/metrics/registry.js'));
    ({ forgetPositionsReady } = await import('../../server/dist/sync/positions-ready.js'));
    fullReread = await import('../../server/dist/sync/full-reread.js');
    networkStatus = await import('../../server/dist/spaces/network-status.js');
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await door?.close(); });
  afterEach(() => { delete door.member().version; });

  async function fresh(direction) {
    await door.reset({ direction });
    clearPositionMarks(door);
    door.member().consecutiveFailures = SEEDED;
    forgetPositionsReady(S);
  }

  for (const [doorName, run] of Object.entries(DOORS)) {
    describe(`the ${doorName} door`, () => {
      for (const c of CASES) {
        it(`${c.name}: ${c.expect.outcome}, counter ${SEEDED} -> ${c.expect.failures}`, async () => {
          await fresh(c.direction);
          await c.seed();
          if (c.direction === 'pull') setMark(door, 'received', S, SENTINEL);
          const got = await (c.withFault ?? ((f) => f()))(() => run());
          await c.after?.();
          const actual = { outcome: memberOf(got.out)?.outcome ?? NO_MEMBERS, failures: failures() };
          const expected = { ...c.expect };
          if (doorName === 'scheduled') {
            actual.history = got.history; actual.metric = got.metric;
            expected.history = c.scheduled.history; expected.metric = c.scheduled.metric;
          }
          assert.deepEqual(actual, expected,
            `${doorName} door, ${c.name}: the member's outcome and the failure counter (seeded at ${SEEDED}) are not what the rule says`);
          if (doorName === 'scheduled' && c.scheduled.errorNamesThisInstance) {
            assert.ok(got.out.errors >= 1, `a turn that did not complete is counted in the cycle's errors (got ${got.out.errors})`);
            assert.ok(got.historyErrors.some(e => /this instance/i.test(e)),
              `the history's errors do not say the failure was this instance's own: ${JSON.stringify(got.historyErrors)}`);
          }
          const m = memberOf(got.out);
          if (m) {
            assert.equal(typeof m.reason, 'string', 'the member entry carries no reason sentence');
            assert.ok(m.label && m.networkId === door.NET, `the member entry does not name the member: ${JSON.stringify(m)}`);
          }
        });
      }

      it('a full re-read is not closed over a page that failed to land, and is closed once the page lands', async () => {
        await fresh('pull');
        await door.seedPeerRecords(S, 'facts', factsSeed(['rr-1', 'rr-2']));
        door.state.family = door.serveFamily;
        assert.equal(fullReread.requestFullReread(door.NET, [S]), 1, 'fixture check: the re-read was not requested');
        const fault = injectStoreFault(WRITE_METHODS, `${S}_facts`);
        let got;
        try { got = await run(); } finally { fault.restore(); }
        assert.ok(fault.fired() > 0, 'fixture check: the injected write fault was never reached');
        const during = { outcome: memberOf(got.out)?.outcome ?? NO_MEMBERS, state: fullReread.fullRereadStateOf(door.NET, PEER, S) };
        assert.deepEqual(during, { outcome: 'local-fault', state: 'catching' },
          'a re-read whose page failed to land on THIS instance was closed (or the member was not told as a local fault): the pages it never stored would never be read again');
        const healed = await run();
        assert.equal(await door.coll(S, 'facts').countDocuments({}), 2, 'fixture check: the healed cycle did not land the page');
        assert.equal(fullReread.fullRereadStateOf(door.NET, PEER, S), undefined, 'the re-read stayed owed after a cycle that read every page');
        assert.equal(memberOf(healed.out)?.outcome ?? NO_MEMBERS, 'success');
      });

      it('a local-fault streak of 3 turns the network chip degraded though the counter resets, and a clean turn clears it', async () => {
        await fresh('pull');
        door.member().consecutiveFailures = 0;
        await door.seedPeerRecords(S, 'facts', factsSeed(['st-1']));
        door.state.family = door.serveFamily;
        // The door's network row carries no open rounds, which the chip reads.
        for (const n of door.config().networks) n.pendingRounds ??= [];
        const chip = () => networkStatus.spaceNetworkInfo(door.config().networks, S, () => false, door.instanceId)?.networkStatus;
        const fault = injectStoreFault(WRITE_METHODS, `${S}_facts`);
        const seen = [];
        try {
          for (let i = 1; i <= 3; i++) { await run(); seen.push({ turn: i, chip: chip(), failures: failures() }); }
        } finally { fault.restore(); }
        assert.ok(fault.fired() >= 3, 'fixture check: the write fault was not reached on every turn');
        assert.deepEqual(seen, [
          { turn: 1, chip: 'idle', failures: 0 },
          { turn: 2, chip: 'idle', failures: 0 },
          { turn: 3, chip: 'degraded', failures: 0 },
        ], 'three turns in a row that could not land the peer\'s page must read as a failing local store (chip degraded) without counting the peer as failing (counter 0)');
        await run();
        assert.equal(await door.coll(S, 'facts').countDocuments({}), 1, 'fixture check: the healed turn did not land the page');
        assert.equal(chip(), 'idle', 'a turn with no local fault did not clear the streak');
      });
    });
  }
});

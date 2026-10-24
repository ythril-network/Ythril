/**
 * A mark a network's exchange records stays on that network's member row; only the mark a PEER's request fixes is written on every
 * network that carries the space (bundle-81, design rev 8 §6 "Mark writers stay per network", decision 12; §9 test 22).
 *
 * ## The defect it guards (data-integrity S5)
 *
 * `setMemberSpaceMark` (`sync/member-space-mark.ts`) writes a member's row in EVERY network that carries the space. The received and
 * pushed marks are written on one network's row (`sync/space-exchange.ts`). A club pushes only the records written here
 * (`writtenHere`), and a braintree network pushes everything it holds, relayed rows included. One peer that sits in both, with a club
 * push moving the braintree row's `lastPosPushed` too, would have the braintree network believe it had pushed the relayed rows the club
 * never sent: they would never be pushed on the braintree network.
 *
 * ## The rule (6.0)
 *
 * `setMemberSpaceMark` takes a REQUIRED scope, `{ networkId }` or `'every-network'`. The pushed and received marks pass their
 * network; the served fold, which is per peer token and not per network, passes `'every-network'`.
 *
 * ## What the cases assert
 *
 * One peer is a member of a club and of a braintree network that carry the same space (the braintree member is pull-only, so only
 * the club pushes in the first cycle; both rows' pushed marks start at the SENTINEL):
 *
 * 1. The club push moves the CLUB row's `lastPosPushed` above the sentinel, and the braintree row's is still exactly the sentinel.
 * 2. The club pushed the record written here and not the relayed one (the positive control that the club's selection is the one under
 *    test), and when the braintree member is then allowed to push, the relayed record IS offered: the braintree mark stayed below it.
 * 3. The served fold: the peer's tombstone pull from a position records `lastPosServed` on BOTH rows, because that mark belongs to the
 *    peer token and not to a network.
 *
 * ## Red at 9a7ab3f7
 *
 * The marks are asserted under their 6.0 names, which nothing writes at base: cases 1 and 3 fail on the club row's mark not moving. The
 * per-network half already holds at base for `lastSeqPushed` (its writer is per network), so the braintree-row assertion and case 2's
 * second half PASS at base: they guard the refactor onto `setMemberSpaceMark`, whose default is every network.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/mark-writers-stay-in-their-network-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_LABEL } from './_pull-door.mjs';
import { openWireProxy } from './_b81b-wire.mjs';
import { MARK, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'marksnet';
const SENTINEL = 3;
const SERVED_FROM = 1000;

let door, proxy, ME, CLUB, BRAINTREE;

/** This peer's member row on one network, live. */
const rowOn = (netId) => door.config().networks.find(n => n.id === netId).members.find(m => m.instanceId === PEER);
const markOn = (netId, kind) => rowOn(netId)[MARK[kind]]?.[S];

/** One cycle of every network the peer is in; the record ids it was sent. */
async function cycle() {
  const sent = door.state.pushedRecords.length;
  await door.sync();
  return door.state.pushedRecords.slice(sent).map(r => r._id);
}

/** A GET of the real tombstone handler as the peer's own token reaches it (the served fold reads the token's peer id). */
async function pullTombstonesAs(peerId, query) {
  const req = { method: 'GET', query: { full: 'true', ...query }, params: {}, authToken: peerToken(peerId), get: () => undefined };
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await door.handler('get', '/tombstones')(req, res);
  return res;
}

describe('a mark writer stays in its network', { skip }, () => {
  before(async () => {
    // The CLUB is the door's own network: the peer pushes and pulls there. The braintree network is added beside it, with the
    // same member and the same space; its member is pull-only until a case says otherwise.
    door = await openPullDoor({ suite: 'b81tB_marks', spaces: [S], direction: 'both', type: 'club' });
    proxy = await openWireProxy(door.url, { mode: '6.0' });
    door.member().url = proxy.url;
    CLUB = door.NET;
    BRAINTREE = 'b81tB_marks-braintree';
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => { await proxy?.close(); await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'both' });
    const cfg = door.config();
    cfg.networks = cfg.networks.filter(n => n.id !== BRAINTREE);
    cfg.networks.push({
      id: BRAINTREE, label: 'Braintree beside the club', type: 'braintree', spaces: [S], votes: [], votingDeadlineHours: 24,
      myParentInstanceId: 'marks-some-parent',
      members: [{ instanceId: PEER, label: PEER_LABEL, url: proxy.url, tokenHash: 'x', direction: 'pull' }],
    });
    for (const netId of [CLUB, BRAINTREE]) {
      const row = rowOn(netId);
      for (const key of Object.values(MARK)) delete row[key];
      row[MARK.pushed] = { [S]: SENTINEL };
    }
    door.state.family = door.serveFamily;
    proxy.clear();
  });

  it('the networks and the marks are as the cases assume', () => {
    assert.equal(door.config().networks.find(n => n.id === CLUB).type, 'club');
    assert.equal(door.config().networks.find(n => n.id === BRAINTREE).type, 'braintree');
    assert.equal(markOn(CLUB, 'pushed'), SENTINEL);
    assert.equal(markOn(BRAINTREE, 'pushed'), SENTINEL);
  });

  it('a club push moves the club row\'s lastPosPushed only: the braintree row\'s stays at its sentinel', async () => {
    await door.coll(S, 'facts').insertOne(positioned(build.fact(S, 'marks-own', 60, { author: ME }), { writtenHere: true }));
    await door.raiseVersionTo(S, 60);
    const sent = await cycle();
    assert.ok(sent.includes('marks-own'), `control: the club did not push the record written here (${sent.join(', ') || 'nothing'})`);
    const club = markOn(CLUB, 'pushed');
    assert.ok(Number.isSafeInteger(club) && club > SENTINEL, `the club row's lastPosPushed is ${String(club)}: a club push left it at the sentinel ${SENTINEL}`);
    assert.equal(markOn(BRAINTREE, 'pushed'), SENTINEL,
      `the braintree row's lastPosPushed is ${String(markOn(BRAINTREE, 'pushed'))}: a club push moved a mark of a network that has not pushed`);
  });

  it('the relayed record the club never sent is still pushed by the braintree network once its member may push', async () => {
    await door.coll(S, 'facts').insertMany([
      positioned(build.fact(S, 'marks-own', 60, { author: ME }), { writtenHere: true }),
      // Relayed here from another instance by this peer: a club does not push it, a braintree network does.
      positioned(build.fact(S, 'marks-relayed', 70, { author: { instanceId: 'marks-elsewhere', instanceLabel: 'Elsewhere' } }),
        { writtenHere: false, deliveredBy: PEER }),
    ]);
    await door.raiseVersionTo(S, 70);
    const first = await cycle();
    assert.ok(first.includes('marks-own'), `control: the club did not push the record written here (${first.join(', ') || 'nothing'})`);
    assert.ok(!first.includes('marks-relayed'), 'the club pushed a record it did not write: the club selection is not what this case assumes');

    rowOn(BRAINTREE).direction = 'both';
    const second = await cycle();
    assert.ok(second.includes('marks-relayed'),
      'the braintree network never offered the relayed record: the club push moved the braintree row\'s mark past it, so it is not pushed on that network');
  });

  it('the served fold writes the peer token\'s mark on every network that carries the space', async () => {
    const res = await pullTombstonesAs(PEER, { spaceId: S, afterPos: String(SERVED_FROM) });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.deepEqual({ club: markOn(CLUB, 'served'), braintree: markOn(BRAINTREE, 'served') }, { club: SERVED_FROM, braintree: SERVED_FROM },
      'lastPosServed belongs to the peer token, not to a network: both rows record it');
  });
});

/**
 * A 6.0 instance that is answered in the 5.x shape ends that member's turn: it writes no mark, calls no file route, counts no
 * member failure, and shows the member as too old, though the member never gossiped a version (bundle-81, P1b and P1c; design
 * rev 8 §6 "P1's gaps closed by the wire", decisions 6 and 23; §9 test 12).
 *
 * ## The defect it closes
 *
 * 6.0 pages by position. A 5.x peer answers a page without `through`, `head` and `positions`, and a push without `positions: 1`. The
 * floor check (`peerFloorRefusal`) knows a member only by a version it gossiped, so a member before its first gossip, or a peer
 * token bound to no member, passes it. A refusal returned as a page status leaves the turn going (`syncFiles` then runs); a
 * 200 push answer without the stamp, read as success, moved the push mark and wrote a mark from an answer that says nothing about
 * positions (a NaN), or re-sent the whole push set every cycle.
 *
 * ## The rule (6.0)
 *
 * Both parsers of `sync/wire-answer.ts` THROW `PeerPagesBySeq` on an answer without the 6.0 shape. The engine has its own catch branch
 * for it: the turn ends (every space of the member, the file stream and the byte routes included), no mark is written, the member's
 * failure count does not move (Q-59: a refusal is not a failure), `ythril_sync_cycles_total{status="refused"}` counts it, and the member
 * shows "Version too old" in the network view (`belowFloor`).
 *
 * ## What each case asserts
 *
 * Three answers, each from a peer that has never gossiped a version: a 5.x PAGE answer (the pull leg), a 5.x batch-upsert answer and a
 * 5.x tombstone-POST answer (the push leg; the single-document POST has no sender in this client, so its stamp is a door's and is held
 * by `testing/sync/sync-api.test.js`). For each, the same peer data runs first in the 6.0 shape as the POSITIVE CONTROL (the cycle
 * does reach the file routes, and the mark moves), then in the 5.x shape:
 *
 * - the mark is exactly its SENTINEL, not NaN, not moved;
 * - the peer was asked for no `/api/sync/manifest`, `/api/sync/file-tombstones` or `/api/files/` route after the answer;
 * - the member's `consecutiveFailures` is 0;
 * - the cycle is counted `refused`, and `networkView` gives the member a `belowFloor` sentence.
 *
 * The 5.x answers are made by `_b81b-wire.mjs` in front of the shared fake peer, which is not edited.
 *
 * ## Red at 9a7ab3f7
 *
 * Base accepts the 5.x answer as an ordinary one: the file routes ARE called (the manifest request is on the wire), nothing is counted
 * `refused`, and `belowFloor` is null. The file-route control and the failure-count assertion hold at base (a control is meant to); the mark control fails at base on the missing `lastPos*` names, like every mark assertion of this bundle.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-5x-answer-ends-the-members-turn-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openWireProxy } from './_b81b-wire.mjs';
import { MARK, readMark, setMark, clearPositionMarks, positioned, positionedTombstone } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'fivex';
const SENTINEL = 3;
/** Every route a turn reaches only after its record transfer: the manifest, the file-tombstone stream and the byte routes. */
const FILE_ROUTES = ['/api/sync/manifest', '/api/sync/file-tombstones', '/api/files/'];

let door, proxy, snapshot, ME, networkView, syncCyclesTotal, engine;

/** One cycle of the whole network, as the scheduler runs it: the one that counts a member failure and a cycle status (`runSyncForPeer` counts neither). */
const networkCycle = async () => { await engine.runSyncForNetwork(door.NET); await door.settled(); };

/** What one case seeds, and the leg and mark it is about. */
const CASES = [
  {
    name: 'a 5.x PAGE answer', direction: 'pull', kind: 'received',
    seed: async () => { await door.seedPeerRecords(S, 'facts', [positioned(build.fact(S, 'fivex-page', 30, { author: PEER_AUTHOR }))]); },
  },
  {
    name: 'a 5.x batch-upsert answer', direction: 'push', kind: 'pushed',
    seed: async () => {
      await door.coll(S, 'facts').insertOne(positioned(build.fact(S, 'fivex-batch', 30, { author: ME }), { writtenHere: true }));
      await door.raiseVersionTo(S, 30);
    },
  },
  {
    name: 'a 5.x tombstone-POST answer', direction: 'push', kind: 'pushed',
    seed: async () => {
      await door.coll(S, 'tombstones').insertOne(positionedTombstone(S, 'fivex-tomb', 'fact', 30, { instanceId: door.instanceId, issuedHere: true }));
      await door.raiseVersionTo(S, 30);
    },
  },
];

const refusedCycles = async () => {
  const { values } = await syncCyclesTotal.get();
  return values.filter(v => v.labels.status === 'refused' && v.labels.network === door.NET).reduce((n, v) => n + v.value, 0);
};
const memberView = () => networkView(door.config().networks.find(n => n.id === door.NET)).members.find(m => m.instanceId === PEER);

describe('a 5.x answer ends the member\'s turn', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81tB_5x', spaces: [S], direction: 'pull', files: true });
    proxy = await openWireProxy(door.url, { mode: '6.0' });
    door.member().url = proxy.url;
    snapshot = structuredClone(door.member());
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
    engine = await import('../../server/dist/sync/engine.js');
    ({ networkView } = await import('../../server/dist/networks/network-acts.js'));
    ({ syncCyclesTotal } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await proxy?.close(); await door?.close(); });

  /** A fresh member and a clean space: what a 5.x refusal recorded on the row must not reach the next case. */
  async function fresh(direction) {
    await door.reset({ direction });
    const row = door.member();
    for (const k of Object.keys(row)) delete row[k];
    Object.assign(row, structuredClone(snapshot), { direction });
    clearPositionMarks(door);
    door.state.family = door.serveFamily;
    proxy.clear();
  }
  beforeEach(() => { proxy.state.mode = '6.0'; });

  for (const c of CASES) {
    describe(c.name, () => {
      /** The same data in the 6.0 shape: what a healthy peer does. */
      async function controlCycle() {
        await fresh(c.direction);
        await c.seed();
        setMark(door, c.kind, S, SENTINEL);
        await networkCycle();
      }
      it('control: in the 6.0 shape the same cycle reaches the file routes', async () => {
        await controlCycle();
        assert.ok(proxy.requestsTo('/api/sync/manifest').length > 0, 'control: the 6.0 cycle never asked for the manifest, so "no file route" below proves nothing');
      });
      it('control: in the 6.0 shape the same cycle moves the mark', async () => {
        await controlCycle();
        const mark = readMark(door, c.kind, S);
        assert.ok(Number.isSafeInteger(mark) && mark > SENTINEL, `control: the ${c.kind} mark is ${String(mark)} after a 6.0 cycle (it must be a finite integer above the sentinel ${SENTINEL})`);
      });

      it('in the 5.x shape: no mark, no file route, no failure counted, counted refused, shown too old', async () => {
        await fresh(c.direction);
        await c.seed();
        setMark(door, c.kind, S, SENTINEL);
        proxy.state.mode = '5.x';
        const refusedBefore = await refusedCycles();
        await networkCycle();

        const mark = readMark(door, c.kind, S);
        assert.ok(mark === SENTINEL, `the ${c.kind} mark is ${String(mark)}: a mark was written from an answer that says nothing about positions (it must be exactly ${SENTINEL})`);
        const reached = FILE_ROUTES.flatMap(p => proxy.requestsTo(p).map(r => `${r.method} ${r.path}`));
        assert.deepEqual(reached, [], 'the turn went on to the file routes after a 5.x answer: the refusal must end the member\'s whole turn (a status the turn merely notes leaves syncFiles running)');
        assert.equal(door.member().consecutiveFailures ?? 0, 0, 'a refusal was counted as a member failure (Q-59: it is not one)');
        assert.equal(await refusedCycles() - refusedBefore, 1, 'the cycle was not counted ythril_sync_cycles_total{status="refused"}');
        assert.equal(typeof memberView().belowFloor, 'string', 'the network view does not show the member as too old: belowFloor is empty for a member that never gossiped a version');
        assert.ok(String(memberView().belowFloor).length > 0);
      });
    });
  }

  it('the marks and cases are as assumed', () => {
    assert.deepEqual(Object.keys(MARK).sort(), ['pushed', 'received', 'served']);
    assert.ok(CASES.length >= 3);
  });
});

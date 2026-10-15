/**
 * Two members do not exchange a space's data across a wipe only one of them has applied, and a space a network no longer carries is not
 * exchanged at all (bundle-106, §3.3 hold, §3.4 loop, R6-a..d, R6-g, R6-h, R7-b, R-VR1, R-W10).
 *
 * ## What was true before
 *
 * After A applied a passed wipe of `s`, A's next cycle with a member M that had not wiped yet brought the data back three ways: the file manifest diff
 * downloaded every file M listed and A lacked, a merkle divergence re-read M's file rows from seq 0, and M's records above A's receive watermark were
 * pulled and kept after M's wipe deleted them on M. The other way round, A's post-wipe records were pushed to M before M wiped. And the data loop iterated
 * the carried spaces AS READ AT THE START of the cycle, so a deletion that passed in the gossip pass of the same cycle did not stop the exchange of the space it
 * removed — and its watermarks were written back after the removal had cleared them.
 *
 * ## What holds now
 *
 * - **R6-a** this instance applied a passed wipe of `s` and the peer has not concluded it: the cycle makes no manifest, no tombstone, no page and no push request
 *   for `s`, while the space it still carries is exchanged (the positive twin, in the same cycle: the absence means something only beside it).
 * - **R6-b** the peer serves the wipe concluded AND passed: the evidence is persisted on the round (`peersConcluded`) and the requests resume.
 * - **R-VR1** a peer serving `{ passed: true, concluded: false }` (an older build that adopted the round) is NOT that evidence: the hold stays.
 * - **R6-c** with merkle on and a file-row re-read owed, a held space is not re-read and not merkle-checked; its twin is.
 * - **R6-d** the peer concluded the wipe FIRST (it is open here): held (`peer concluded first`); a peer that has not concluded it is no hold at all.
 * - **R6-g** the mixed case: a club round applied here holds the space with the member of a closed network that carries it too, until that round is pruned.
 * - **R6-h** a refused vote pull records no evidence, so the hold stays; a round that cannot be read (a stored round made unreadable by hand) answers
 *   `evidence unknown` and the cycle does not fail (R-W10).
 * - **R7-b** a space removed from the network BETWEEN TWO TURNS of the cycle (the tick, the relay or a cast applies a passed deletion; the removal fires from
 *   inside the peer's answer for the first space): no request for the removed space after it, and no watermark written for it —
 *   with its positive twin: the same cycle with the space still carried sends its requests and moves its watermark.
 *
 * ## How it is driven
 *
 * `openPullDoor` (a real engine, a real Mongo layer, a fake peer over HTTP with the real page, manifest and tombstone handlers), the receiver's config
 * edited through `mutateConfig` so the hold index sees every change as a new generation. Every request the peer answers is recorded by the door; "no
 * request for `s`" is read off those logs, never off a timer.
 *
 * ## Seen red
 *
 * Against a638e702 the hold does not exist: R6-a, R6-c, R6-d, R6-g, R6-h and R-VR1 fail (the space is exchanged), R6-b fails on the missing evidence and
 * R7-b fails on the requests and the watermark sent for the removed space. The positive twins are controls that pass on purpose.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-held-space-is-not-exchanged-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'holdheld';
const FREE = 'holdfree';
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

let door, loader, merkleAsked;

/** A wipe round of `HELD` as THIS instance holds it. `over` says whether it is applied, concluded, and what else differs. */
const wipeRound = (roundId, over = {}) => ({
  roundId, type: 'space_wipe', spaceId: HELD, subjectInstanceId: door.instanceId, subjectLabel: 'x', subjectUrl: '',
  openedAt: iso(NOW - HOUR), deadline: iso(NOW + 23 * HOUR), votes: [{ instanceId: door.instanceId, vote: 'yes', castAt: iso(NOW - HOUR) }],
  concluded: true, passed: true, appliedHere: true, proposedHere: true, ...over,
});

/** What the peer serves as its rounds; `null` makes its vote list answer 500 (a refused pull). */
let served = [];

function setRounds(rounds, netId = door.NET) {
  loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === netId).pendingRounds = rounds.map(r => structuredClone(r)); });
}
const round = (id, netId = door.NET) => loader.getConfig().networks.find(n => n.id === netId).pendingRounds.find(r => r.roundId === id);

/** The peer's requests that name `space`, whatever the family: pages, tombstones, the manifest, file tombstones, merkle, and the batch pushes that carried its record. */
function requestsFor(space) {
  const s = door.state;
  const id = space === HELD ? 'held-f1' : 'free-f1';
  return {
    pages: s.familyRequests.filter(q => q.spaceId === space).length,
    tombstones: s.requests.filter(q => q.spaceId === space).length,
    manifest: s.manifestRequests.filter(q => q.spaceId === space).length,
    fileTombstones: s.fileTombstoneRequests.filter(q => q.spaceId === space).length,
    merkle: merkleAsked.filter(q => q.spaceId === space).length,
    pushes: s.batchRequests.filter(b => b.ids.includes(id)).length,
    get total() { return this.pages + this.tombstones + this.manifest + this.fileTombstones + this.merkle + this.pushes; },
  };
}

async function cycle() {
  const out = await door.sync();
  assert.equal(out.errors ?? 0, 0, `the cycle failed: ${JSON.stringify(out)}`);
  return out;
}

describe('a held space is not exchanged', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'hold', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true, lateral: false });
    loader = await import('../../server/dist/config/loader.js');
  });
  after(async () => { await door?.close(); });

  /** A clean door: reset clears the rows, the scripted hooks and the marks, so every case (and a case that starts over mid-way) calls this. */
  async function fresh() {
    await door.reset();
    served = [];
    merkleAsked = [];
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.merkle = false; net.spaces = [HELD, FREE]; net.type = 'club';
      delete net.members[0].fileMetaRereadAt;
      cfg.networks = cfg.networks.filter(n => n.id === door.NET);
    });
    door.state.family = (req, res, family) => door.serveFamily(req, res, family);
    door.state.merkle = (req, res) => { merkleAsked.push({ ...req.query }); res.json({ root: 'peer-root-differs', leafCount: 3 }); };
    door.state.network = (req, res, next) => {
      if (req.method === 'GET' && req.path === `/${door.NET}/votes`) {
        if (served === null) { res.status(500).json({ error: 'scripted refusal' }); return; }
        res.json({ rounds: served }); return;
      }
      if (req.method === 'POST' && /\/votes\//.test(req.path)) { res.json({ status: 'ok' }); return; }
      next();
    };
    // Something to push and something to pull for each space, so an exchange is visible as requests AND as moved watermarks.
    for (const [space, id] of [[HELD, 'held-f1'], [FREE, 'free-f1']]) {
      const r = await door.push('/batch-upsert', { facts: [build.fact(space, id, 3, { author: { instanceId: door.instanceId, instanceLabel: 'Receiver' } })] }, { spaceId: space, networkId: door.NET, token: ADMIN_TOKEN });
      assert.equal(r.code, 200, `seeding ${space} for the push half failed: ${JSON.stringify(r.body)}`);
      await door.seedPeerRecords(space, 'facts', [build.fact(space, `peer-${id}`, 5, { author: PEER_AUTHOR })]);
    }
    await door.settled();
  }
  beforeEach(fresh);

  it('R6-a: an applied wipe the peer has not concluded holds the space, and only that space (with the carried twin in the same cycle)', async () => {
    setRounds([wipeRound('w-a')]);
    served = [];
    await cycle();
    const held = requestsFor(HELD);
    const free = requestsFor(FREE);
    assert.ok(free.pages > 0 && free.manifest > 0 && free.pushes > 0,
      `the positive twin failed: the carried space was not exchanged either (${JSON.stringify(free)}), so an absence for ${HELD} would mean nothing`);
    assert.deepEqual({ pages: held.pages, tombstones: held.tombstones, manifest: held.manifest, fileTombstones: held.fileTombstones, pushes: held.pushes },
      { pages: 0, tombstones: 0, manifest: 0, fileTombstones: 0, pushes: 0 },
      'this instance applied a wipe of the space and the peer has not concluded it, yet the cycle exchanged it: the peer\'s pre-wipe records and files come back');
    assert.equal(door.member().lastSeqReceived?.[HELD], undefined, 'a receive watermark was written for a held space');
  });

  it('R6-b: the peer serving the wipe concluded and passed is persisted as evidence and the exchange resumes', async () => {
    setRounds([wipeRound('w-b')]);
    served = [{ ...wipeRound('w-b'), appliedHere: undefined, proposedHere: undefined }];
    await cycle();
    assert.ok(requestsFor(HELD).pages > 0 && requestsFor(HELD).manifest > 0, 'the peer concluded the wipe, yet the space is still withheld');
    assert.ok(round('w-b')?.peersConcluded?.includes(PEER),
      `the peer's conclusion is not persisted on the round (peersConcluded ${JSON.stringify(round('w-b')?.peersConcluded)}): a door that sees no vote pull cannot ask`);
  });

  it('R-VR1: a peer serving { passed: true, concluded: false } for it is not that evidence, and the hold stays', async () => {
    setRounds([wipeRound('w-vr1')]);
    served = [{ ...wipeRound('w-vr1'), concluded: false, appliedHere: undefined, proposedHere: undefined }];
    await cycle();
    assert.equal(requestsFor(HELD).total, 0, 'an older build that merely adopted the round lifted the hold on its word');
    assert.ok(!round('w-vr1')?.peersConcluded?.includes(PEER), 'a copy that is not concluded was recorded as evidence of a conclusion');
    assert.ok(requestsFor(FREE).pages > 0, 'the cycle did not run the data plane at all (the twin)');
  });

  it('R6-c: with merkle on and a file-row re-read owed, a held space is neither re-read nor merkle-checked; its twin is', async () => {
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.merkle = true;
      net.members[0].fileMetaRereadAt = { [HELD]: '1:0', [FREE]: '1:0' };
    });
    setRounds([wipeRound('w-c')]);
    served = [];
    await cycle();
    assert.ok(requestsFor(FREE).merkle > 0, 'the twin failed: the carried space was not merkle-checked, so the absence below proves nothing');
    assert.equal(requestsFor(HELD).merkle + requestsFor(HELD).pages + requestsFor(HELD).manifest, 0,
      'a held space was merkle-checked or its file rows re-read from seq 0 while only one side had wiped');
  });

  it('R6-d: a wipe the peer concluded FIRST (still open here) holds the space; a peer that has not concluded it holds nothing', async () => {
    const openHere = wipeRound('w-d', { votes: [], concluded: false, passed: undefined, appliedHere: undefined, proposedHere: false });
    setRounds([openHere]);
    served = [{ ...openHere, concluded: true, passed: true }];
    await cycle();
    assert.equal(requestsFor(HELD).total, 0, 'the peer finished a wipe this instance has not concluded, and the cycle pulled its post-wipe records / pushed into it');
    // the twin: the same open round, the peer has not concluded it
    await fresh();
    setRounds([openHere]);
    served = [{ ...openHere }];
    await cycle();
    assert.ok(requestsFor(HELD).pages > 0, 'the twin failed: an open wipe nobody concluded held the space');
  });

  it('R6-g: a club round applied here holds the space with a member of the closed network that carries it too, until that round is pruned', async () => {
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.type = 'closed'; net.origin = 'created';
      cfg.networks.push({ id: 'hold-club', label: 'Club', type: 'club', origin: 'joined', spaces: [HELD], votes: [], votingDeadlineHours: 24, pendingRounds: [],
        members: [{ instanceId: 'hold-club-member', label: 'cm', url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' }] });
    });
    setRounds([wipeRound('w-g-club')], 'hold-club');
    setRounds([], door.NET);
    served = [];
    await cycle();
    assert.equal(requestsFor(HELD).total, 0, 'the closed network\'s member was exchanged with the space a club round applied a wipe of here: no round of the closed network names it');
    assert.ok(requestsFor(FREE).pages > 0, 'the twin failed: the closed network exchanged nothing at all');
    // pruned: concluded and past its deadline, the round no longer holds anything
    loader.mutateConfig((cfg) => {
      cfg.networks.find(n => n.id === 'hold-club').pendingRounds = [wipeRound('w-g-club', { deadline: iso(NOW - HOUR) })];
    });
    const { pruneExpiredRounds } = await import('../../server/dist/sync/vote-round-retention.js');
    loader.mutateConfig((cfg) => { pruneExpiredRounds(cfg.networks.find(n => n.id === 'hold-club'), Date.now()); });
    door.state.familyRequests.length = 0; door.state.manifestRequests.length = 0;
    await cycle();
    assert.ok(requestsFor(HELD).pages > 0, 'the hold outlived the round that caused it');
  });

  it('R6-h: a refused vote pull records no evidence, so the held space stays held', async () => {
    setRounds([wipeRound('w-h')]);
    served = null;
    await cycle();
    assert.equal(requestsFor(HELD).total, 0, 'a refused vote pull was read as the peer having concluded');
    assert.ok(requestsFor(FREE).pages > 0, 'the twin failed: the data plane did not run');
  });

  it('R-W10: a stored round made unreadable by hand answers "evidence unknown" - held - and the cycle does not fail', async () => {
    setRounds([wipeRound('w-w10'), { roundId: 'w-w10-broken', type: 'space_wipe', spaceId: { bad: true }, wipeTypes: 'files', votes: 'no', concluded: true, passed: true, appliedHere: true, deadline: iso(NOW + HOUR) }]);
    served = [];
    await cycle();
    assert.equal(requestsFor(HELD).total, 0, 'an unreadable round made the hold answer "not held"');
    assert.ok(requestsFor(FREE).pages > 0, 'an unreadable round failed the whole cycle for every space');
  });

  it('R7-b: a space removed from the network DURING the cycle is not exchanged afterwards and gets no watermark (with its carried twin)', async () => {
    // The twin first: with the space still carried, its requests go out and its watermark moves.
    loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).spaces = [FREE, HELD]; });
    served = [];
    await cycle();
    assert.ok(requestsFor(HELD).pages > 0 && requestsFor(HELD).manifest > 0, 'the twin failed: the carried space sent no requests');
    assert.ok(door.member().lastSeqReceived?.[HELD] > 0, 'the twin failed: the carried space\'s receive watermark did not move');

    // The rule: the tick, the relay or an operator's cast applies a passed deletion while the loop is between two spaces. The loop reads the carried spaces
    // once; removeSpaceFromNetwork REPLACES the array on the live config, so the list the loop holds still names the removed space. The removal fires from
    // inside the peer's answer for the first space, which is the moment between the two turns - a latch, not a timer.
    await fresh();
    loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).spaces = [FREE, HELD]; });
    let removed = false;
    door.state.family = async (req, res, family) => {
      const asked = req.query.spaceId; // serveFamily rewrites the query to the peer-side space
      await door.serveFamily(req, res, family);
      if (!removed && asked === FREE) {
        removed = true;
        const { removeSpaceFromNetwork } = await import('../../server/dist/networks/network-spaces.js');
        assert.equal(removeSpaceFromNetwork(door.NET, HELD, 'a deletion applied between two turns of the cycle'), true);
      }
    };
    await cycle();
    assert.ok(removed, 'the scenario is void: the removal never fired');
    assert.ok(!loader.getConfig().networks.find(n => n.id === door.NET).spaces.includes(HELD), 'the scenario is void: the space is still carried');
    assert.equal(requestsFor(HELD).total, 0, 'the loop kept exchanging a space removed from the network between two turns (it iterates the list it read at the start)');
    assert.equal(door.member().lastSeqReceived?.[HELD], undefined, 'a receive watermark was written back for a removed space, after the removal cleared them');
    assert.ok(requestsFor(FREE).pages > 0, 'the space still carried was not exchanged');
  });
});

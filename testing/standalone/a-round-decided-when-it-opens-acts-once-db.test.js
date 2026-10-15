/**
 * A round this instance PROPOSES is decided and applied when it opens, and acts once (bundle-106, Q-453; design v5 section 6.1 rows 1-8,
 * R1, R4-a/b, the mixed answer of VR9, R-D36 and R-D36b).
 *
 * ## The defect this holds
 *
 * `DELETE /api/spaces/:id` and the wipe doors cast the proposer's own yes and NEVER evaluate (Q-453). On a club, on a pub/sub network this
 * instance publishes, and on any network where this instance is the only voter, that yes already decides the round, yet the door answered
 * `202 vote_pending` and nothing happened until a member's next cycle pushed the cast back (or never, when nobody pulls). Every network type
 * and every member count is a row below; the DEFECT is rows 1-3, 5 and 7 (a round that the proposer alone decides) answering `202`.
 *
 * ## What is a control on purpose
 *
 * Rows 4, 6 and 8 (a member must still vote) already answer `202` at the base commit and must keep doing so: they are the half of the rule that a
 * fix which passes EVERYTHING at open would break. Each is a positive twin of the row beside it.
 *
 * ## What it asserts, per row
 *
 * A passed row answers `200` (not `202`) with the round `passed` and `appliedHere`, the space out of the network, and either this instance's own
 * copy removed (a deletion) or emptied (a wipe); and it ACTS ONCE: a gossip-style settle of every held round, the expiry tick past the deadline and
 * a late cast change nothing, and the real body ran once (`spaceActBodyRuns`, never a metric or a log line — design X19).
 *
 * Run: node --test testing/standalone/a-round-decided-when-it-opens-acts-once-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { removeInstanceDir, startFakePeer, allowEngineToDialPrivatePeers, settled } from './_vote-round-instance.mjs';
import { stripComments } from './_strip-comments.mjs';
import {
  SELF, M1, M2, tempInstance, networkOf, boot, seedFacts, factCount, requireExport, roundsOf, doors, until, member, databaseTakesCollections,
} from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-open-decides-');
const skip = await mongoSkipReason();

/**
 * The rows of design v5 section 6.1: what each network looks like and whether this instance's own yes decides a deletion or a wipe.
 * `shape` builds the network; `passes` is the design's expectation, a fixture on purpose.
 */
const ROWS = [
  { n: 1, type: 'club', members: [M1, M2], passes: true },
  { n: 2, type: 'pubsub', members: [M1, M2], passes: true },
  { n: 3, type: 'closed', members: [], passes: true },
  { n: 4, type: 'closed', members: [M1], passes: false },
  { n: 5, type: 'democratic', members: [], passes: true },
  { n: 6, type: 'democratic', members: [M1], passes: false },
  { n: 7, type: 'braintree', members: [], passes: true },
  { n: 8, type: 'braintree', members: [M1], passes: false },
];
const KINDS = ['delete', 'wipe'];

const shape = (row) => networkOf(row.type, row.members, {
  memberExtra: row.type === 'pubsub' ? { direction: 'push' } : row.type === 'braintree' ? { parentInstanceId: SELF } : {},
});

describe('a round the proposer alone decides is decided and applied when it opens', { skip }, () => {
  let mongo;
  before(async () => { mongo = await openTestMongo('open_decides'); await databaseTakesCollections(mongo); });
  after(async () => { await closeTestMongo(); });

  /** Boot `row`'s network over a space with data, run the door for `kind`, and say what came back and what is left. */
  async function run(row, kind) {
    const loader = await boot(dir, { networks: [shape(row)] });
    await mongo.getDb().dropDatabase();
    await seedFacts(mongo, 'notes', 3);
    const res = kind === 'delete' ? await doors.deleteSpace('notes') : await doors.wipeSpace('notes');
    return { loader, res };
  }

  for (const kind of KINDS) {
    for (const row of ROWS.filter(r => r.passes)) {
      it(`row ${row.n}: a ${kind === 'delete' ? 'deletion' : 'wipe'} on a ${row.type} network with ${row.members.length} other member(s) passes at open, answers 200 and acts once`, async () => {
        const { loader, res } = await run(row, kind);
        assert.equal(res.code, 200, `the door answered ${res.code} ${JSON.stringify(res.body)?.slice(0, 300)} — the proposer's own yes decides this round, so it acts in the request (Q-453)`);
        assert.equal(res.body.status, kind === 'delete' ? 'deleted' : 'wiped');
        assert.equal(res.body.rounds?.[0]?.outcome, 'passed', 'the answer says the round passed');
        const [round] = roundsOf(loader, 'net-1', kind === 'delete' ? 'space_deletion' : 'space_wipe');
        assert.ok(round, 'the round is held');
        assert.deepEqual({ concluded: round.concluded, passed: round.passed, appliedHere: round.appliedHere }, { concluded: true, passed: true, appliedHere: true });
        const cfg = loader.getConfig();
        if (kind === 'delete') {
          assert.ok(!cfg.networks[0].spaces.includes('notes'), 'the network still carries the deleted space');
          assert.ok(!cfg.spaces.some(s => s.id === 'notes'), 'this instance still holds its own copy');
        } else {
          assert.ok(cfg.networks[0].spaces.includes('notes') && cfg.spaces.some(s => s.id === 'notes'), 'a wipe keeps the space');
        }
        assert.equal(await factCount(mongo, 'notes'), 0, 'the data survived a round that passed');

        // ACTS ONCE: everything that could settle the same round again, and the body count that proves it.
        const { settleRounds } = await import('../../server/dist/networks/round-conclusion.js').then(m => ({ settleRounds: m.settleRounds }));
        assert.equal(typeof settleRounds, 'function', 'server/src/networks/round-conclusion.ts does not export settleRounds — design v5 section 1.1: the one settle step');
        const net = loader.getConfig().networks[0];
        settleRounds(net, loader.getConfig(), [...net.pendingRounds], 'gossip', Date.now(), [...net.pendingRounds]);
        const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
        runRoundExpiryTick(Date.now() + 25 * 3_600_000);
        const { castVoteAct } = await import('../../server/dist/networks/vote-acts.js');
        assert.equal(castVoteAct('net-1', round.roundId, { vote: 'yes' }).status, 404, 'a cast on a decided round is refused');
        const spaceActBodyRuns = await requireExport('../../server/dist/spaces/space-act-runner.js', 'spaceActBodyRuns', 'design v5 section 2.5: the runner counts the REAL bodies');
        await until(() => loader.getConfig().pendingSpaceActs === undefined || loader.getConfig().pendingSpaceActs.length === 0, 'no space act is left standing');
        assert.equal(spaceActBodyRuns()[kind], 1, `the ${kind} body ran ${spaceActBodyRuns()[kind]} times`);
        assert.equal((loader.getConfig().networks[0].roundOutcomes ?? []).length, 1, 'the outcome log holds one entry');
      });
    }

    for (const row of ROWS.filter(r => !r.passes)) {
      it(`row ${row.n} (control): a ${kind === 'delete' ? 'deletion' : 'wipe'} on a ${row.type} network with a member still to vote answers 202 and removes nothing`, async () => {
        const { loader, res } = await run(row, kind);
        assert.equal(res.code, 202, JSON.stringify(res.body));
        assert.equal(res.body.status, 'vote_pending');
        const [round] = roundsOf(loader, 'net-1', kind === 'delete' ? 'space_deletion' : 'space_wipe');
        assert.deepEqual({ concluded: round.concluded === true, applied: round.appliedHere === true }, { concluded: false, applied: false });
        assert.equal(await factCount(mongo, 'notes'), 3, 'the data survives an open round');
        assert.ok(loader.getConfig().spaces.some(s => s.id === 'notes'));
      });
    }
  }

  it('row 6: a member\'s veto concludes the open round as failed and nothing is removed', async () => {
    const row = ROWS.find(r => r.n === 6);
    const { loader, res } = await run(row, 'delete');
    assert.equal(res.code, 202);
    const net = loader.getConfig().networks[0];
    const [round] = roundsOf(loader, 'net-1', 'space_deletion');
    round.votes.push({ instanceId: M1, vote: 'veto', castAt: new Date().toISOString() });
    const { settleRounds } = await import('../../server/dist/networks/round-conclusion.js');
    assert.equal(typeof settleRounds, 'function', 'server/src/networks/round-conclusion.ts does not export settleRounds — design v5 section 1.1');
    const out = settleRounds(net, loader.getConfig(), [round], 'peer vote', Date.now());
    await out.settled;
    assert.deepEqual({ concluded: round.concluded, passed: round.passed }, { concluded: true, passed: false });
    assert.ok(loader.getConfig().spaces.some(s => s.id === 'notes'), 'a vetoed deletion removed the space');
    assert.equal(await factCount(mongo, 'notes'), 3);
  });

  describe('VR9: the mixed answer — a club that passes beside a closed network whose member must vote', () => {
    const mixed = () => [
      networkOf('club', [M1], { id: 'club-1' }),
      networkOf('closed', [M2], { id: 'closed-1' }),
    ];
    it('a WIPE answers 200 wiped with the club round passed and the closed one open, and the data is gone here', async () => {
      const loader = await boot(dir, { networks: mixed() });
      await mongo.getDb().dropDatabase();
      await seedFacts(mongo, 'notes', 3);
      const res = await doors.wipeSpace('notes');
      assert.equal(res.code, 200, `${res.code} ${JSON.stringify(res.body)?.slice(0, 300)} — a round passed and the wipe ran here, so the door says so even while another vote is open`);
      assert.equal(res.body.status, 'wiped');
      assert.deepEqual(res.body.rounds.map(r => r.outcome).sort(), ['passed', 'vote_pending']);
      assert.equal(await factCount(mongo, 'notes'), 0);
      assert.ok(loader.getConfig().spaces.some(s => s.id === 'notes'));
    });
    it('the tool answers the same, in words and in structuredContent', async () => {
      await boot(dir, { networks: mixed() });
      await mongo.getDb().dropDatabase();
      await seedFacts(mongo, 'notes', 3);
      const out = await doors.wipeTool({ space: 'notes' });
      assert.equal(out.isError, false, out.text);
      assert.equal(out.structured?.status, 'wiped', JSON.stringify(out.structured)?.slice(0, 300));
      assert.match(out.text, /vote is still open in/i, 'the text says where a vote is still open');
    });
    it('a DELETE answers 202 with the club round passed, and this instance keeps its copy until the closed round passes', async () => {
      const loader = await boot(dir, { networks: mixed() });
      await mongo.getDb().dropDatabase();
      await seedFacts(mongo, 'notes', 3);
      const res = await doors.deleteSpace('notes');
      assert.equal(res.code, 202, JSON.stringify(res.body)?.slice(0, 300));
      assert.deepEqual(res.body.rounds.map(r => r.outcome).sort(), ['passed', 'vote_pending']);
      const cfg = loader.getConfig();
      assert.ok(!cfg.networks.find(n => n.id === 'club-1').spaces.includes('notes'), 'the space left the club');
      assert.ok(cfg.networks.find(n => n.id === 'closed-1').spaces.includes('notes'), 'the closed network still carries it');
      assert.ok(cfg.spaces.some(s => s.id === 'notes'), 'the local copy goes only when no network carries the space');
      assert.equal(await factCount(mongo, 'notes'), 3);
    });
  });

  describe('R4: an act that may take effect at once requires confirm', () => {
    const club = () => [networkOf('club', [M1, M2])];
    it('R4-a: an unconfirmed networked DELETE answers 400 and opens no round', async () => {
      const loader = await boot(dir, { networks: club() });
      const res = await doors.deleteSpace('notes', {});
      assert.equal(res.code, 400, `${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}`);
      assert.match(res.body.error, /confirm/);
      assert.equal(roundsOf(loader, 'net-1').length, 0, 'a round was opened before confirm was checked');
    });
    it('R4-b: an unconfirmed admin wipe answers 400 on a networked space, on an unnetworked one, and through the tool', async () => {
      let loader = await boot(dir, { networks: club() });
      const networked = await doors.wipeSpace('notes', {});
      assert.equal(networked.code, 400, `networked: ${networked.code} ${JSON.stringify(networked.body)?.slice(0, 200)}`);
      assert.equal(roundsOf(loader, 'net-1').length, 0);
      loader = await boot(dir, { networks: [] });
      await mongo.getDb().dropDatabase();
      await seedFacts(mongo, 'notes', 2);
      const solo = await doors.wipeSpace('notes', {});
      assert.equal(solo.code, 400, `unnetworked: ${solo.code} ${JSON.stringify(solo.body)?.slice(0, 200)}`);
      assert.equal(await factCount(mongo, 'notes'), 2, 'an unconfirmed wipe emptied the space');
      const tool = await doors.wipeTool({ space: 'notes', confirm: false });
      assert.equal(tool.isError, true, 'the tool accepted an unconfirmed wipe');
    });
  });

  describe('R1: the add-space door settles its round through the one step and awaits it', () => {
    it('a club add answers 200 with the space carried, the round concluded and passed', async () => {
      const loader = await boot(dir, { networks: [networkOf('club', [M1], { spaces: ['general'] })], spaces: ['extra'] });
      const res = await doors.addSpace('net-1', 'extra');
      assert.equal(res.code, 200, JSON.stringify(res.body)?.slice(0, 300));
      assert.ok(loader.getConfig().networks[0].spaces.includes('extra'));
      const [round] = roundsOf(loader, 'net-1', 'space_addition');
      assert.deepEqual({ concluded: round.concluded, passed: round.passed }, { concluded: true, passed: true });
    });
    it('addNetworkSpaceAct is async (it awaits the act the settle started) and spells no inline net.spaces.push', async () => {
      const { addNetworkSpaceAct } = await import('../../server/dist/networks/network-acts.js');
      assert.equal(addNetworkSpaceAct.constructor.name, 'AsyncFunction', 'server/src/networks/network-acts.ts: addNetworkSpaceAct must be `async` (design v5 section 1.4)');
      const src = stripComments(fs.readFileSync('server/src/networks/network-acts.ts', 'utf8'));
      assert.doesNotMatch(src.slice(src.indexOf('function addNetworkSpaceAct')), /net\.spaces\.push\(/,
        'a passed addition lands through settleRounds -> applySpaceAdditionRound -> addSpacesToNetwork, the one place a network gains a space');
    });
  });
});

describe('D-36: the proposer counts as a yes on every join and every removal', { skip: skip || privateAddressSkipReason() }, () => {
  let peer;
  before(async () => { allowEngineToDialPrivatePeers(); peer = await startFakePeer((method, url) => (url === '/api/notify' ? { status: 204, body: undefined } : undefined)); });
  after(async () => { await peer?.close(); removeInstanceDir(dir); });

  const newPeer = { instanceId: 'aaaaaaaa-0000-4000-8000-0000000000e1', label: 'New peer', url: 'https://new-peer.example.com', token: 'peer-token', direction: 'both' };

  it('R-D36: on a closed network with no other member an admin add is admitted at open — 201 with the member on REST, the admitted shape on MCP', async () => {
    for (const type of ['closed', 'democratic']) {
      const loader = await boot(dir, { networks: [networkOf(type, [])] });
      const rest = await doors.addMember('net-1', newPeer);
      assert.equal(rest.code, 201, `${type}: ${rest.code} ${JSON.stringify(rest.body)?.slice(0, 200)} — the proposer's yes is the quorum`);
      assert.equal(rest.body.instanceId, newPeer.instanceId);
      assert.ok(loader.getConfig().networks[0].members.some(m => m.instanceId === newPeer.instanceId), `${type}: not admitted`);
      await boot(dir, { networks: [networkOf(type, [])] });
      const tool = await doors.memberAddTool({ id: 'net-1', ...newPeer, instanceId: 'aaaaaaaa-0000-4000-8000-0000000000e2' });
      assert.equal(tool.isError, false, tool.text);
      assert.equal(tool.structured?.instanceId, 'aaaaaaaa-0000-4000-8000-0000000000e2', `${type}: MCP answered ${JSON.stringify(tool.structured)?.slice(0, 200)} instead of the admitted member`);
    }
  });

  it('R-D36: a removal with the proposer and the subject only is removed at open — 204, and the member is told', async () => {
    for (const type of ['closed', 'democratic']) {
      const loader = await boot(dir, { networks: [networkOf(type, [M1])] });
      loader.getConfig().networks[0].members[0].url = peer.url;
      peer.seen.length = 0;
      const res = await doors.removeMember('net-1', M1);
      assert.equal(res.code, 204, `${type}: ${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}`);
      assert.deepEqual(loader.getConfig().networks[0].members, [], `${type}: the member is still on the roster`);
      await settled(() => peer.seen.length);
      const told = peer.seen.find(s => s.method === 'POST' && s.url === '/api/notify');
      assert.ok(told && /member_removed/.test(told.body), `${type}: the removed member was not told (member_removed)`);
    }
  });

  it('R-D36 (control): with another member still to vote the same add and removal stay open', async () => {
    const loader = await boot(dir, { networks: [networkOf('closed', [M1])] });
    const add = await doors.addMember('net-1', newPeer);
    assert.equal(add.code, 202, JSON.stringify(add.body)?.slice(0, 200));
    const rm = await doors.removeMember('net-1', M1);
    assert.equal(rm.code, 202, JSON.stringify(rm.body)?.slice(0, 200));
    assert.ok(loader.getConfig().networks[0].members.some(m => m.instanceId === M1));
  });

  it('R-D36b: a braintree removal proposed by a node outside the ancestor set casts a yes that decides nothing', async () => {
    // SELF's parent is M1 (the root); M2 is M1's other child, so SELF is no ancestor of M2 and its yes is not required.
    const net = networkOf('braintree', [], { extra: { myParentInstanceId: M1 } });
    net.members = [member(M1), member(M2, { parentInstanceId: M1 })];
    const loader = await boot(dir, { networks: [net] });
    const res = await doors.removeMember('net-1', M2);
    assert.equal(res.code, 202, `${res.code} ${JSON.stringify(res.body)?.slice(0, 200)} — the ancestors still have to vote`);
    const [round] = roundsOf(loader, 'net-1', 'remove');
    assert.ok(round.votes.some(v => v.instanceId === SELF && v.vote === 'yes'), 'D-36: the proposer casts a yes on every removal, required or not');
    assert.equal(round.concluded === true, false, 'a yes from outside the ancestor set decided the round');
    assert.ok(loader.getConfig().networks[0].members.some(m => m.instanceId === M2));
  });
});

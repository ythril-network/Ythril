/**
 * The settle matrix: a round that concludes as PASSED lands the same by every via that can conclude one, and each via audits what it did (design v5
 * section 1.1, 6.1 X19 TS-2 and TS-5, VR7).
 *
 * ## What it pins, and what changed from the three-site version
 *
 * This file was a hand-written 3 x 6 x 5 table over `cast`, `relay` and `gossip` that waited eight calm turns of the event loop and asserted the number
 * 90. It is now the matrix itself, and nothing in it is a list of sites:
 *
 * - the SITES are the server's own `SETTLE_VIAS` less the vias that cannot conclude a round as passed, each exclusion written with its reason in
 *   `_settle-matrix.mjs` (`expiry` concludes `expired` only, D-39 = C; `retry` concludes nothing). `proposer` is a via and so a site: the round the
 *   proposer opens and its own yes decides. A via with no driver FAILS; it is never skipped;
 * - the round types and the network types are the unions `config/types-networks.ts` declares, and a type added later is a cell or this fails;
 * - every cell waits for QUIESCENCE (the notify queue, the sync cycles, the space-act runner: `_quiescence.mjs`), then reads the state LIVE from the
 *   loader. `appliedHere` is read on the round the config holds, never on a local object;
 * - the count is the product of the derived sets, which has a floor of its own; no number is written.
 *
 * What a cell asserts, beyond the state the old table compared: a space deletion or wipe ran its REAL body exactly once (`spaceActBodyRuns`), the data it
 * names is gone and any other round left the data alone, and no act entry still stands once the instance is quiescent.
 *
 * ## The audit table (VR7)
 *
 * A settle by a vote, by gossip or by a relay is the operator's request nowhere, so `settleRounds` audits what it did: one `network.round.space_act` per
 * passed wipe and per passed deletion, one `network.round.member_admitted` per passed join. The `proposer` via is the one in `REQUEST_VIAS`: its effect
 * is the request, and the route audits it, so a settle through it writes none of these. `REQUEST_VIAS` is read from the server, and the proposer is
 * driven through the operator's real door for that table: a door that answers after the act has no one left to audit it for.
 *
 * ## Written before the code (red on the base commit, 84f0b3cc)
 *
 * `SETTLE_VIAS`, `REQUEST_VIAS`, `settleRounds`, `proposeRound`, `spaceActBodyRuns` and the quiescence queues do not exist at the base: the derived set is
 * empty and its floor fails, and every cell that is derived afterwards would fail on the first missing export. Run:
 * `node --test testing/standalone/a-round-conclusion-lands-the-same-at-every-site-db.test.js` (a prior server build and the test MongoDB: `npm run test:up`).
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { tempInstanceDir, removeInstanceDir } from './_vote-round-instance.mjs';
import { startVotesPeer } from './_vote-round-sites.mjs';
import { blankComments } from './_strip-comments.mjs';
import { quiescent } from './_quiescence.mjs';
import { resetRunnerForTest } from './_space-act-harness.mjs';
import { networkOf, boot, seedFacts, factCount, doors, databaseTakesCollections } from './_round-open-fixtures.mjs';
import {
  CANNOT_PASS_A_ROUND, AFTER_A_VOTE, AFTER_AT_OPEN, declaredUnion, settleVocabulary, driverFor, bootCell, settleCell,
} from './_settle-matrix.mjs';

const dir = tempInstanceDir('ythril-settle-matrix-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** The vias the matrix MUST contain, whatever else the server adds: a floor on a derived set, never the set. */
const FLOOR_VIAS = ['gossip', 'local vote', 'peer vote', 'proposer'];
/** Floors for the other two axes; the product of the floors is the least number of cells a matrix may hold. */
const FLOOR_ROUND_TYPES = 6;
const FLOOR_NETWORK_TYPES = 5;

/** The members of a `const NAME ... = [ 'a', 'b' ]` in the settle module, read from its source with comments blanked; `[]` when the constant is absent. */
function literalList(name) {
  const src = blankComments(fs.readFileSync('server/src/networks/round-conclusion.ts', 'utf8'));
  const body = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

const settleVias = literalList('SETTLE_VIAS');
const requestVias = literalList('REQUEST_VIAS');
const vias = settleVias.filter(v => !(v in CANNOT_PASS_A_ROUND));
const roundTypes = declaredUnion('VoteRoundType');
const networkTypes = declaredUnion('NetworkType');

describe('the matrix is derived from the settle vocabulary, never listed', () => {
  it('SETTLE_VIAS and REQUEST_VIAS exist in server/src/networks/round-conclusion.ts, and the matrix holds the vias that can pass a round', () => {
    assert.ok(settleVias.length >= 1, 'networks/round-conclusion.ts exports no SETTLE_VIAS — design v5 section 1.1: the closed vocabulary of every settle site, which this matrix is derived from');
    assert.ok(requestVias.length >= 1, 'networks/round-conclusion.ts exports no REQUEST_VIAS — design v5 section 1.1: the via whose effect IS the operator\'s request');
    for (const v of FLOOR_VIAS) assert.ok(vias.includes(v), `the derived vias [${vias.join(', ')}] lack '${v}'`);
  });

  it('each via left out is a via the server has, with its reason (a stale exclusion hides a via from the matrix)', () => {
    for (const [via, why] of Object.entries(CANNOT_PASS_A_ROUND)) {
      assert.ok(settleVias.includes(via), `the matrix excludes '${via}' and SETTLE_VIAS [${settleVias.join(', ')}] has no such via`);
      assert.ok(why.length > 20, `the exclusion of '${via}' has no reason`);
    }
  });

  it('every via in the matrix has a driver (a via nothing drives is a conclusion nothing tests)', () => {
    for (const via of vias) driverFor(via);
    assert.ok(vias.length >= 1, 'no via is driven');
  });

  it('every round type has an expectation in both tables, and the axes are no smaller than their floors', () => {
    assert.deepEqual(Object.keys(AFTER_A_VOTE).sort(), [...roundTypes].sort(), 'the code declares a round type the by-a-vote table does not (or the reverse)');
    assert.deepEqual(Object.keys(AFTER_AT_OPEN).sort(), [...roundTypes].sort(), 'the code declares a round type the at-open table does not (or the reverse)');
    assert.ok(roundTypes.length >= FLOOR_ROUND_TYPES, `only ${roundTypes.length} round type(s) derived`);
    assert.ok(networkTypes.length >= FLOOR_NETWORK_TYPES, `only ${networkTypes.length} network type(s) derived`);
  });
});

describe('a round that concludes as passed lands the same by every via, and acts once', { skip }, () => {
  let mongo;
  let peer;
  let cells = 0;
  before(async () => {
    mongo = await openTestMongo('settle_matrix');
    await databaseTakesCollections(mongo);
    peer = await startVotesPeer();
  });
  after(async () => {
    await peer?.close();
    await closeTestMongo();
    removeInstanceDir(dir);
  });
  afterEach(async () => {
    const runner = await import('../../server/dist/spaces/space-act-runner.js').catch(() => null);
    if (runner?.reopenSpaceActsForTest) resetRunnerForTest(runner);
  });

  it('the built server\'s vocabulary is the source\'s (a stale build reads the old vias)', async () => {
    const built = await settleVocabulary();
    assert.ok(built.vias && built.requestVias, 'server/dist/networks/round-conclusion.js exports no SETTLE_VIAS / REQUEST_VIAS — design v5 section 1.1 (or the build predates them)');
    assert.deepEqual(built.vias, settleVias, 'server/dist exports different SETTLE_VIAS from the source: rebuild with `npm run build:server`');
    assert.deepEqual(built.requestVias, requestVias);
  });

  for (const via of vias) {
    for (const roundType of roundTypes) {
      for (const netType of networkTypes) {
        it(`${via}: a ${roundType} round on a ${netType} network`, async () => {
          const world = await bootCell(dir, via, roundType, netType, peer);
          await mongo.col('notes_facts').deleteMany({});
          await seedFacts(mongo, 'notes', 3);
          const got = await settleCell(world, via);
          const want = world.expected;
          assert.equal(got.concluded && got.passed, true, `${via} did not conclude the round as passed: ${JSON.stringify(got)}`);
          assert.deepEqual(
            { applied: got.applied, members: got.members, spaces: got.spaces, pending: got.pending, layers: got.layers, notified: got.notified, runs: got.runs, entries: got.entries },
            { applied: want.applied, members: [...want.members].sort(), spaces: want.spaces, pending: want.pending, layers: want.layers, notified: want.notified, runs: want.runs, entries: [] },
            `${via} left this instance differently on a ${roundType} round: the round, the roster, the spaces, the offers, the layers, the notice, the space-act bodies that ran, and the act entries that still stand`,
          );
          assert.deepEqual(got.introductions, [], 'a conclusion introduced a member nobody asked for');
          const took = roundType === 'space_wipe' || roundType === 'space_deletion';
          assert.equal(await factCount(mongo, 'notes'), took ? 0 : 3, took ? `the ${roundType} round passed and the space still has its data` : `a ${roundType} round touched the space's data`);
          cells++;
        });
      }
    }
  }

  it('every cell ran, and the product of the derived sets is no smaller than the product of the floors', () => {
    assert.equal(cells, vias.length * roundTypes.length * networkTypes.length, 'a loop that matched nothing, or part of the product, would pass');
    assert.ok(cells >= FLOOR_VIAS.length * FLOOR_ROUND_TYPES * FLOOR_NETWORK_TYPES, `only ${cells} cell(s) ran`);
  });
});

describe('every via audits what it did, but the one that is the operator\'s request (VR7)', { skip }, () => {
  let mongo;
  let peer;
  before(async () => {
    mongo = await openTestMongo('settle_audit');
    await databaseTakesCollections(mongo);
    peer = await startVotesPeer();
  });
  after(async () => {
    await peer?.close();
    await closeTestMongo();
  });
  afterEach(async () => {
    const runner = await import('../../server/dist/spaces/space-act-runner.js').catch(() => null);
    if (runner?.reopenSpaceActsForTest) resetRunnerForTest(runner);
  });

  /** The effects and the audit operation each writes: a passing wipe and deletion (a space act) and a passing join (an admission). */
  const EFFECTS = [
    { roundType: 'space_wipe', operation: 'network.round.space_act' },
    { roundType: 'space_deletion', operation: 'network.round.space_act' },
    { roundType: 'join', operation: 'network.round.member_admitted' },
  ];
  const newPeer = { instanceId: 'aaaaaaaa-0000-4000-8000-0000000000e1', label: 'New peer', url: 'https://new-peer.example.com', token: 'peer-token', direction: 'both' };

  /**
   * Audit writes are queued, not awaited, so a count read right after quiescence can precede the insert it counts. A sentinel entry written AFTER
   * quiescence is waited for first; entries queued before it are in the collection by then, which makes a zero a zero.
   */
  async function auditCount(operation) {
    const { logInternalAudit } = await import('../../server/dist/audit/audit.js');
    logInternalAudit({ method: 'SWEEP', path: 'internal:settle-matrix-barrier', operation: 'test.barrier' });
    for (let i = 0; i < 4000 && (await mongo.col('audit_log').countDocuments({ operation: 'test.barrier' })) === 0; i++) await new Promise(r => setImmediate(r));
    return mongo.col('audit_log').countDocuments({ operation });
  }

  it('the audit table covers the vias the matrix covers, and REQUEST_VIAS is a subset of them', () => {
    assert.ok(requestVias.length >= 1, 'REQUEST_VIAS does not exist: nothing says which via is the operator\'s request');
    for (const v of requestVias) assert.ok(vias.includes(v), `REQUEST_VIAS names '${v}', which is not a via that can pass a round`);
  });

  for (const via of vias) {
    for (const { roundType, operation } of EFFECTS) {
      it(`${via}: a passing ${roundType} writes ${requestVias.includes(via) ? 'no' : 'exactly one'} ${operation} entry`, async () => {
        await mongo.col('audit_log').deleteMany({});
        if (requestVias.includes(via)) {
          const loader = await boot(dir, { networks: [networkOf('closed', [])] });
          await seedFacts(mongo, 'notes', 2);
          const res = roundType === 'space_wipe' ? await doors.wipeSpace('notes') : roundType === 'space_deletion' ? await doors.deleteSpace('notes') : await doors.addMember('net-1', newPeer);
          assert.ok([200, 201].includes(res.code), `the operator's own door answered ${res.code} ${JSON.stringify(res.body)?.slice(0, 200)}`);
          await quiescent(loader);
        } else {
          const world = await bootCell(dir, via, roundType, 'closed', peer);
          await seedFacts(mongo, 'notes', 2);
          await settleCell(world, via);
        }
        assert.equal(await auditCount(operation), requestVias.includes(via) ? 0 : 1,
          requestVias.includes(via) ? `${via} is the operator's request and its route audits it: a settle through it wrote ${operation} as well` : `${via} concluded a passing ${roundType} and wrote ${operation} a number of times other than one`);
      });
    }
  }
});

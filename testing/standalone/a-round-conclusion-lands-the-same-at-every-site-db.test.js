/**
 * CHARACTERIZATION: what a round that concludes DOES to this instance, by round type — and that the three sites agree.
 *
 * ## What it pins, and why it exists before the refactor
 *
 * A round concludes in three places — the operator's own cast, a peer's relayed cast, and the gossip pass — and each used to
 * write out the same steps (admit a passed join, apply a passed space round, tell an ejected member). One function now does
 * them (`applyRoundConclusion`), and a refactor that merges three copies can drop a step from exactly one of them without any
 * test noticing, because no test drove all three over every round type. This one does, over every round type on every
 * network type, through the three real doors:
 *
 * - the operator's cast: `castVoteAct`, the act REST and MCP both call;
 * - the relay: `POST /api/sync/networks/:id/votes/:roundId`, its own handler (past auth and rate limit);
 * - gossip: `runSyncForPeer` against a peer that answers over HTTP with the round and the deciding cast.
 *
 * Each scenario is ONE yes from deciding, so the cast that arrives is the only thing that differs between the sites. What is
 * compared is everything a conclusion can change here: the round's own flags, the roster, the spaces, the spaces held as
 * pending, the introductions, the network's schema layers, and whether the ejected member was told.
 *
 * ## It was written GREEN on the code before the refactor, and must stay green after it
 *
 * The table below was observed, not designed: on the unchanged code all 90 cells (6 round types x 5 network types x 3 sites)
 * answered the same way within a round type, which is itself the finding — the three copies agree today, so any difference
 * after the refactor is the refactor's.
 *
 * `held` is part of the row because a conclusion does not remove the round: the cast and relay sites leave it for the prune,
 * and so does gossip. (The expiry job prunes in the same tick it concludes; that is its own rule, held elsewhere.)
 *
 * Run: node --test testing/standalone/a-round-conclusion-lands-the-same-at-every-site-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { tempInstanceDir, removeInstanceDir } from './_vote-round-instance.mjs';
import { NET_TYPES, ROUND_TYPES, SITES, JOINER, P1, P2, scenario, bootScenario, decide, startVotesPeer } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-round-sites-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/**
 * The state after the deciding yes, by round type: a fixture, literal on purpose — it is what the code did, not what a rule
 * derives. `m` are the member ids (last two characters); `s` the network's spaces; `pend` spaces held as pending; `lay` the
 * spaces that got a network schema layer; `told` whether the ejected member was notified.
 */
const AFTER = {
  join: { applied: false, members: [P1, P2, JOINER], spaces: ['general', 'notes'], pending: [], layers: [], notified: false },
  remove: { applied: false, members: [P1], spaces: ['general', 'notes'], pending: [], layers: [], notified: true },
  space_deletion: { applied: true, members: [P1, P2], spaces: ['general'], pending: [], layers: [], notified: false },
  space_wipe: { applied: true, members: [P1, P2], spaces: ['general', 'notes'], pending: [], layers: [], notified: false },
  meta_change: { applied: false, members: [P1, P2], spaces: ['general', 'notes'], pending: [], layers: ['notes'], notified: false },
  space_addition: { applied: false, members: [P1, P2], spaces: ['general', 'notes'], pending: ['fresh'], layers: [], notified: false },
};

describe('a round that concludes lands the same by the operator\'s cast, a relayed cast and gossip', { skip }, () => {
  let peer;
  before(async () => {
    await openTestMongo('round_conclusion_sites');
    peer = await startVotesPeer();
  });
  after(async () => {
    await peer?.close();
    await closeTestMongo();
    removeInstanceDir(dir);
  });

  it('the table covers every round type the code knows (a type added later has a row or this fails)', async () => {
    const declared = /export type VoteRoundType\s*=([^;]+);/.exec(fs.readFileSync('server/src/config/types-networks.ts', 'utf8'));
    assert.ok(declared, 'VoteRoundType is gone — re-anchor this gate');
    const known = [...declared[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
    assert.deepEqual(known.sort(), [...ROUND_TYPES].sort(), 'the code knows a round type the table does not (or the reverse)');
    assert.deepEqual(Object.keys(AFTER).sort(), [...ROUND_TYPES].sort());
    assert.equal(ROUND_TYPES.length * NET_TYPES.length * SITES.length, 90);
  });

  let cells = 0;
  for (const site of SITES) {
    for (const roundType of ROUND_TYPES) {
      for (const netType of NET_TYPES) {
        it(`${site}: a ${roundType} round on a ${netType} network`, async () => {
          const scen = scenario(roundType, netType, site, peer.url);
          const loader = await bootScenario(dir, scen);
          assert.equal(loader.getConfig().networks[0].pendingRounds[0].concluded, false, 'the scenario starts concluded');
          const got = await decide(site, loader, scen, peer);
          const want = AFTER[roundType];
          assert.equal(got.concluded && got.passed, true, `${site} did not conclude the round as passed: ${JSON.stringify(got)}`);
          assert.deepEqual(
            { applied: got.applied, members: got.members, spaces: got.spaces, pending: got.pending, layers: got.layers, notified: got.notified },
            { ...want, members: [...want.members].sort() },
            `${site} left this instance differently from the other sites on a ${roundType} round`,
          );
          assert.deepEqual(got.introductions, [], 'a conclusion introduced a member nobody asked for');
          cells++;
        });
      }
    }
  }

  it('every cell ran (a loop that matched nothing would pass)', () => {
    assert.equal(cells, 90);
  });
});

/**
 * Two instances that each hold ONE of two divergent copies of a record at one version end holding the SAME parent (Q-324).
 *
 * ## The defect
 *
 * At an equal seq with different content the planner forked the ARRIVING copy and left the stored one as the parent. A holds X and B holds
 * Y: A keeps X and forks Y, B keeps Y and forks X. The fork sets agree and the parents do not, so the space hash differs for ever and a
 * network with `merkle: true` reports a divergence every cycle for a space where nobody has anything left to say.
 *
 * ## The rule
 *
 * One total order every instance computes alike from the two copies alone: the copy with the lower body hash is the parent (`arrivingWinsTie`,
 * `tieHashes`). When the arriving copy wins, the receiver turns its OWN stored copy into the fork (under the id the peer mints for the same body)
 * and replaces the parent at the same seq. Nothing is deleted and nothing on the peer is touched: each instance decides its own copy.
 *
 * ## What is asserted, for every kind that forks (`FORKING_FAMILIES`) and on every door that takes an arrival (single, batch, pull)
 *
 *  - both instances hold the same parent, and it is the copy the server's own tie rule names (read from the server, never assumed: the
 *    fixtures' texts are literal, so which one wins is whatever the hash says; one of the two instances therefore swaps and the other forks,
 *    which is both orders of the rule in one run);
 *  - one fork each, under one id, carrying the other body;
 *  - the space hash agrees;
 *  - a re-delivery changes nothing;
 *  - a pair that diverged BEFORE the fix (each side holding both forks and its own parent) converges on the next delivery, with no migration
 *    and no fork deleted.
 *
 * Seen red on the base (78fe14af5): the parents differ and the roots differ.
 *
 * Run: node --test testing/standalone/an-equal-seq-divergence-keeps-the-lower-body-as-parent-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf, arrivalDoors, splitByTie } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACES = ['q324-a', 'q324-b'];
const [A, B] = SPACES;
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const ID = 'subject';
const SEQ = 5;
const THIRD = 'a-third-peer';

let door, FAMILIES, DELIVER, computeMerkleRoot;

const rows = (space, family, filter = {}) => door.coll(space, family).find(filter).sort({ _id: 1 }).toArray();
const copy = (family, space, text) => copyOf(family, space, ID, SEQ, text, { author: { ...PEER_AUTHOR } });

/** What an instance holds of the record: its parent's text and the texts of its forks, with the fork ids. */
async function stateOf(space, family) {
  const field = FORK_FIXTURE[family].field;
  const parent = await door.coll(space, family).findOne({ _id: ID });
  const forks = await rows(space, family, { forkOf: ID });
  return { parent: parent?.[field], parentForkOf: parent?.forkOf, forks: forks.map(f => [f._id, f[field], f.forkAt]) };
}

describe('an equal-seq divergence keeps the lower body as the parent on both instances (Q-324)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q324_tie', spaces: SPACES });
    DELIVER = arrivalDoors(door, TOKEN);
    FAMILIES = await forkingFamilies();
    ({ computeMerkleRoot } = await import('../../server/dist/brain/merkle.js'));
  });
  after(async () => { await door?.close(); });

  for (const via of ['single', 'batch', 'pull']) {
    it(`${via}: each instance holds one copy; after the exchange both hold the lower-hash copy as the parent and the other as the one fork, and the roots agree`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        await door.reset();
        const field = FORK_FIXTURE[family].field;
        const x = copy(family, A, 'what instance A wrote');
        const y = copy(family, B, 'what instance B wrote');
        // Each instance's own copy was delivered to it by a third peer: a stored row with no stamp at all is stamped by the pull's back-fill with the peer
        // it pulls from, which would make "who delivered the copy that became the fork" unanswerable here.
        await door.coll(A, family).insertOne({ ...x, deliveredBy: THIRD });
        await door.coll(B, family).insertOne({ ...y, deliveredBy: THIRD });
        for (const space of SPACES) await door.raiseVersionTo(space, SEQ);
        // The exchange: A is handed B's copy and B is handed A's.
        await DELIVER[via](family, { [A]: [copy(family, A, 'what instance B wrote')], [B]: [copy(family, B, 'what instance A wrote')] });
        await door.settled();

        const { parent, fork } = await splitByTie(family, x, y);
        const expectedFork = await forkIdOf(family, ID, SEQ, fork);
        const [sa, sb] = [await stateOf(A, family), await stateOf(B, family)];
        for (const [space, s] of [[A, sa], [B, sb]]) {
          if (s.parent !== parent[field]) failures.push(`${via}/${family}/${space}: the parent says ${JSON.stringify(s.parent)}, the tie rule names ${JSON.stringify(parent[field])}`);
          if (s.parentForkOf !== undefined) failures.push(`${via}/${family}/${space}: the parent became a fork of ${s.parentForkOf}`);
          if (s.forks.length !== 1) { failures.push(`${via}/${family}/${space}: ${s.forks.length} forks, expected 1`); continue; }
          const [id, text, forkAt] = s.forks[0];
          if (id !== expectedFork) failures.push(`${via}/${family}/${space}: the fork is ${id}, its body derives ${expectedFork}`);
          if (text !== fork[field]) failures.push(`${via}/${family}/${space}: the fork says ${JSON.stringify(text)}, expected ${JSON.stringify(fork[field])}`);
          if (forkAt !== SEQ) failures.push(`${via}/${family}/${space}: forkAt ${forkAt}, the shared version is ${SEQ}`);
          // Who delivered the fork: the peer when the fork is the copy that ARRIVED; nobody (the stored copy's own stamp) when it is the copy this instance
          // already held. Stamped with the peer, the displaced text would never be offered back to the peer that has not seen it (found between real instances).
          const own = space === A ? x : y;
          const stamp = (await door.coll(space, family).findOne({ _id: id }))?.deliveredBy;
          const expectedStamp = text === own[field] ? THIRD : PEER;
          if (stamp !== expectedStamp) failures.push(`${via}/${family}/${space}: the fork is stamped deliveredBy ${JSON.stringify(stamp)}, expected ${JSON.stringify(expectedStamp)}`);
        }
        if (JSON.stringify(sa) !== JSON.stringify(sb)) failures.push(`${via}/${family}: the two instances differ: ${JSON.stringify(sa)} / ${JSON.stringify(sb)}`);
        const [ra, rb] = [(await computeMerkleRoot(A)).root, (await computeMerkleRoot(B)).root];
        if (ra !== rb) failures.push(`${via}/${family}: the space hashes differ after the exchange`);

        // A re-delivery of both copies changes nothing.
        await DELIVER[via](family, { [A]: [copy(family, A, 'what instance B wrote')], [B]: [copy(family, B, 'what instance A wrote')] });
        await door.settled();
        for (const [space, before] of [[A, sa], [B, sb]]) {
          const again = await stateOf(space, family);
          if (JSON.stringify(again) !== JSON.stringify(before)) failures.push(`${via}/${family}/${space}: a re-delivery changed what is held: ${JSON.stringify(again)}`);
        }
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });

    it(`${via}: a pair that diverged before the fix (each holds its own parent and both forks) converges on the next delivery, deleting nothing`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        await door.reset();
        const field = FORK_FIXTURE[family].field;
        const x = copy(family, A, 'what instance A wrote');
        const y = copy(family, B, 'what instance B wrote');
        const forkRow = async (space, doc) => ({ ...copy(family, space, doc[field]), _id: await forkIdOf(family, ID, SEQ, doc), forkOf: ID, forkAt: SEQ, seq: SEQ + 1 });
        for (const space of SPACES) {
          await door.coll(space, family).insertOne(space === A ? x : y);
          await door.coll(space, family).insertMany([await forkRow(space, x), await forkRow(space, y)]);
          await door.raiseVersionTo(space, SEQ + 1);
        }
        await DELIVER[via](family, { [A]: [copy(family, A, 'what instance B wrote')], [B]: [copy(family, B, 'what instance A wrote')] });
        await door.settled();
        const { parent } = await splitByTie(family, x, y);
        const [sa, sb] = [await stateOf(A, family), await stateOf(B, family)];
        for (const [space, s] of [[A, sa], [B, sb]]) {
          if (s.parent !== parent[field]) failures.push(`${via}/${family}/${space}: the parent says ${JSON.stringify(s.parent)}, the tie rule names ${JSON.stringify(parent[field])}`);
          if (s.forks.length !== 2) failures.push(`${via}/${family}/${space}: ${s.forks.length} forks, expected the two that were there (nothing minted, nothing deleted)`);
        }
        if ((await computeMerkleRoot(A)).root !== (await computeMerkleRoot(B)).root) failures.push(`${via}/${family}: the space hashes still differ`);
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });
  }
});

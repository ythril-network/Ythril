/**
 * Every kind that forks forks on EVERY door that takes an arrival, and two receivers derive ONE fork id for one body
 * (Q-624, design rev 4 sections 1, 3, 4 and 16 test 3).
 *
 * ## The rule
 *
 * A copy that arrives at a version a stored copy already holds, saying something different, is kept beside it as a fork
 * row of its own kind: facts as before, and now entities, edges and chrono entries too (D-23). It is one rule with four
 * doors, and the defect class this repo produces most is the door that lacks it, so each kind runs through each door:
 *
 * - **single push** (`POST /<kind>`), **batch push** (`POST /batch-upsert`) and **pull** (the real engine against a fake peer):
 *   the stored copy stays, ONE fork row appears with `forkOf` naming it, the arriving body, and the id section 3 derives,
 *   `forkIdFor(forkOf, forkAt, authoredContentHash(family, body).text)`; the same copy delivered again is that fork and adds no row;
 * - **import** (an admin restore): it does not PLAN forks, it restores rows. A fork row in an export comes back as a fork row
 *   (its `forkOf` is not stripped, so it is not a second plain record), and a fork row whose id does not derive from its own
 *   subject, seq and body is refused, never stored (section 3, "on any door (push, pull, import)").
 *
 * **Two receivers, one id.** Two instances that fork the same divergence must name the fork alike, or the same fork is two
 * rows in the space hash for ever (the `a-fork-keeps-its-copys-created-at` reason). Two spaces on the one door stand for two
 * receivers: the same delivery, the same derived id.
 *
 * ## Derived, never listed
 *
 * The kinds are `FORKING_FAMILIES` (`_fork-kinds.mjs`, which fails on a kind with no fixture and on an empty set). The doors are
 * the four above, each with one way to deliver; the single route of a kind is read from the push door's `FAMILIES`.
 *
 * ## Seen red
 *
 * On the base (b857da8f) `FORKING_FAMILIES` and `authoredContentHash` do not exist, so the set cannot be read. With them stubbed in
 * (scratch only), an entity, a chrono entry and an edge at an equal seq are skipped on every push door and no fork row is made.
 *
 * Run: node --test testing/standalone/every-kind-forks-on-every-door-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf, copyBeating, arrivalDoors } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** Two receivers: two local spaces on the one door, every delivery made to both. */
const SPACES = ['q624t2doors-a', 'q624t2doors-b'];
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const ID = 'subject';
const SEQ = 5;

let door, FAMILIES;

const rows = (space, family, filter = {}) => door.coll(space, family).find(filter).sort({ _id: 1 }).toArray();
const forksOf = (space, family) => rows(space, family, { forkOf: ID });
const theirs = (family, space) => copyOf(family, space, ID, SEQ, 'what the peer wrote', { author: { ...PEER_AUTHOR } });
// Re-anchored for Q-324: the stored copy is the one the tie rule makes the PARENT against `theirs` (found by search, the order being the server's), so the
// arriving copy is the fork it always was. The other order, where the arriving copy takes the parent slot, is
// `an-equal-seq-divergence-keeps-the-lower-body-as-parent-db`.
const MINE = {};
const mine = (family, space) => ({ ...MINE[family], spaceId: space });

/** One way to deliver `docs` (of one family) to every receiver, per door: `arrivalDoors`. */
let DELIVER;

describe('every kind that forks forks on every door, and two receivers derive one id (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q624t2_doors', spaces: SPACES });
    DELIVER = arrivalDoors(door, TOKEN);
    FAMILIES = await forkingFamilies();
    for (const family of FAMILIES) MINE[family] = await copyBeating(family, SPACES[0], ID, SEQ, theirs(family, SPACES[0]), 'what this instance wrote', { author: { ...PEER_AUTHOR } });
  });
  after(async () => { await door?.close(); });

  it('the planner states which kinds fork, at least the four of the design, each with a fixture', async () => {
    assert.ok(FAMILIES.length >= 4, `only ${FAMILIES.length} forking famil(ies) read from the planner`);
  });

  for (const via of ['single', 'batch', 'pull']) { // the doors arrivalDoors() builds; DELIVER is set in before(), after this body has run
    it(`${via}: every kind keeps an equal-seq divergent copy as ONE fork under the derived id, on both receivers`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        await door.reset();
        for (const space of SPACES) await door.coll(space, family).insertOne(mine(family, space));
        for (const space of SPACES) await door.raiseVersionTo(space, SEQ);
        const arriving = Object.fromEntries(SPACES.map(space => [space, [theirs(family, space)]]));
        await DELIVER[via](family, arriving);
        await door.settled();
        const expected = await forkIdOf(family, ID, SEQ, theirs(family, SPACES[0]));
        const ids = [];
        for (const space of SPACES) {
          const forks = await forksOf(space, family);
          const parent = await door.coll(space, family).findOne({ _id: ID });
          const field = FORK_FIXTURE[family].field;
          if (forks.length !== 1) { failures.push(`${via}/${family}/${space}: ${forks.length} fork rows, expected 1`); continue; }
          ids.push(forks[0]._id);
          if (forks[0].forkAt !== SEQ) failures.push(`${via}/${family}/${space}: the fork row says forkAt ${forks[0].forkAt}, the shared version is ${SEQ}`);
          if (forks[0]._id !== expected) failures.push(`${via}/${family}/${space}: fork id ${forks[0]._id}, section 3 derives ${expected}`);
          if (forks[0][field] !== 'what the peer wrote') failures.push(`${via}/${family}/${space}: the fork says ${JSON.stringify(forks[0][field])}`);
          if (parent?.[field] !== MINE[family][field] || parent.forkOf !== undefined) {
            failures.push(`${via}/${family}/${space}: the stored copy changed: ${JSON.stringify(parent)}`);
          }
        }
        if (new Set(ids).size > 1) failures.push(`${via}/${family}: the two receivers named the one fork differently: ${ids}`);

        // The same copy again is THAT fork: no second row (a retry, or a peer that re-offers).
        await DELIVER[via](family, arriving);
        await door.settled();
        for (const space of SPACES) {
          const again = (await forksOf(space, family)).length;
          if (again !== 1) failures.push(`${via}/${family}/${space}: a re-delivery left ${again} fork rows, expected the same 1`);
        }
        // The control: a copy that says what the stored copy says is the same copy and forks nothing.
        await door.reset();
        for (const space of SPACES) await door.coll(space, family).insertOne(mine(family, space));
        for (const space of SPACES) await door.raiseVersionTo(space, SEQ);
        await DELIVER[via](family, Object.fromEntries(SPACES.map(space => [space, [mine(family, space)]])));
        await door.settled();
        for (const space of SPACES) {
          const n = (await forksOf(space, family)).length;
          if (n !== 0) failures.push(`${via}/${family}/${space}: a copy saying the same thing forked (${n} rows)`);
        }
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });
  }

  /*
   * A fork row keeps the LOCAL version stamp of the instance that stored it in `seq`, and its id derives from `forkAt`, the shared version the copies diverged
   * at (parent decision, 2026-10-25). So a third instance, handed that stored row, recomputes the same id from `forkAt` and stores it under that id; derived from
   * the stored `seq` it would be `invalidFork` and never land. Edge forks follow in I2 (they need the partial identity index to be stored at all).
   */
  for (const via of ['batch', 'pull']) {
    it(`${via}: a fork row stored by one receiver verifies at a third instance and lands under the same id, for every kind but edges`, async () => {
      const failures = [];
      for (const family of FAMILIES.filter(f => f !== 'edges')) {
        await door.reset();
        const [first, third] = SPACES;
        await door.coll(first, family).insertOne(mine(family, first));
        await door.raiseVersionTo(first, SEQ);
        await DELIVER.batch(family, { [first]: [theirs(family, first)] });
        await door.settled();
        const stored = (await forksOf(first, family))[0];
        if (!stored) { failures.push(`${via}/${family}: the first receiver made no fork row`); continue; }
        if (stored.seq === SEQ) failures.push(`${via}/${family}: fixture check: the stored fork kept the shared seq, so the case cannot tell seq from forkAt`);
        // The third instance holds the subject (it is the same record) and is handed the stored fork row, as a pull or a push of it would.
        await door.coll(third, family).insertOne(mine(family, third));
        await door.raiseVersionTo(third, SEQ);
        const { _id, spaceId, embedding, embeddingModel, pos, posAtSeq, deliveredBy, _expireAt, _contentExpireAt, syncBase, ...wire } = stored;
        await DELIVER[via](family, { [third]: [{ ...wire, _id, spaceId: third }] });
        await door.settled();
        const landed = await forksOf(third, family);
        if (landed.length !== 1 || landed[0]._id !== stored._id) failures.push(`${via}/${family}: the third instance holds ${JSON.stringify(landed.map(r => r._id))}, expected only ${stored._id}`);
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });
  }

  it('import: a fork row of every kind is restored as a fork row, and one whose id does not derive is refused', async () => {
    const { importDocuments } = await import('../../server/dist/sync/space-import.js');
    const failures = [];
    for (const family of FAMILIES) {
      await door.reset();
      const space = SPACES[0];
      const parent = mine(family, space);
      const forkId = await forkIdOf(family, ID, SEQ, theirs(family, space));
      const fork = { ...theirs(family, space), _id: forkId, forkOf: ID, forkAt: SEQ };
      const planted = { ...theirs(family, space), _id: 'planted-not-derived', forkOf: ID, [FORK_FIXTURE[family].field]: 'a body that never made this id' };
      const out = await importDocuments(space, { [family]: [parent, fork, planted] });
      const stored = await door.coll(space, family).find({}).toArray();
      const byId = new Map(stored.map(d => [d._id, d]));
      if (!byId.has(ID)) failures.push(`${family}: the restored subject is not stored`);
      if (byId.get(forkId)?.forkOf !== ID) failures.push(`${family}: the restored fork row ${forkId} is stored as ${JSON.stringify(byId.get(forkId))}, not as a fork of ${ID}`);
      if (byId.has('planted-not-derived')) failures.push(`${family}: a fork row whose id does not derive from its body was stored by an import`);
      const refused = (out.results[family].refused ?? []).map(r => r._id);
      if (!refused.includes('planted-not-derived')) failures.push(`${family}: the import did not name the planted fork among its refusals (${JSON.stringify(out.results[family])})`);
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
  });
});

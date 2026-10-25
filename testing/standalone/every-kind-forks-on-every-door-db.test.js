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
 *   `forkIdFor(forkOf, seq, authoredContentHash(family, body).text)`; the same copy delivered again is that fork and adds no row;
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
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf, arrivalDoors } from './_fork-kinds.mjs';

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
const mine = (family, space) => copyOf(family, space, ID, SEQ, 'what this instance wrote', { author: { ...PEER_AUTHOR } });

/** One way to deliver `docs` (of one family) to every receiver, per door: `arrivalDoors`. */
let DELIVER;

describe('every kind that forks forks on every door, and two receivers derive one id (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q624t2_doors', spaces: SPACES });
    DELIVER = arrivalDoors(door, TOKEN);
    FAMILIES = await forkingFamilies();
  });
  after(async () => { await door?.close(); });

  it('the planner states which kinds fork, at least the four of the design, each with a fixture', async () => {
    assert.ok(FAMILIES.length >= 4, `only ${FAMILIES.length} forking famil(ies) read from the planner`);
  });

  for (const via of Object.keys(DELIVER)) {
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
          if (forks[0]._id !== expected) failures.push(`${via}/${family}/${space}: fork id ${forks[0]._id}, section 3 derives ${expected}`);
          if (forks[0][field] !== 'what the peer wrote') failures.push(`${via}/${family}/${space}: the fork says ${JSON.stringify(forks[0][field])}`);
          if (parent?.[field] !== 'what this instance wrote' || parent.forkOf !== undefined) {
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

  it('import: a fork row of every kind is restored as a fork row, and one whose id does not derive is refused', async () => {
    const { importDocuments } = await import('../../server/dist/api/admin-import.js');
    const failures = [];
    for (const family of FAMILIES) {
      await door.reset();
      const space = SPACES[0];
      const parent = mine(family, space);
      const forkId = await forkIdOf(family, ID, SEQ, theirs(family, space));
      const fork = { ...theirs(family, space), _id: forkId, forkOf: ID };
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

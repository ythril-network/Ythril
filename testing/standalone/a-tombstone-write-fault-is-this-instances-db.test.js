/**
 * A tombstone apply that fails IN THIS INSTANCE'S STORE is this instance's fault, on both sync doors, and is never counted against the peer;
 * a tombstone FETCH that fails is still the peer's (bundle-39, Q-220, plan D1 "tombstone try inside deliver", D1 v2).
 *
 * ## The defect
 *
 * `pullTombstones` (`sync/tombstone-transfer.ts`) caught everything its pager threw in ONE place and stopped the transfer as `'error'`: the
 * peer's transport and JSON faults, a tombstone type this instance does not know, and the apply that wrote this instance's own collections
 * (`applyPeerTombstones` inside `deliver`). So a view where `<space>_facts` should be, a full disk or a stepping-down primary made the member
 * a FAILURE: on the scheduled door `consecutiveFailures` went up and PEER UNREACHABLE printed for a peer that had answered every page; on the
 * manual door the stopped transfer was not even looked at. (`a-tombstone-moves-no-counter-db.test.js` holds that the receive mark does not pass
 * the tombstone and that the apply error is logged; it says nothing of how the member is classified.)
 *
 * ## The rule
 *
 * On BOTH doors, from `consecutiveFailures` seeded at 5:
 *
 *  - an apply that fails in the local store (the real fault of that file: `<space>_facts` is a view, so every write to it fails at the command
 *    level): the member's outcome is `local-fault`; the receive mark is HELD at the tombstone (never passes it, so the next cycle asks again);
 *    the counter does not count it (the peer answered the page, so it reads 0, and it is never 6). On the scheduled door the cycle's history
 *    status and `ythril_sync_cycles_total{status}` are `failed` (the cycle's only member did not complete) and the history says whose fault.
 *  - a tombstone FETCH that fails (the peer answers 500 on `/api/sync/tombstones`): the member's outcome is `failed` and the counter goes to 6.
 *    The local-fault reading must not swallow the peer's own faults.
 *  - control: with no fault the tombstone is applied, the mark passes it and the member is not failing.
 *
 * ## How red shows
 *
 * One object per case is compared (`outcome`, `failures`, `mark`, and on the scheduled door `history` and `metric`), so a red run prints every
 * wrong field. On the base the scheduled door reads `failures: 6` for the apply fault and the manual door reads `failures: 0` for the fetch fault
 * (it counts neither), and no answer carries `members[]`. The control holds at the base on every field but `outcome`.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-tombstone-write-fault-is-this-instances-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { clearPositionMarks, readMark, setMark } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const F = 'tombfault';
const SENTINEL = 3;
const SEEDED = 5;
const TOMB_SEQ = 400;
const NO_MEMBERS = '(no members[] entry for the peer on the answer)';

let door;

const memberOf = (out) => door.memberOf(out);

/** Both doors as production runs them; the scheduled one (`door.cycle()`) reads the history row and the cycle metric it wrote. */
const DOORS = {
  scheduled: () => door.cycle(),
  async manual() { return { out: await door.sync() }; },
};

/** `<space>_facts` is a view on `<space>_entities` while `fn` runs, and the entity the tombstone targets sits in it: found, authored by the issuer, and its delete fails. */
async function withFactsAView(targets, fn) {
  const db = door.mongo.getDb();
  await db.collection(`${F}_entities`).insertMany(targets);
  try { return await withCollectionAsView(db, `${F}_facts`, `${F}_entities`, fn); } finally { await db.collection(`${F}_entities`).deleteMany({}); }
}

describe('a tombstone apply that fails locally is this instance\'s fault; a tombstone fetch that fails is the peer\'s', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b39A_tomb', spaces: [F] });
  });
  after(async () => { await door?.close(); });

  async function fresh() {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
    door.member().consecutiveFailures = SEEDED;
    door.state.family = door.serveFamily;
    setMark(door, 'received', F, SENTINEL);
  }
  const tomb = () => build.tombstone(F, 'gone', 'fact', TOMB_SEQ, { instanceId: PEER });

  for (const [doorName, run] of Object.entries(DOORS)) {
    describe(`the ${doorName} door`, () => {
      it('the apply fails in the local store: local-fault, the mark is held at the tombstone, the counter does not count it', async () => {
        await fresh();
        await door.seedPeer(F, [tomb()]);
        const got = await withFactsAView([build.entity(F, 'gone', 3, { author: PEER_AUTHOR })], () => run());
        const actual = {
          outcome: memberOf(got.out)?.outcome ?? NO_MEMBERS,
          failures: door.member().consecutiveFailures ?? 0,
          mark: readMark(door, 'received', F),
        };
        const expected = { outcome: 'local-fault', failures: 0, mark: SENTINEL };
        if (doorName === 'scheduled') { actual.history = got.history; actual.metric = got.metric; expected.history = 'failed'; expected.metric = { failed: 1 }; }
        assert.deepEqual(actual, expected,
          `${doorName} door: a tombstone apply that failed in THIS instance's store was not classified as its own fault (the counter, seeded at ${SEEDED}, must not move to ${SEEDED + 1})`);
        if (doorName === 'scheduled') {
          assert.ok(got.historyErrors.some(e => /this instance/i.test(e)), `the history's errors do not say the failure was this instance's own: ${JSON.stringify(got.historyErrors)}`);
        }
      });

      it('the tombstone fetch fails (the peer answers 500 on its tombstone page): still failed, counted against the peer', async () => {
        await fresh();
        door.state.tombstoneStatus = 500;
        const got = await run();
        assert.ok(door.state.requests.length > 0, 'fixture check: the peer was never asked for its tombstones');
        const actual = {
          outcome: memberOf(got.out)?.outcome ?? NO_MEMBERS,
          failures: door.member().consecutiveFailures ?? 0,
          mark: readMark(door, 'received', F),
        };
        const expected = { outcome: 'failed', failures: SEEDED + 1, mark: SENTINEL };
        if (doorName === 'scheduled') { actual.history = got.history; actual.metric = got.metric; expected.history = 'failed'; expected.metric = { failed: 1 }; }
        assert.deepEqual(actual, expected, `${doorName} door: a peer that answered 500 on its tombstone page was not classified failed and counted`);
      });

      it('control: with no fault the tombstone is applied, the mark passes it and the member is not failing', async () => {
        await fresh();
        await door.coll(F, 'facts').insertOne(build.fact(F, 'gone', 3, { author: PEER_AUTHOR }));
        await door.seedPeer(F, [tomb()]);
        const got = await run();
        assert.equal(await door.coll(F, 'facts').findOne({ _id: 'gone' }), null, 'control: the tombstone was not applied');
        const mark = readMark(door, 'received', F);
        assert.ok(Number.isSafeInteger(mark) && mark > SENTINEL, `control: the receive mark is ${String(mark)}, not past the sentinel ${SENTINEL}`);
        assert.deepEqual({ outcome: memberOf(got.out)?.outcome ?? NO_MEMBERS, failures: door.member().consecutiveFailures ?? 0 }, { outcome: 'success', failures: 0 });
      });
    });
  }
});

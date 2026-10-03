/**
 * Every push door whose handler moves the counter answers `500` when the counter could not be moved — never a
 * success over a counter left behind what it received (`Q-271`).
 *
 * ## Why it matters
 *
 * A peer's push carries seqs from the peer's clock, and the counter must pass them before the push is answered:
 * otherwise this instance's next local write takes a seq BELOW one it already holds from the peer, and every peer
 * holding that record refuses the local one as older (`bumpSeq`'s own docblock). A push that answers 200 over a
 * counter it could not move tells the sender to advance its watermark, so the page is never offered again and
 * the counter never catches up. A 500 keeps the sender's watermark and the page comes back.
 *
 * ## The doors — derived through the call graph, never listed
 *
 * Every POST route mounted from `server/src/api/sync/` whose handler REACHES `bumpSeq` (`_call-graph.mjs`,
 * closures followed — an inline handler is a closure). Not the page-accept's own list of routes: a door that bumps
 * by another path (the tombstone door bumps in `applyPeerTombstones`) is a door all the same, and one added next
 * year without a case below fails the coverage test.
 *
 * ## Which bump the fault reaches — the trap
 *
 * A record push bumps twice: the arrival writer over what it is HANDED, and the door's `finally` over everything it
 * RECEIVED. With the page's top seq on a record the writer is handed, the writer's bump fails first and masks the
 * door's — so a mutation that swallows the door's counter error would pass. Every record case here puts the top
 * seq on a TOMBSTONED document, which the planner never hands to the writer: only the door's own bump reaches it.
 * The tombstone door's bump is the apply's post-step, reached by any tombstone above the ceiling.
 *
 * The fault is REAL: a validator on `ythril_counters` refusing a seq above a ceiling for one space
 * (`_write-faults.mjs withCounterCeiling`). The order gate `a-push-bumps-before-it-answers` stays green under the
 * mutation this file exists for (`await bumpSeq(…).catch(log)` is still an awaited bump), which is why the rule is
 * held by behaviour here.
 *
 * Seen red by mutation, restored by hand: `api/sync/docs.ts` `acceptPushedPage`'s `finally` changed from
 * `await bumpSeq(spaceId, maxReceived);` to `await bumpSeq(spaceId, maxReceived).catch(err => log.warn(String(err)));`
 * — the five record doors answer 200 (`tombstoned`/`ok`) over a counter left at the ceiling. And separately
 * `sync/tombstone-apply.ts`'s post-step `if (!failed) throw new TombstoneCounterError(…)` changed to log instead of
 * throw — the tombstone door answers 200 `{ applied: 1 }`. Green on the unchanged code: this file is the gate that
 * keeps `Q-224`'s restructure of both `finally`s from swallowing the door's counter error.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/every-push-door-answers-500-over-a-counter-it-could-not-move-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { moduleIndex, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { withCounterCeiling } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'ctrdoors';
const CEILING = 100;
const TOP = 500;
const BUMP = 'server/src/util/seq.ts:bumpSeq';

/** The push doors that move the counter: POST routes of the sync surface whose handler reaches `bumpSeq`. */
function counterDoors() {
  const index = moduleIndex('server/src');
  return mountedRoutes()
    .filter(r => r.method === 'POST' && r.file.startsWith('server/src/api/sync/'))
    .filter(r => walkFrom(index, routeHandlerRoots(index, r), { closures: true }).seen.has(BUMP))
    .map(r => ({ path: r.path, routePath: r.routePath, file: r.file }));
}
const DOORS = counterDoors();

/**
 * Per door: what to bury (a tombstone at TOP + 100 for a record the page carries at TOP, so the planner never hands
 * it to the writer) and the body. Literal on purpose — the derivation decides a case is owed.
 */
const tombstoned = (kind, type) => ({
  bury: () => door.coll(S, 'tombstones').insertOne(build.tombstone(S, `buried-${kind}`, type, TOP + 100)),
  doc: () => build[kind](S, `buried-${kind}`, TOP),
});
const CASES = {
  '/facts': { ...tombstoned('fact', 'fact'), body: (t) => t.doc() },
  '/entities': { ...tombstoned('entity', 'entity'), body: (t) => t.doc() },
  '/edges': { ...tombstoned('edge', 'edge'), body: (t) => t.doc() },
  '/chrono': { ...tombstoned('chrono', 'chrono'), body: (t) => t.doc() },
  '/batch-upsert': { ...tombstoned('fact', 'fact'), body: (t) => ({ facts: [t.doc()] }) },
  '/tombstones': { bury: async () => {}, body: () => ({ tombstones: [build.tombstone(S, 'never-stored', 'fact', TOP)] }) },
};

let door;

describe('every push door answers 500 over a counter it could not move', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'ctrdoors', spaces: [{ id: S, label: S, folders: [], meta: {} }] });
    await door.setCounter(S, 1); // the counter collection must exist for collMod
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the derivation finds the counter-moving push doors, so an empty set cannot pass', () => {
    assert.ok(DOORS.length >= 6, `only ${DOORS.length} push door(s) reach bumpSeq — re-anchor: ${JSON.stringify(DOORS)}`);
    assert.ok(DOORS.some(d => d.routePath === '/batch-upsert') && DOORS.some(d => d.routePath === '/tombstones'),
      `the batch or tombstone door was not derived: ${JSON.stringify(DOORS)}`);
  });

  it('every derived door has a case', () => {
    const missing = DOORS.filter(d => !CASES[d.routePath]).map(d => `${d.file} POST ${d.path}`);
    assert.deepEqual(missing, [], 'a push door that moves the counter with no case here is one nobody checked for a 200 over a stuck counter');
  });

  for (const d of DOORS) {
    const c = CASES[d.routePath];
    if (!c) continue;
    it(`POST ${d.path}: a counter that cannot move answers 500, and the re-send moves it`, async () => {
      await c.bury();
      const body = c.body(c);
      const r = await withCounterCeiling(door.mongo.getDb(), S, CEILING, () => door.push(d.routePath, body, { spaceId: S }));
      assert.ok(r.code >= 500 || r.counterAtResponse >= TOP,
        `POST ${d.path} answered ${r.code} ${JSON.stringify(r.body)} with the counter at ${r.counterAtResponse}, behind the seq ${TOP} `
        + 'it received: the sender advances past this page and the counter never catches up');
      assert.equal(r.code, 500, `POST ${d.path} answered ${r.code} over a counter it could not move: ${JSON.stringify(r.body)}`);
      // The fault gone, the page the 500 kept is offered again — and this time the counter passes what it carried.
      const again = await door.push(d.routePath, body, { spaceId: S });
      assert.ok(again.code < 300, `the re-send answered ${again.code}: ${JSON.stringify(again.body)}`);
      assert.ok(again.counterAtResponse >= TOP, `after the re-send the counter is at ${again.counterAtResponse}, behind ${TOP}`);
    });
  }
});

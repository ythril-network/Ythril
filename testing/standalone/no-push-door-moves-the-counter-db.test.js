/**
 * No push door moves the counter, so none can answer 500 over one that would not move (bundle-81, design rev 8 §1a, D-19 B). The inverse of what this file
 * held until then (`every-push-door-answers-500-over-a-counter-it-could-not-move-db`, `Q-271`: "every push door whose handler moves the counter answers
 * `500` when the counter could not be moved — never a success over a counter left behind what it received"); the reason is stated here so the inversion
 * is not read as a weakened gate.
 *
 * ## Why the rule turned over
 *
 * A push used to raise the counter over what it received, before it answered, so a counter that could not be raised had to fail the page (a 200 over a
 * counter left behind told the sender to advance its watermark past a record the next local write could then sort below). A seq is a version now and the
 * counter follows no arrival (`a-push-leaves-the-counter-where-it-was-db`), so there is nothing a counter failure could be a 200 over. What can still go
 * wrong is the other way: a door that ASKS for the counter — by calling `raiseVersionTo` (`util/version-stamp.ts`, the counter's one raiser) — starts failing
 * pages again when the counter is unwell, and lifts every later stamp of the space to a peer's clock.
 *
 * ## The doors — derived through the call graph, never listed
 *
 * Every POST route mounted from `server/src/api/sync/` whose handler reaches an arrival writer (`writeArrivals`, `applyPeerTombstones`), with a floor (the
 * record doors, `/batch-upsert` and `/tombstones`), each with a case below. The other POST routes of the surface (votes, pairing, warm, change notes) carry no
 * record and are not doors of this rule.
 *
 * ## The two halves
 *
 *  - **static** (needs no database, so it runs in the pure file beside this one, `no-push-door-moves-the-counter.test.js`, Q-969): no handler of those doors reaches `raiseVersionTo` (closures followed, the walk the old gate used to find the doors that DID). The
 *    function is checked to exist, so a rename cannot turn the walk into one over nothing.
 *  - **behavioural**: with the counter collection refusing every seq above a ceiling for the space (`_write-faults.mjs withCounterCeiling`), a page whose
 *    highest seq is above it, on a record the planner never hands to the writer (a TOMBSTONED one — where the old door's own bump used to be the only thing
 *    that reached the counter), is answered below 500 and its counter is where it was.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/no-push-door-moves-the-counter-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { DOORS, CASE_PATHS } from './_push-door-counter-doors.mjs';
import { withCounterCeiling } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'ctrdoors';
const CEILING = 100;
const TOP = 500;
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

// The doors the pure file asks about are the doors this table has a case for: a difference fails the file as it loads (Q-969).
assert.deepEqual(Object.keys(CASES).sort(), [...CASE_PATHS].sort(), 'CASES and CASE_PATHS (_push-door-counter-doors.mjs) name different doors');

let door;

describe('no push door moves the counter, so none answers 500 over one that would not move', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'ctrdoors', spaces: [{ id: S, label: S, folders: [], meta: {} }] });
    await door.setCounter(S, 1); // the counter collection must exist for collMod
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.setCounter(S, 1); });

  for (const d of DOORS) {
    const c = CASES[d.routePath];
    if (!c) continue;
    it(`POST ${d.path}: with a counter that refuses everything above ${CEILING}, the page is answered below 500 and the counter stays`, async () => {
      await c.bury();
      const body = c.body(c);
      const r = await withCounterCeiling(door.mongo.getDb(), S, CEILING, () => door.push(d.routePath, body, { spaceId: S }));
      assert.ok(r.code < 500, `POST ${d.path} answered ${r.code} ${JSON.stringify(r.body)} over a counter nothing asked to move`);
      assert.equal(await door.counter(S), 1, `POST ${d.path} moved the counter to ${await door.counter(S)} (it stood at 1)`);
    });
  }
});

/**
 * A seed that fails inside `ownPositionMark` records nothing, and the peer still gets its tombstones (bundle-81, decision 34, P47 second
 * form; plan rev 8 §1b "The seed" and §4 "Served fold").
 *
 * ## The rule
 *
 * `ownPositionMark(spaceId, value)` in `sync/served-watermark.ts` is the ONE function that writes a position mark this instance answers
 * for (the served fold and the pushed mark both go through it). It returns `min(value, settledPositionCap(records, spaceId))`, so a puller
 * that sends `afterPos ≈ 2^53` cannot drive the seed to the ceiling. The cap is async (the clock is seeded from the store once), so the
 * function awaits it INSIDE a try/catch (decision 34):
 *
 *  1. with a healthy store it answers the capped mark (a value above the cap is cut to it; a value below stays);
 *  2. with the seed read FAILING it records nothing: it resolves to no mark (`null`, "nothing to write", as `foldServedSeq` does) and
 *     NEVER throws, because the fold runs on the tombstone pull's hot path and a throw there would turn a read the peer is owed into a
 *     500;
 *  3. the failed seed is not remembered: once the store answers, the same call answers the capped mark, and the tombstone page serves
 *     every tombstone the peer is owed.
 *
 * ## The failure is injected at the seed read
 *
 * The seed is the descending read of the stored maximum `pos` (the `(pos, _id)` index read backwards, limit 1). Only that read is made to
 * reject (a `find` whose `sort` names `pos: -1`), so the fault is the seed's and no page read is touched. A space this process has never
 * stamped in is used, since a seeded stream never reads again: that is what a restart looks like.
 *
 * ## The assumption this file makes
 *
 * `ownPositionMark` is exported from `sync/served-watermark.js` and takes `(spaceId, value)` (rev 8 §1b names both), and answers a number
 * or `null`. The tombstone page is read through the real route, `GET /tombstones` with `afterPos`.
 *
 * Database `b81tC_seedfail`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/a-failed-position-seed-records-nothing-and-the-peer-still-gets-its-tombstones-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor, moduleOrNull } from './_b81c-door.mjs';
import { build, peerToken } from './_push-door.mjs';
import { failTheSeedRead } from './_b81c-seed-fault.mjs';

const skip = await mongoSkipReason();
const SPACE = 'seedfail';
const PEER = peerToken('b81c-puller');
const FACT_IDS = ['bbbbbbbb-0000-4000-8000-0000000000d1', 'bbbbbbbb-0000-4000-8000-0000000000d2'];

describe('a failed position seed records nothing and the peer still gets its tombstones', { skip }, () => {
  let door, served, fact, restore = () => {};

  before(async () => {
    door = await openB81cDoor({ name: 'seedfail', spaces: [SPACE] });
    served = await moduleOrNull('sync/served-watermark.js');
    fact = await import('../../server/dist/brain/fact.js');
    await door.coll(SPACE, 'facts').insertMany(FACT_IDS.map(id => build.fact(SPACE, id, 0)));
  });
  after(async () => { restore(); await door?.close(); });

  const failTheSeed = () => { restore = failTheSeedRead(door.mongo, SPACE); };

  it('sync/served-watermark.js exports ownPositionMark (the one writer of a position mark this instance answers for)', () => {
    assert.ok(served, 'sync/served-watermark.js is missing');
    assert.equal(typeof served.ownPositionMark, 'function', 'ownPositionMark(spaceId, value) is not exported: the served fold and the pushed mark each cap their value through it');
  });

  it('with the seed read failing: no mark is recorded, nothing is thrown', async () => {
    assert.equal(typeof served?.ownPositionMark, 'function', 'ownPositionMark is not exported');
    failTheSeed();
    let mark;
    await assert.doesNotReject(async () => { mark = await served.ownPositionMark(SPACE, Number.MAX_SAFE_INTEGER); },
      'ownPositionMark threw on a failed seed: the tombstone pull runs it on its hot path, and the peer would be answered 500');
    assert.ok(mark === null || mark === undefined, `a failed seed recorded ${mark}: a mark above the cap seeds the clock to the ceiling for good`);
  });

  it('the failed seed is not remembered: once the store answers, the mark is capped, and the peer is served every tombstone it is owed', async () => {
    assert.equal(typeof served?.ownPositionMark, 'function', 'ownPositionMark is not exported');
    restore();
    for (const id of FACT_IDS) assert.equal(await fact.deleteFact(SPACE, id), true);
    const r = await door.pull('/tombstones', { spaceId: SPACE, afterPos: '0' }, PEER);
    assert.equal(r.code, 200, JSON.stringify(r.body));
    const ids = (Array.isArray(r.body?.items) ? r.body.items : Object.values(r.body ?? {}).flat()).map(t => t._id);
    assert.deepEqual(FACT_IDS.filter(id => !ids.includes(id)), [], 'the peer was not served the tombstones it is owed');
    const mark = await served.ownPositionMark(SPACE, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof mark, 'number', 'after the store answered, the mark is still not recorded: the failed seed was remembered');
    assert.ok(mark < Number.MAX_SAFE_INTEGER, `a puller's afterPos of 2^53 - 1 was recorded as ${mark}: the cap is not applied`);
    assert.ok(mark >= (r.body?.through ?? 0), 'the capped mark is below what the page answered it was complete through');
  });
});

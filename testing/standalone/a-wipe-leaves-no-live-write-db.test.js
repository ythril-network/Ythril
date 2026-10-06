/**
 * The push door's `wipe(space)` does not return while a write on that space is still ALIVE (`Q-372`) — and it throws,
 * naming the collection, when the write does not end.
 *
 * ## The defect
 *
 * `wipe` (`_push-door.mjs`) cleared a space between cases after waiting for the door's tracked COUNTER writes — client
 * promises. A write whose client gave up (a bound that fired on the client's clock first) or one still waiting behind a
 * lock has no such promise to wait for, so `wipe` emptied the collections while it was alive, and the write landed
 * afterwards: the fork of one case was in the next case's space (`E11000` on its lock, main's CI run 37231507558). A
 * wipe that returns means the space is EMPTY AND STAYS EMPTY — which is only true once nothing that could write to it is
 * still running.
 *
 * ## The rule this file holds
 *
 * **`wipe` returns only when the server has no active operation on the space's collections, and what such a write left
 * behind is gone when it returns.** It is held against a push of a fork stalled behind a real lock
 * (`_write-faults.mjs holdDocumentLock`), the stall the doors' tests use: while the write is alive `wipe` is still
 * waiting; when the lock goes, the write lands and `wipe` returns with the collection empty — identity, not a count.
 * And when the write does NOT end, `wipe` throws and names the collection, rather than reporting an empty space over a
 * live write.
 *
 * ## What it does not do
 *
 * It does not say how long the wipe may wait; only that it waits while something is alive and ends when it is not.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-wipe-leaves-no-live-write-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { settleWithin } from './_write-faults.mjs';
import { waitForLiveWrite } from './_active-operations.mjs';
import { holdForkLock, seedDoorSpace, DOOR_FACT_ID as F, DIVERGENT } from './_stalled-write-doors.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'wipelive';
/** How long `wipe` is given to (wrongly) return while the write is alive. */
const WAITS_FOR_MS = 1500;

let door, plan;

/** Stall a pushed fork behind a lock on its derived id; returns once the fork's write is alive in the server. */
async function stallAFork() {
  const lock = await holdForkLock(door.mongo, plan, S, F);
  const push = door.push('/facts', build.fact(S, F, 3, { fact: DIVERGENT }), { spaceId: S }).then(r => r, err => err);
  const alive = await waitForLiveWrite(door.mongo, `${S}_facts`);
  return { lock, push, alive };
}

describe('wipe leaves no live write', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'wipelive', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    plan = await import('../../server/dist/sync/upsert-plan.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await seedDoorSpace(door, S); });

  it('wipe waits while a write on the space is alive, and what that write lands is gone when wipe returns', { timeout: 60_000 }, async () => {
    const { lock, push, alive } = await stallAFork();
    let early;
    try {
      assert.ok(alive, 'fixture: the fork write was never active in the server — the stall is not real');
      const wiping = door.wipe(S);
      early = await settleWithin(wiping, WAITS_FOR_MS);
    } finally {
      await lock.release();
    }
    await push;
    const done = await settleWithin(early?.rest ?? Promise.resolve(), 20_000);
    const leftover = (await door.coll(S, 'facts').find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
    await door.wipe(S);
    assert.equal(early?.settled, false,
      `wipe returned after ${early?.elapsedMs} ms with a write on '${S}' still alive in the server — it empties the space and the write lands afterwards`);
    assert.ok(done.settled && done.ok, `wipe did not finish once the write had ended: ${done.error?.stack ?? 'still waiting'}`);
    assert.deepEqual(leftover, [], `documents survived a wipe: the write that was alive when it started landed after it emptied the space`);
  });

  it('wipe THROWS, naming the collection, when a write on the space does not end', { timeout: 60_000 }, async () => {
    const { lock, push, alive } = await stallAFork();
    try {
      assert.ok(alive, 'fixture: the fork write was never active in the server — the stall is not real');
      await assert.rejects(() => door.wipe(S, { drainMs: WAITS_FOR_MS }),
        err => err instanceof Error && err.message.includes(`${S}_facts`),
        'wipe returned over a space with a live write instead of throwing — the caller cannot tell the space is not clean');
    } finally {
      await lock.release();
      await push;
    }
    await door.wipe(S);
  });
});

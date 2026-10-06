/**
 * A rename or delete refused behind a pending space op that could not be resumed says why in OUR words (bundle-53 G21, G7's
 * note: the second leak path of the class G7 closed in `spaces/rename.ts`).
 *
 * ## What was wrong
 *
 * `settlePendingSpaceOpBefore` resumes the marker a crashed op left, and when the resume cannot finish it refuses the caller's
 * own op with `pendingOpStillFailingMessage(pending, attempted, reason)` — a sentence that reaches the caller. The reason came
 * from two places, and both carried the driver's text:
 *
 *  - a pending DELETE: `dropSpaceData` collected `Could not drop collection <name>: ${err}` per collection, so a server
 *    refusal (its text names the collection, the index and the values) went into the sentence;
 *  - a pending RENAME whose `moveSpaceData` threw a failure on the store's side: the resume's `catch` took `err.message` as
 *    the reason, so the store's own words (an internal host and port) went into the sentence — and the store's failure, which
 *    every door answers as `503` with `Retry-After`, was answered as an ordinary refusal.
 *
 * ## What this holds
 *
 *  - a driver refusal under a pending delete is worded generically (`refusalText`), its text goes to the log;
 *  - a store failure under a pending rename is RETHROWN to the door as the store's failure (`storeFailureAnswer` answers it
 *    `503`), with none of the driver's text in the message.
 *
 * Both faults are real driver errors (`driverWriteFailures`), thrown by the collection call the act makes.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-pending-space-op-that-cannot-resume-refuses-in-our-words-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'pendingleak';
const DEL = 'pendingdel';
const REN = 'pendingren';
const REN_TO = 'pendingren2';
/** What a server refusal and a dead store say — none of it may reach the sentence a caller reads. */
const DRIVER_TEXT = /E11000|duplicate key|Mongo\w*Error|ECONNREFUSED|ServerSelection|127\.0\.0\.1|_driver_write_failures|dup key/i;

describe('a pending space op that cannot be resumed refuses in our words', { skip }, () => {
  let door, lifecycle, loader, storeFailure, failures, patch, db;

  before(async () => {
    door = await openPushDoor({ suite: SUITE, spaces: [{ id: DEL, label: DEL, folders: [] }, { id: REN, label: REN, folders: [] }] });
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    loader = await import('../../server/dist/config/loader.js');
    storeFailure = await import('../../server/dist/brain/store-failure.js');
    db = door.mongo.getDb();
    failures = await driverWriteFailures(`ythril_harness_${SUITE}`);
    patch = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['drop', 'rename']);
  });
  after(async () => {
    patch?.restore();
    await door?.close();
  });

  const setMarker = (op) => loader.mutateConfig(cfg => { cfg.pendingSpaceOp = { startedAt: '2026-10-06T00:00:00.000Z', ...op }; });
  const clearMarker = () => loader.mutateConfig(cfg => { delete cfg.pendingSpaceOp; });

  it('control: the faults are real driver errors the classifier tells apart', () => {
    assert.ok(storeFailure.storeFailureAnswer(failures.storeGone.single, 'test'), 'the store-gone error is not recognised as the store\'s');
    assert.equal(storeFailure.storeFailureAnswer(failures.refused.duplicateKey, 'test'), null,
      'a server refusal is recognised as the store\'s condition: it is not a store failure and this test would prove nothing');
  });

  it('a driver refusal under a pending DELETE is worded generically, and the text is not in the sentence', async () => {
    setMarker({ type: 'delete', spaceId: DEL });
    patch.fail('drop', `${DEL}_facts`, failures.refused.duplicateKey);
    let thrown;
    try { await lifecycle.settlePendingSpaceOpBefore('rename a space'); } catch (err) { thrown = err; } finally { patch.clear(); }
    assert.ok(thrown instanceof Error, 'a pending delete that could not drop a collection did not refuse the caller\'s op');
    assert.match(thrown.message, /still pending/, `not the pending-op refusal: ${thrown.message}`);
    assert.doesNotMatch(thrown.message, DRIVER_TEXT, `the refusal carries the driver's text: ${thrown.message}`);
    assert.equal(storeFailure.storeFailureAnswer(thrown, 'test'), null, 'a server refusal was answered as the store being down');
    clearMarker();
  });

  it('a store failure under a pending RENAME reaches the door as the store\'s failure (503), not as a refusal', async () => {
    setMarker({ type: 'rename', spaceId: REN, newId: REN_TO });
    await db.createCollection(`${REN}_probe_rename`).catch(() => {});
    patch.fail('rename', `${REN}_probe_rename`, failures.storeGone.single);
    let thrown;
    try { await lifecycle.settlePendingSpaceOpBefore('delete a space'); } catch (err) { thrown = err; } finally { patch.clear(); }
    assert.ok(thrown, 'a pending rename that could not move a collection did not refuse the caller\'s op');
    // What a door sends is `storeFailureAnswer`'s body (the error's own message goes to the log, never to the caller).
    const answer = storeFailure.storeFailureAnswer(thrown, 'test');
    assert.ok(answer, `the store's failure was answered as an ordinary refusal, in the sentence: ${thrown.message}`);
    assert.equal(answer.status, 503);
    assert.doesNotMatch(JSON.stringify(answer.body), DRIVER_TEXT, `the 503 carries the driver's text: ${JSON.stringify(answer.body)}`);
    clearMarker();
  });
});

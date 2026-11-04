/**
 * A write door whose job write failed says so on the file's row, and the same bytes sent again are processed (bundle-236, Q-698,
 * DESIGN v3 C5).
 *
 * ## The defect that bought it
 *
 * `dispatchFileProcessing` writes the row `pending`, then writes the job, and logs and SWALLOWS a failure of the job write. The
 * row then reads `pending` with no job anywhere: a spinner nothing will ever end. And the next arrival of the same bytes finds a row
 * that reads `pending` under the same hash, which `settledAndIdentical` calls "work under way", so it is skipped too: the file is
 * stuck for as long as its bytes stay the same, and a person's re-upload, the one thing that would help, is the thing that is refused.
 *
 * ## The rules
 *
 *  1. When the door's write of the job fails, the file's row reads `failed` with a `mediaJobError`, not `pending`. (The door's answer
 *     to the caller is the door's own; the rule is the row.)
 *  2. The same bytes sent again are processed: the job is created and the row reads `pending` again.
 *
 * ## How the failure is made
 *
 * The first write of a job document at the path (`insertOne` or `updateOne` on the space's media jobs) throws once, as a driver
 * refusing it would; every other call passes. The patch is on the driver's `Collection` prototype and is put back after each case.
 *
 * ## Seen red
 *
 * On abe1bde3b the row reads `pending` with no job, and the re-upload is answered `pending` with no job created.
 *
 * Run: node --test testing/standalone/a-failed-job-write-at-the-door-reads-failed-and-a-reupload-is-processed-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'doorfails';
const FILE = 'stuck.png';
const BYTES = 'the bytes that were sent twice';

let d;
let restore = () => {};

/** Make the next write of a job document at this space throw once, whichever driver method the door writes it with. */
function failNextJobWrite() {
  const proto = Object.getPrototypeOf(d.jobs());
  const methods = ['insertOne', 'updateOne', 'findOneAndUpdate', 'replaceOne'];
  const originals = Object.fromEntries(methods.map(m => [m, proto[m]]));
  let armed = true;
  for (const m of methods) {
    proto[m] = function failing(...args) {
      if (armed && this.collectionName === `${SPACE}_media_jobs`) { armed = false; return Promise.reject(new Error('injected: the job write failed')); }
      return originals[m].apply(this, args);
    };
  }
  restore = () => { for (const m of methods) proto[m] = originals[m]; restore = () => {}; };
  return { fired: () => !armed };
}

describe('a failed job write at the door reads failed, and a re-upload is processed (real MongoDB)', { skip }, () => {
  before(async () => { d = await openReplacedBytesDoor({ suite: 'doorfails', space: SPACE }); });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });
  afterEach(() => restore());

  it('the row reads failed, not pending, when the job could not be written', async () => {
    const fault = failNextJobWrite();
    await d.put(FILE, BYTES, { lenient: true });
    restore();
    assert.equal(fault.fired(), true, 'fixture check: the door wrote no job document, so nothing was injected');
    assert.equal(await d.jobs().countDocuments({ _id: FILE }), 0, 'fixture check: the failed write left no job');
    const row = await d.files().findOne({ _id: FILE });
    assert.equal(row.embeddingStatus, 'failed', `the row reads "${row.embeddingStatus}" with no job behind it: a spinner nothing ends`);
    assert.ok(row.mediaJobError, 'the row says nothing about why it failed');
  });

  it('the same bytes sent again are processed: a job is made and the row reads pending', async () => {
    const fault = failNextJobWrite();
    await d.put(FILE, BYTES, { lenient: true });
    restore();
    assert.equal(fault.fired(), true, 'fixture check: nothing was injected');

    await d.put(FILE, BYTES);
    const job = await d.jobs().findOne({ _id: FILE });
    assert.ok(job, 'the re-upload of the same bytes was skipped as work under way: settledAndIdentical read the pending row of a job that never existed');
    assert.equal(job.status, 'pending');
    assert.equal((await d.files().findOne({ _id: FILE })).embeddingStatus, 'pending');
  });
});

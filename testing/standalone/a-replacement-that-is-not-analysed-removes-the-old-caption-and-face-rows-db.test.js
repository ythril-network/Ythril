/**
 * Bytes that replace a file and are NOT analysed (over `maxFileSizeBytes`, or the class switched off for the space) take the old
 * bytes' caption and face rows with them, and the job that would have written more (bundle-236, Q-698, DESIGN v3 C4).
 *
 * ## The defect that bought it
 *
 * The write door's skipped branches record `embeddingStatus: 'skipped'` and return. The file's derived rows (its caption
 * `<path>#media-chunk0` and its face rows `<path>#face-chunkN`) were made from the bytes that are now gone, and nothing removes
 * them: recall keeps finding the replaced picture by the caption of the one before, and the face gallery keeps matching a person
 * the new file may not even show. A new run would have cleared them at its start; a skipped replacement has no run, so the door
 * is the only place that can.
 *
 * ## The rules
 *
 *  1. A replacement over the size cap, and a replacement while the class is off for the space, each leave NO derived row under the path
 *     (and the row reads `skipped`).
 *  2. The job of the old bytes is revoked: nothing is left claimable at the path, so a run of the old bytes cannot write a row after
 *     the delete.
 *
 * ## Seen red
 *
 * On abe1bde3b both causes leave `<path>#media-chunk0` and `<path>#face-chunk0` in place, and the pending job of the old bytes stays
 * claimable.
 *
 * Run: node --test testing/standalone/a-replacement-that-is-not-analysed-removes-the-old-caption-and-face-rows-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openReplacedBytesDoor } from './_replaced-bytes-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'skippedreplace';
const FILE = 'portrait.png';
const OLD = 'the bytes of the portrait before it was replaced';
const NEW = 'the bytes of the portrait that replaced it, which are skipped';

let d;
const spaceConfig = () => d.loader.getConfig().spaces.find(s => s.id === SPACE);

/** Each way a replacement is not analysed: the arrangement and its undoing. */
const CAUSES = {
  'over maxFileSizeBytes': { arrange: () => d.capMediaBytes(10), undo: () => d.capMediaBytes(null) },
  'the image class off for the space': { arrange: () => { spaceConfig().imageAnalysis = 'off'; }, undo: () => { delete spaceConfig().imageAnalysis; } },
};

describe('a replacement that is not analysed removes the old caption and face rows (real MongoDB)', { skip }, () => {
  let cause;
  before(async () => { d = await openReplacedBytesDoor({ suite: 'skippedreplace', space: SPACE }); });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); });
  afterEach(() => { cause?.undo(); cause = undefined; });

  /** The old bytes analysed (a caption row and a face row stored, the job at rest), then replaced by bytes that are skipped. */
  async function replaceBy(name) {
    await d.put(FILE, OLD);
    // Claimable now, as it would be once its settle delay is over: only a revocation by the replacement can keep it from a worker.
    await d.jobs().updateOne({ _id: FILE }, { $set: { claimableAfter: null } });
    const ids = await d.seedDerived(FILE);
    assert.deepEqual(await d.derivedIds(FILE), [...ids].sort(), 'fixture check: the old rows are stored');
    cause = CAUSES[name];
    cause.arrange();
    await d.put(FILE, NEW);
  }

  for (const name of Object.keys(CAUSES)) {
    it(`${name}: the replacement is skipped and no caption or face row of the old bytes is left`, async () => {
      await replaceBy(name);
      assert.equal((await d.files().findOne({ _id: FILE })).embeddingStatus, 'skipped', 'fixture check: the replacement was skipped');
      assert.deepEqual(await d.derivedIds(FILE), [],
        'the rows made from the bytes that are gone are still stored under the replaced path: recall and the face gallery keep answering from them');
    });

    it(`${name}: the job of the old bytes is revoked, nothing is left claimable at the path`, async () => {
      await replaceBy(name);
      d.queue.markSpaceMayHaveWork(SPACE);
      const claimed = await d.queue.claimNextJob([SPACE]);
      assert.equal(claimed, null, `a worker claimed the job of the old bytes (${claimed?._id}): its run would write rows for a file that was not analysed`);
    });
  }
});

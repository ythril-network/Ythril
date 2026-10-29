/**
 * A restore forgets what was learned of the space's legacy file ids AFTER its page has landed, not only before (Q-413, bundle-88 review F5).
 *
 * ## The rule
 *
 * A restore (`writeArrivals` with `restore: true`, the admin import) keeps ids that are not their path's key, so it can bring pre-bundle-71 rows
 * back, and the index of a space's legacy ids (`legacyIdsOf`, built by the first door that asks and cached for the process) is forgotten for it.
 * Forgotten only BEFORE the write, a door that builds the index between the forget and the write (a GET's lookup, a sync cycle's adoption) caches an
 * index without the rows about to land, and those rows stay invisible and refused by peers until the process restarts: the Q-413 defect again.
 *
 *  1. A door that builds the index while the restore's page is being written still finds the legacy row the page brought, once the restore has
 *     answered: the index is forgotten again after the page has landed.
 *  2. The early forget stays: a restore that has not reached its write has already dropped what was learned before it.
 *
 * ## Seen red
 *
 * On the base 1: the index built between the forget and the write was kept, and the row the page landed was not found by `legacyIdsOf`. The read is
 * made deterministic by wrapping the driver's bulk write for the space's files collection: the wrapper builds the index and then lets the write go.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-restore-forgets-the-legacy-index-after-its-write-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { build } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'restoreindex';
const LEGACY = 'a//b.txt';
const KEY = 'a/b.txt';

let d, forgetLegacyIndex, legacyIdsOf, writeArrivals;

/** The files-collection bulk write of the space, made to run `before` first; `restore()` puts the driver back. */
function beforeFilesBulkWrite(before) {
  const original = Collection.prototype.bulkWrite;
  const wrapper = { fired: 0, restore: () => { Collection.prototype.bulkWrite = original; } };
  Collection.prototype.bulkWrite = async function wrapped(...args) {
    if (this.collectionName === `${S}_files`) { wrapper.fired++; await before(); }
    return original.apply(this, args);
  };
  return wrapper;
}

describe('a restore forgets the legacy index after its page has landed', { skip }, () => {
  before(async () => {
    d = await openFileActDoors({ suite: 'restoreindex', space: S });
    ({ forgetLegacyIndex, legacyIdsOf } = await import('../../server/dist/files/legacy-file-keys.js'));
    ({ writeArrivals } = await import('../../server/dist/sync/arrivals.js'));
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => { await d.reset(); forgetLegacyIndex(S); });

  it('an index built while the page is being written does not hide the rows the page brings (1)', async () => {
    const wrapper = beforeFilesBulkWrite(async () => { assert.deepEqual(await legacyIdsOf(S, KEY), [], 'fixture: the legacy row is already there'); });
    let out;
    try {
      out = await writeArrivals(S, 'files', 'file', [build.filemeta(S, LEGACY, 7, { sizeBytes: 3 })], { restore: true });
    } finally { wrapper.restore(); }
    assert.ok(wrapper.fired > 0, 'the page was not written through the files collection\'s bulk write: the test read nothing between the forget and the write');
    assert.ok([...out.inserted, ...out.updated].includes(LEGACY), `the restore did not store the legacy row: ${JSON.stringify(out)}`);
    assert.deepEqual(await legacyIdsOf(S, KEY), [LEGACY], 'the index built mid-write was kept: the restored legacy row is invisible until the process restarts');
  });

  it('a restore drops what was learned before it (2)', async () => {
    assert.deepEqual(await legacyIdsOf(S, KEY), [], 'fixture: the index is built empty');
    await d.door.coll(S, 'files').insertOne(build.filemeta(S, LEGACY, 7, { sizeBytes: 3 }));
    await writeArrivals(S, 'files', 'file', [build.filemeta(S, 'other.txt', 2, { sizeBytes: 3 })], { restore: true });
    assert.deepEqual(await legacyIdsOf(S, KEY), [LEGACY], 'the index learned before the restore was kept');
  });
});

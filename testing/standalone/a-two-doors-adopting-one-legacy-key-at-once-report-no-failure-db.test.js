/**
 * Two doors that re-key one legacy file row at the same instant report no failure: the one that lost the race finds the work done (Q-413, bundle-88 review F8).
 *
 * ## The rule
 *
 * The re-key plans against what it read (no row at the key, so the legacy row wins) and the transaction refuses when a row appeared at the key
 * since (`StaleRekeyPlan`). Two doors that adopt the same key concurrently (a sync cycle's `adoptAllLegacyRows` and a request's
 * `adoptLegacyRowsUnder`) can meet exactly that: the second one's plan is stale because the FIRST did what it was about to do.
 *
 *  1. The row ends at its key, once, and nothing is left at the legacy id.
 *  2. The loser says nothing: no "Legacy file row re-key" line (the step the shared reporter keeps one line per window for). A refusal that
 *     means "the other door did it" is not a failure an operator can act on.
 *  3. A real failure of the re-key is still said (control: a store that refuses the write is not mistaken for the race).
 *
 * ## Seen red
 *
 * On the base 2: the loser's `StaleRekeyPlan` was reported through the reporter as a failed re-key. The interleaving is made deterministic: the read
 * of the key's row (the loser's plan) is followed by the winner's whole re-key before the loser goes on to its transaction.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/a-two-doors-adopting-one-legacy-key-at-once-report-no-failure-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'mongodb';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { build } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'rekeyrace';
const LEGACY = 'a//b.txt';
const KEY = 'a/b.txt';
const STEP = /Legacy file row re-key/;

let d, forgetLegacyIndex, adoptLegacyRow, rekeyLegacy;
const rows = () => d.door.coll(S, 'files');

/** After the read of the KEY's row that a re-key plans by, run `between` once (the other door's whole re-key), then hand the plan its stale answer. */
function afterTheKeyRowIsRead(between) {
  const original = Collection.prototype.find;
  let running = false;
  Collection.prototype.find = function spied(filter, options) {
    const cursor = original.call(this, filter, options);
    const ids = filter?._id?.$in;
    if (this.collectionName === `${S}_files` && !running && Array.isArray(ids) && ids.length === 1 && ids[0] === KEY && options?.projection?.deletedAt === 1) {
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const read = await toArray();
        running = true;
        try { await between(); } finally { running = false; }
        return read;
      };
    }
    return cursor;
  };
  return () => { Collection.prototype.find = original; };
}

describe('two doors adopting one legacy key at once', { skip }, () => {
  before(async () => {
    d = await openFileActDoors({ suite: 'rekeyrace', space: S });
    ({ forgetLegacyIndex, adoptLegacyRow } = await import('../../server/dist/files/legacy-file-keys.js'));
    ({ rekeyLegacy } = await import('../../server/dist/files/legacy-file-rekey.js'));
  });
  after(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.reset();
    await d.files.writeFile(S, KEY, 'abc');
    await rows().insertOne(build.filemeta(S, LEGACY, 7, { sizeBytes: 3 }));
    forgetLegacyIndex(S);
  });

  it('the one that lost the race reports no failure, and the row is at its key once (1, 2)', async () => {
    let restore = () => {};
    const { lines } = await logLinesDuring(async () => {
      restore = afterTheKeyRowIsRead(() => rekeyLegacy(S, KEY, [LEGACY]));
      try { await adoptLegacyRow(S, KEY); } finally { restore(); }
    });
    assert.equal(await rows().findOne({ _id: LEGACY }), null, 'the legacy row is still at its legacy id');
    assert.equal(await rows().countDocuments({ _id: KEY }), 1, 'the key does not hold its row exactly once');
    assert.deepEqual(lines.filter(l => STEP.test(l)), [], 'a door that found the work already done reported it as a failed re-key');
  });

  it('a re-key the store refuses is still said (3)', async () => {
    // Its own key: the reporter keeps one line per window and unit, so the race above must not have used up this one's.
    const [legacy, key] = ['c//d.txt', 'c/d.txt'];
    await d.files.writeFile(S, key, 'abc');
    await rows().insertOne(build.filemeta(S, legacy, 7, { sizeBytes: 3 }));
    forgetLegacyIndex(S);
    const insertMany = Collection.prototype.insertMany;
    const { lines } = await logLinesDuring(async () => {
      // The re-key writes the row at its key through one insert; a store that refuses it fails the re-key for a reason that is no race.
      Collection.prototype.insertMany = async function failing(...args) {
        if (this.collectionName === `${S}_files`) throw new Error('the store refused the write');
        return insertMany.apply(this, args);
      };
      try { await adoptLegacyRow(S, key); } finally { Collection.prototype.insertMany = insertMany; }
    });
    assert.ok(await rows().findOne({ _id: legacy }), 'fixture: the failed re-key lost the legacy row');
    assert.ok(lines.some(l => STEP.test(l)), 'a real failure of the re-key was not said');
  });
});

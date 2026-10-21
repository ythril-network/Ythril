/**
 * A mark a restore forgets and a mark it keeps are two lists, and together they are EXACTLY the marks a network member carries.
 *
 * ## The rule (bundle-157 plan rev 2, R3.8 and R5.2)
 *
 * A restore replaces a space's records with an older snapshot. What this instance RECEIVED after that snapshot is gone, so the marks that
 * say how far it has read (`lastSeqReceived`) and the two re-read states are forgotten, and the peers send it again. What it SENT
 * (`lastSeqPushed`), what its peers were served (`lastSeqServed`) and which file deletions they took
 * (`lastFileTombstoneAckedAt`) are kept: clearing the push mark re-sends restored records whose deletions peers already pruned, so peers
 * store them again (challenge 1, probe P1).
 *
 * That decision is made ONCE, per mark, in two named lists beside `PER_SPACE_WATERMARKS`:
 *
 * - `RECEIVE_MARKS` - forgotten on a restore;
 * - `KEPT_ON_RESTORE` - kept, each with the reason it is kept.
 *
 * ## What this holds, and what it is red for today
 *
 * The two lists are disjoint and their union is exactly `PER_SPACE_WATERMARKS`, so a sixth mark added to the member type cannot be
 * forgotten by one door and kept by another: it fails here until somebody classifies it. The lists do not exist yet, so today this is red
 * because the export is missing.
 *
 * ## Which module, and which shape (the design names the lists, not their home - the coordinator ruled it)
 *
 * Both lists are read from `config/types-networks.ts`, beside `PER_SPACE_WATERMARKS`. `RECEIVE_MARKS` is an array of mark names;
 * `KEPT_ON_RESTORE` an object `{ [mark]: reason }` ("each with a reason").
 *
 * Floor: `PER_SPACE_WATERMARKS` must hold at least four marks. An empty list would pass every assertion over it.
 *
 * Run: node --test testing/standalone/receive-marks-and-kept-marks-classify-every-mark.test.js (a prior `npx tsc -p server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memberWatermarks } from '../_shared/member-watermarks.mjs';

const types = await import('../../server/dist/config/types-networks.js');

describe('every per-space mark is either forgotten on a restore or kept with a reason', () => {
  it('RECEIVE_MARKS (an array) and KEPT_ON_RESTORE (an object mark -> reason) are exported from config/types-networks', () => {
    assert.ok(Array.isArray(types.RECEIVE_MARKS), 'RECEIVE_MARKS is not exported from config/types-networks as an array of mark names');
    assert.ok(types.KEPT_ON_RESTORE && typeof types.KEPT_ON_RESTORE === 'object' && !Array.isArray(types.KEPT_ON_RESTORE),
      'KEPT_ON_RESTORE is not exported from config/types-networks as an object { [mark]: reason }');
  });

  it('they are disjoint and together exactly PER_SPACE_WATERMARKS, which is the set the member type declares', () => {
    const { PER_SPACE_WATERMARKS, RECEIVE_MARKS, KEPT_ON_RESTORE } = types;
    const declared = memberWatermarks();
    assert.ok(PER_SPACE_WATERMARKS.length >= 4, `PER_SPACE_WATERMARKS has ${PER_SPACE_WATERMARKS.length} entries: the scan reads nothing`);
    assert.deepEqual([...PER_SPACE_WATERMARKS].sort(), [...declared].sort(), 'PER_SPACE_WATERMARKS is not the set the member type declares');

    assert.ok(Array.isArray(RECEIVE_MARKS) && KEPT_ON_RESTORE && typeof KEPT_ON_RESTORE === 'object', 'the two lists are not exported (see the first row)');
    const keptNames = Object.keys(KEPT_ON_RESTORE);

    assert.deepEqual(RECEIVE_MARKS.filter(m => keptNames.includes(m)), [], 'a mark is both forgotten and kept on a restore');
    const unclassified = PER_SPACE_WATERMARKS.filter(m => !RECEIVE_MARKS.includes(m) && !keptNames.includes(m));
    assert.deepEqual(unclassified, [], 'a mark nobody decided about: add it to RECEIVE_MARKS, or to KEPT_ON_RESTORE with its reason');
    const strangers = [...RECEIVE_MARKS, ...keptNames].filter(m => !PER_SPACE_WATERMARKS.includes(m));
    assert.deepEqual(strangers, [], 'a restore list names something that is not a per-space mark');
    assert.equal(RECEIVE_MARKS.length + keptNames.length, PER_SPACE_WATERMARKS.length, 'a mark is listed twice');
  });

  it('every kept mark says why, in a sentence', () => {
    const { KEPT_ON_RESTORE } = types;
    assert.ok(KEPT_ON_RESTORE && typeof KEPT_ON_RESTORE === 'object', 'KEPT_ON_RESTORE is not exported (see the first row)');
    const entries = Object.entries(KEPT_ON_RESTORE);
    assert.ok(entries.length >= 1, 'KEPT_ON_RESTORE is empty');
    for (const [mark, reason] of entries) {
      assert.ok(typeof reason === 'string' && reason.trim().split(/\s+/).length >= 5, `'${mark}' is kept on a restore with no reason worth the name: ${JSON.stringify(reason)}`);
    }
  });

  it("the decision is the design's: what was RECEIVED is forgotten, what was SENT or ACKNOWLEDGED is kept", () => {
    // Plan rev 2: forget lastSeqReceived, tombstoneRereadAt, fileMetaRereadAt; keep lastSeqPushed, lastSeqServed,
    // lastFileTombstoneAckedAt. A forgotten push mark would re-send restored records whose deletions peers already pruned.
    const { RECEIVE_MARKS, KEPT_ON_RESTORE } = types;
    assert.ok(Array.isArray(RECEIVE_MARKS) && KEPT_ON_RESTORE && typeof KEPT_ON_RESTORE === 'object', 'the two lists are not exported (see the first row)');
    assert.deepEqual([...RECEIVE_MARKS].sort(), ['fileMetaRereadAt', 'lastSeqReceived', 'tombstoneRereadAt']);
    assert.deepEqual(Object.keys(KEPT_ON_RESTORE).sort(), ['lastFileTombstoneAckedAt', 'lastSeqPushed', 'lastSeqServed']);
  });
});

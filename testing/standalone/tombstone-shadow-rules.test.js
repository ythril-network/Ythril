/**
 * `metaDecidedByRow`: what the stored row at a path says about an arriving file's metadata when the pending delete that would
 * shadow it cannot be looked at (bundle-88, Q-411).
 *
 * ## The rule it rests on
 *
 * Every act that writes a pending tombstone removes the file's bytes first and its LIVE rows LAST (the rows are what tell a retry the
 * delete is still owed). So, for a metadata arrival the unlooked tombstone WOULD shadow (its `rowSeq` is at or above the arriving seq):
 *
 *   - no live row at the path (absent, or flagged `deletedAt`): the act got past its bytes, so the arrival is `shadowed`;
 *   - a live row at a version at or above the arrival's: the arrival cannot land whatever the act did (the writer's seq guard answers),
 *     so it is `not-shadowed` and goes to the writer;
 *   - a live row below the arrival's version: cannot occur (the tombstone's `rowSeq` was read from this row and a version only rises),
 *     so it stays `undecided`.
 *
 * ## Seen red
 *
 * On the base (1e430410c) the function does not exist; `loadDistModule`/`needModule` name the missing export.
 *
 * Run: node --test testing/standalone/tombstone-shadow-rules.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/files/tombstone-shadow.js', import.meta.url); });
const decided = () => needModule(loaded, ['metaDecidedByRow'], 'a metadata arrival at a path whose pending tombstone cannot be looked at is decided from the stored row').metaDecidedByRow;

describe('metaDecidedByRow', () => {
  it('no row at the path: the act got past its bytes, so the arrival is shadowed', () => {
    assert.equal(decided()(3, undefined), 'shadowed');
  });
  it('a row a soft delete flagged is the deletion itself: shadowed', () => {
    assert.equal(decided()(3, { seq: 9, deletedAt: '2026-01-01T00:00:00.000Z' }), 'shadowed');
  });
  it('a live row at or above the arriving version: not shadowed, the writer\'s seq guard answers', () => {
    assert.equal(decided()(5, { seq: 5 }), 'not-shadowed');
    assert.equal(decided()(3, { seq: 5 }), 'not-shadowed');
  });
  it('a live row below the arriving version cannot occur, and stays undecided', () => {
    assert.equal(decided()(6, { seq: 5 }), 'undecided');
  });
  it('a live row with no version counts as version 0', () => {
    assert.equal(decided()(1, {}), 'undecided');
  });
});

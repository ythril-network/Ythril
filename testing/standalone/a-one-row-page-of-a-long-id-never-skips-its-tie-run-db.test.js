/**
 * A page of ONE row whose id is too long for a cursor to name never skips the rest of its tie run (bundle-81 decision 68; design rev 8 section 6a).
 *
 * ## The defect
 *
 * A position cursor is the pair `(pos, id)`: after it come the rest of the run at `pos` and then everything above. The legacy band (every carried 5.6 seq, which a
 * relayed record shares with its author's) has ties by nature, so a page can end INSIDE a run. An id longer than the cursor bound (`MAX_CURSOR_ID_LENGTH`) cannot be named,
 * and the cursor then degraded to the bare position, which continues from the NEXT position and loses the rest of the run for good. Slice I2 closed the case where
 * the page holds several rows (it ends earlier, on a row whose id a cursor can name); a page whose ONLY row has such an id has no earlier row to end on, and still skipped.
 *
 * ## The rule
 *
 * Following the cursors of a pull one row at a time, from the start, delivers every row of the run, whatever the length of any id in it: a run of three at one position,
 * the FIRST of which (in `_id` order) has an id over the cursor bound, is delivered whole, in order, exactly once each. (The cursor names a long id by a digest the
 * reader resolves, and falls back to re-offering the run when the row has gone, which is at-least-once and never a skip.)
 *
 * Positive control in the same case: with every id short, the same follow-through delivers the same set, so the long id is what the case is about.
 *
 * Database `b81tI3_longid`, dropped on entry and exit. Run: node --test testing/standalone/a-one-row-page-of-a-long-id-never-skips-its-tie-run-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';
import { build, peerToken } from './_push-door.mjs';

const skip = await mongoSkipReason();
const { MAX_CURSOR_ID_LENGTH } = await import('../../server/dist/util/seq-keyset.js');
const SELF = 'b81c-longid';
const RUN_POS = 5_000;

describe('a one-row page of a long id never skips its tie run', { skip }, () => {
  let door;
  before(async () => { door = await openB81cDoor({ name: 'longid', spaces: ['long', 'short'], instanceId: SELF }); });
  after(async () => { await door?.close(); });

  const row = (space, id, seq, pos) => ({ ...build.fact(space, id, seq, { author: { instanceId: SELF, instanceLabel: 'Self' } }), pos, posAtSeq: seq, writtenHere: true });

  /** Every id a one-row-per-page follow-through of `/facts` delivers, in order, from the start. */
  async function followOneRowAtATime(space) {
    const delivered = [];
    let cursor;
    for (let guard = 0; guard < 20; guard++) {
      const r = await door.pull('/facts', { spaceId: space, ...(cursor ? { cursor } : { afterPos: '0' }), limit: '1' }, peerToken('b81-peer'));
      assert.equal(r.code, 200, JSON.stringify(r.body));
      delivered.push(...r.body.items.map(i => i._id));
      if (!r.body.nextCursor) return delivered;
      cursor = r.body.nextCursor;
    }
    assert.fail(`the follow-through did not end: ${delivered}`);
  }

  it('control: a run of three short ids is delivered whole, one row at a time', async () => {
    await door.coll('short', 'facts').insertMany(['a', 'b', 'c'].map((id, i) => row('short', id, i + 1, RUN_POS)));
    assert.deepEqual(await followOneRowAtATime('short'), ['a', 'b', 'c']);
  });

  it('a run whose first id is over the cursor bound is delivered whole, one row at a time', async () => {
    const long = 'a'.repeat(MAX_CURSOR_ID_LENGTH + 100);
    await door.coll('long', 'facts').insertMany([long, 'b', 'c'].map((id, i) => row('long', id, i + 1, RUN_POS)));
    assert.deepEqual(await followOneRowAtATime('long'), [long, 'b', 'c'],
      'the page of the one long-id row ended with a cursor that continues from the next position: the rest of its run was skipped for good');
  });

  it('a long id in the MIDDLE of the run, and a run that ends at it, are delivered whole too', async () => {
    const mid = `b${'x'.repeat(MAX_CURSOR_ID_LENGTH + 100)}`;
    await door.coll('long', 'facts').deleteMany({});
    await door.coll('long', 'facts').insertMany(['a', mid, 'c', 'd'].map((id, i) => row('long', id, i + 1, RUN_POS)));
    await door.coll('long', 'facts').insertOne(row('long', 'e', 9, RUN_POS + 1));
    assert.deepEqual(await followOneRowAtATime('long'), ['a', mid, 'c', 'd', 'e']);
  });
});

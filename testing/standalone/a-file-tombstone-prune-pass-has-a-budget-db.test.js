/**
 * A file-tombstone prune pass reads a bounded number of pages and resumes where it stopped (bundle-88, Q-412).
 *
 * ## The defect
 *
 * `pruneFileTombstonesUpTo` looped pages until the end with no cap on a pass, and its legacy removal was one unbounded `deleteMany`: a
 * space with a long backlog of acknowledged tombstones held its housekeeping slot for as long as the backlog was long.
 *
 * ## The rule this file states
 *
 * A pass removes at most `PRUNE_PAGES_PER_PASS` pages and remembers where it stopped for the space; the next pass resumes after that row
 * and clears the cursor when it reaches the end. Nothing is lost: with 25 pages acknowledged, the first pass leaves the rows past its
 * budget and the second removes them.
 *
 * ## Seen red
 *
 * On the base (1e430410c): `PRUNE_PAGES_PER_PASS` is not exported, and one pass removes all 25 pages.
 *
 * Run: node --test testing/standalone/a-file-tombstone-prune-pass-has-a-budget-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'prunebudget';

let acts, tombstones;
const count = () => acts.door.coll(S, 'file_tombstones').countDocuments({});

describe('a file tombstone prune pass has a budget', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'prunebudget', space: S });
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('25 pages of acknowledged rows: the first pass removes the budget\'s worth, the second finishes', async () => {
    const { PRUNE_PAGES_PER_PASS, FILE_TOMBSTONE_PAGE } = tombstones;
    assert.ok(Number.isInteger(PRUNE_PAGES_PER_PASS) && PRUNE_PAGES_PER_PASS >= 1, 'files/tombstones.ts exports no PRUNE_PAGES_PER_PASS');
    const pages = PRUNE_PAGES_PER_PASS + 5;
    const total = pages * FILE_TOMBSTONE_PAGE;
    const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const rows = Array.from({ length: total }, (_, i) => ({ _id: `t${String(i).padStart(6, '0')}`, spaceId: S, path: `f${i}.txt`, deletedAt: at(i), positionAt: at(i),
      origin: 'own' }));
    for (let i = 0; i < rows.length; i += 5_000) await acts.door.coll(S, 'file_tombstones').insertMany(rows.slice(i, i + 5_000));
    const acked = at(total);

    const first = await tombstones.pruneFileTombstonesUpTo(S, acked);
    assert.ok(first <= PRUNE_PAGES_PER_PASS * FILE_TOMBSTONE_PAGE, `one pass removed ${first} rows: more than ${PRUNE_PAGES_PER_PASS} pages`);
    assert.ok(first > 0 && await count() === total - first, 'the first pass removed nothing, or the count does not add up');
    assert.ok(await count() > 0, 'the first pass finished all 25 pages: it has no budget');
    const second = await tombstones.pruneFileTombstonesUpTo(S, acked);
    assert.equal(first + second, total, `two passes removed ${first + second} of ${total}`);
    assert.equal(await count(), 0, 'a row past the first pass was not removed by the second');
  });

  it('rows stored before positions existed are removed in pages out of the same budget: no single command removes the whole backlog', async () => {
    const { PRUNE_PAGES_PER_PASS, FILE_TOMBSTONE_PAGE } = tombstones;
    const total = (PRUNE_PAGES_PER_PASS + 5) * FILE_TOMBSTONE_PAGE;
    const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    // No `positionAt`: what a release before positions stored. Judged by `deletedAt`.
    const rows = Array.from({ length: total }, (_, i) => ({ _id: `l${String(i).padStart(6, '0')}`, spaceId: S, path: `g${i}.txt`, deletedAt: at(i) }));
    for (let i = 0; i < rows.length; i += 5_000) await acts.door.coll(S, 'file_tombstones').insertMany(rows.slice(i, i + 5_000));
    const acked = at(total);

    const first = await tombstones.pruneFileTombstonesUpTo(S, acked);
    assert.ok(first <= PRUNE_PAGES_PER_PASS * FILE_TOMBSTONE_PAGE, `one pass removed ${first} legacy rows: more than ${PRUNE_PAGES_PER_PASS} pages`);
    assert.ok(first > 0 && await count() === total - first, 'the first pass removed nothing, or the count does not add up');
    const second = await tombstones.pruneFileTombstonesUpTo(S, acked);
    assert.equal(first + second, total, `two passes removed ${first + second} of ${total}`);
    assert.equal(await count(), 0);
  });
});

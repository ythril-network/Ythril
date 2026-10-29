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
 * The last case (legacy rows with a marker whose move is still owed): with the marked read's resume cursor taken out of the built code, the pass
 * removes 0 of the 20 rows behind the 520 kept ones ("the pass removed 0 rows ... never read"); with the cursor, it removes the 20.
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

  it('legacy rows whose move is still owed are kept and passed: more than a page of them does not starve the rows behind them', async () => {
    const { FILE_TOMBSTONE_PAGE } = tombstones;
    const owedMoves = FILE_TOMBSTONE_PAGE + 20;   // more than the first page of marked rows the prune reads
    const strays = 20;                             // after them in id order, and no move of theirs is owed
    const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const pad = (i) => String(i).padStart(6, '0');
    const marked = [];
    for (let i = 0; i < owedMoves; i++) {
      // A move is owed while its bytes are at the destination and a record of the file is still at the source.
      await acts.files.writeFile(S, `to${pad(i)}.txt`, 'x');
      marked.push({ _id: `m${pad(i)}`, spaceId: S, path: `from${pad(i)}.txt`, deletedAt: at(i), move: { from: `from${pad(i)}.txt`, to: `to${pad(i)}.txt` } });
    }
    await acts.door.coll(S, 'files').insertMany(Array.from({ length: owedMoves }, (_, i) =>
      ({ _id: `from${pad(i)}.txt`, spaceId: S, path: `from${pad(i)}.txt`, sizeBytes: 1, tags: [], createdAt: at(0), updatedAt: at(0) })));
    for (let i = 0; i < strays; i++) {
      marked.push({ _id: `n${pad(i)}`, spaceId: S, path: `gone${pad(i)}.txt`, deletedAt: at(i), move: { from: `gone${pad(i)}.txt`, to: `nowhere${pad(i)}.txt` } });
    }
    await acts.door.coll(S, 'file_tombstones').insertMany(marked);
    const acked = at(owedMoves + strays);

    const removed = await tombstones.pruneFileTombstonesUpTo(S, acked);
    assert.equal(removed, strays, `the pass removed ${removed} rows: the ${strays} whose move is not owed were behind more than a page of kept rows, and were never read`);
    assert.equal(await count(), owedMoves, 'a row of an owed move was removed, or a stray stayed');
    // A second pass starts over and judges the same: the owed rows stay, nothing is lost, nothing is removed twice.
    assert.equal(await tombstones.pruneFileTombstonesUpTo(S, acked), 0);
    assert.equal(await count(), owedMoves);
  });
});

/**
 * Database-level test: moving a path holds and re-keys the queued jobs of everything it owns — its sidecars included.
 *
 * ## What was broken
 *
 * The delete asks which job ids a path owns through `sidecarsOf`, so a peer's converted Markdown (`_converted/<f>.md`,
 * an ordinary file with a text job of its own there) is cancelled with its file. The move asked the same question through a
 * second spelling (two RegExps: the path and its subtree, and the extracted tree) which could not name that job. A move of
 * `f` neither held it nor re-keyed it, so it ran during the move at the old path, and was left at the old path after.
 *
 * One rule answers it for both: the path's own job (a file's id, a directory's subtree) and every sidecar `sidecarsOf` names
 * for its KIND — a sidecar FILE by its id, a sidecar TREE by its prefix with the slash, so `f` never takes `f2`.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-moved-paths-jobs-follow-the-move-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const AT = '2026-10-08T10:00:00.000Z';

let mongo, jobs, holdJobsForMove, releaseMoveHold, rekeyJobsForMove;

async function seed(ids) {
  await jobs.insertMany(ids.map(id => ({
    _id: id, spaceId: SPACE, filePath: id, mimeType: 'text/markdown', mediaType: 'text',
    status: 'pending', attempts: 0, maxAttempts: 3, lastError: null, claimedAt: null, claimableAfter: null,
    createdAt: AT, updatedAt: AT,
  })));
}

const ids = async (filter = {}) => (await jobs.find(filter, { projection: { _id: 1 } }).toArray()).map(j => j._id).sort();

/** Hold, then re-key, as the move cascade does around the bytes; returns what was held. */
async function move(src, dst, kind) {
  const held = await holdJobsForMove(SPACE, src, kind);
  await rekeyJobsForMove(SPACE, src, dst, held, kind);
  return held.sort();
}

describe('a moved path takes the queued jobs of everything it owns — against a real MongoDB', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('jobsmoved');
    ({ holdJobsForMove, releaseMoveHold, rekeyJobsForMove } = await import('../../server/dist/files/media/job-queue.js'));
    jobs = mongo.col(`${SPACE}_media_jobs`);
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { await jobs.deleteMany({}); });

  it('a FILE: its own job, its converted sidecar\'s and its extracted images\' are held and re-keyed; a neighbour\'s stay', async () => {
    await seed([
      'docs/f.html', '_converted/docs/f.html.md', '_extracted/docs/f.html/img-1.png',
      'docs/f.html2', '_converted/docs/f.html2.md', '_converted/docs/f.html.md2', '_extracted/docs/f.html2/img-1.png',
    ]);
    const held = await move('docs/f.html', 'docs/g.html', 'file');
    assert.deepEqual(held, ['_converted/docs/f.html.md', '_extracted/docs/f.html/img-1.png', 'docs/f.html'],
      'the converted sidecar\'s job has to be held: left claimable, it runs at the old path while the bytes move');
    assert.deepEqual(await ids(), [
      '_converted/docs/f.html.md2', '_converted/docs/f.html2.md', '_converted/docs/g.html.md',
      '_extracted/docs/f.html2/img-1.png', '_extracted/docs/g.html/img-1.png', 'docs/f.html2', 'docs/g.html',
    ], 'every job of the file follows it; no neighbour is taken');
    assert.deepEqual(await ids({ claimableAfter: { $ne: null } }), [], 'the re-keyed jobs are released to run where the file now is');
  });

  it('a neighbour\'s jobs are not held: `f2` and `f.md2` are not `f`\'s', async () => {
    await seed(['docs/f.html', 'docs/f.html2', '_converted/docs/f.html2.md', '_converted/docs/f.html.md2']);
    const held = await holdJobsForMove(SPACE, 'docs/f.html', 'file');
    assert.deepEqual(held.sort(), ['docs/f.html']);
    assert.deepEqual(await ids({ claimableAfter: { $ne: null } }), ['docs/f.html']);
  });

  it('a DIRECTORY: every job under it and under its two sidecar trees is held and re-keyed; a sibling directory\'s stay', async () => {
    await seed([
      'd/a.html', 'd/sub/b.pdf', '_converted/d/a.html.md', '_converted/d/sub/b.pdf.md', '_extracted/d/sub/b.pdf/img-1.png',
      'd2/c.html', '_converted/d2/c.html.md', '_extracted/d2/c.html/img-1.png',
    ]);
    const held = await move('d', 'e', 'directory');
    assert.deepEqual(held, [
      '_converted/d/a.html.md', '_converted/d/sub/b.pdf.md', '_extracted/d/sub/b.pdf/img-1.png', 'd/a.html', 'd/sub/b.pdf',
    ]);
    assert.deepEqual(await ids(), [
      '_converted/d2/c.html.md', '_converted/e/a.html.md', '_converted/e/sub/b.pdf.md',
      '_extracted/d2/c.html/img-1.png', '_extracted/e/sub/b.pdf/img-1.png', 'd2/c.html', 'e/a.html', 'e/sub/b.pdf',
    ]);
    assert.deepEqual(await ids({ claimableAfter: { $ne: null } }), []);
  });

  it('a FILE named like a directory\'s converted tree is not taken by the directory\'s kind, and the reverse', async () => {
    // `g.md/` (a directory) and `g` (a file) both put things under `_converted/g.md`: the file's converted Markdown is that
    // id, the directory's converted tree is that prefix. The kind says which one a move of `g` means.
    await seed(['g', '_converted/g.md', '_converted/g.md/x.md', 'g.md/x']);
    assert.deepEqual((await holdJobsForMove(SPACE, 'g', 'file')).sort(), ['_converted/g.md', 'g']);
    await jobs.updateMany({}, { $set: { claimableAfter: null } });
    assert.deepEqual((await holdJobsForMove(SPACE, 'g.md', 'directory')).sort(), ['_converted/g.md/x.md', 'g.md/x']);
  });

  it('a hold that is released leaves the jobs where they were', async () => {
    await seed(['f.html', '_converted/f.html.md']);
    const held = await holdJobsForMove(SPACE, 'f.html', 'file');
    assert.equal(held.length, 2);
    await releaseMoveHold(SPACE, held);
    assert.deepEqual(await ids({ claimableAfter: { $ne: null } }), []);
    assert.deepEqual(await ids(), ['_converted/f.html.md', 'f.html']);
  });

  it('an empty path owns nothing', async () => {
    await seed(['a.html', '_converted/a.html.md']);
    assert.deepEqual(await holdJobsForMove(SPACE, '', 'file'), []);
    assert.deepEqual(await holdJobsForMove(SPACE, '/', 'directory'), []);
    assert.deepEqual(await ids({ claimableAfter: { $ne: null } }), []);
  });
});

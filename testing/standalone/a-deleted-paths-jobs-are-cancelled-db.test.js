/**
 * Database-level test: deleting a path cancels every queued job of what that path owns — its sidecars included.
 *
 * ## What was broken
 *
 * A file's delete cancelled its own job and the jobs under its extraction tree (`_extracted/<f>/…`), and nothing else. A
 * peer that never converts holds the converted Markdown (`_converted/<f>.md`) as an ordinary file with a text job of its
 * own, and that job's id is neither the file's nor under a tree. So a delete that landed while the job ran left the job
 * running: it wrote a chunk row of the deleted file's converted text after the cascade had removed every row, and the
 * chunk stayed, searchable, belonging to nothing (found by the bundle-71 verify drive, 1 of 4 immediate deletes).
 *
 * The question is which job ids a path owns, and it has one answer: the path's own job, and the jobs of every sidecar
 * `sidecarsOf` names for it — a sidecar FILE by its id, a sidecar TREE by its prefix. A directory owns its whole subtree.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-deleted-paths-jobs-are-cancelled-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const AT = '2026-10-08T10:00:00.000Z';

let mongo, jobs, cancelJobsOwnedBy;

async function seed(ids) {
  await jobs.insertMany(ids.map(id => ({
    _id: id, spaceId: SPACE, filePath: id, mimeType: 'text/markdown', mediaType: 'text',
    status: 'pending', attempts: 0, maxAttempts: 3, lastError: null, claimedAt: null, createdAt: AT, updatedAt: AT,
  })));
}

const left = async () => (await jobs.find({}, { projection: { _id: 1 } }).toArray()).map(j => j._id).sort();

describe('a deleted path takes the queued jobs of everything it owns — against a real MongoDB', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('jobsowned');
    ({ cancelJobsOwnedBy } = await import('../../server/dist/files/media/job-queue.js'));
    jobs = mongo.col(`${SPACE}_media_jobs`);
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => { await jobs.deleteMany({}); });

  it('a FILE: its converted sidecar\'s job and its extracted images\' jobs go; its own job and a neighbour\'s stay', async () => {
    await seed([
      'docs/f.html', '_converted/docs/f.html.md', '_extracted/docs/f.html/img-1.png',
      'docs/f.html2', '_converted/docs/f.html2.md', '_converted/docs/f.html.md2', 'docs/g.html',
    ]);
    await cancelJobsOwnedBy(SPACE, 'docs/f.html', 'file');
    // The file's own job stays: its text job clears the file's sidecars from inside itself, and must not cancel its own lease
    // (the delete takes it by `cancelMediaJob`).
    assert.deepEqual(await left(), ['_converted/docs/f.html.md2', '_converted/docs/f.html2.md', 'docs/f.html', 'docs/f.html2', 'docs/g.html'],
      'a peer\'s converted sidecar has a job of its own; left queued, it writes a chunk of the deleted file after the cascade');
  });

  it('a DIRECTORY: every job under it and under its sidecar trees goes; a sibling directory\'s stay', async () => {
    await seed([
      'd/a.html', 'd/sub/b.pdf', '_converted/d/a.html.md', '_extracted/d/sub/b.pdf/img-1.png',
      'd2/c.html', '_converted/d2/c.html.md', 'd',
    ]);
    await cancelJobsOwnedBy(SPACE, 'd', 'directory');
    assert.deepEqual(await left(), ['_converted/d2/c.html.md', 'd', 'd2/c.html']);
  });

  it('an empty path owns nothing', async () => {
    await seed(['a.html', '_converted/a.html.md']);
    await cancelJobsOwnedBy(SPACE, '', 'file');
    await cancelJobsOwnedBy(SPACE, '/', 'directory');
    assert.deepEqual(await left(), ['_converted/a.html.md', 'a.html']);
  });
});

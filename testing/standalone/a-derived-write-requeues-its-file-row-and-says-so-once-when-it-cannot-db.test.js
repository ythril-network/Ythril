/**
 * The derived writers' re-queue of their file row, on the paths no other test reaches (Q-428, bundle-41, round-1 finding F9).
 *
 * ## What it holds (real MongoDB, a media claim as a worker holds one)
 *
 * (a) **A re-queue that fails leaves the write landed and says so once.** The write of a derived description lands (`true`, the description is
 *     stored) while the jobs collection refuses every write; the failure is ONE warn line, naming the repair route, and not two: the queue's own
 *     (`enqueueWriteEmbedJobs` warns when its batch fails) and a second one from the changed-row function for the same failure. A second
 *     failed re-queue is one more line, so the lines follow the failures one for one.
 * (b) **The excerpt's write re-queues as the description's does.** A derived excerpt that lands leaves a PENDING `file` job at the row's job id,
 *     on the write lane; one that declines (the file is gone) queues nothing.
 *
 * What it cannot reach: the changed-row function's own `catch`, which says a failure that is not the queue's (the write bound refusing the
 * call). The queue catches its own failures, so nothing the database does reaches it; it stays as the guard that a throw never enters a landed write.
 *
 * Seen red on f3cd49548: (a) two lines for one failed re-queue; (b) green, held by mutation: the excerpt's `requeueEmbedWorkOfChangedRow` call
 * removed leaves no job after the landed write.
 *
 * Run: node --test testing/standalone/a-derived-write-requeues-its-file-row-and-says-so-once-when-it-cannot-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { seedClaim } from './_media-claim.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const FILE = 'photos/harbour.jpg';
const OTHER = 'photos/market.jpg';
const REPAIR = 'POST /api/spaces/:id/reembed';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q428-requeue-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

let mongo, meta, derived, queue, log;

const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

/** A file row with no description and no excerpt whose embed job has finished: the state a media job's derived text arrives on. */
async function embeddedRowWithNoText(file) {
  await meta.upsertFileMeta(SPACE, file, 64, { tags: ['photo'] });
  const row = await files().findOne({ _id: file });
  assert.ok(row && !row.description && !row.excerpt, `fixture: ${file} is not a row with no text`);
  await jobs().deleteMany({});
}

/** Every warn and error line the server logs while `fn` runs, and its result. */
async function logsDuring(fn) {
  const lines = [];
  const orig = { warn: log.warn, error: log.error };
  log.warn = (...a) => { lines.push(a.join(' ')); };
  log.error = (...a) => { lines.push(a.join(' ')); };
  try { return { result: await fn(), lines }; } finally { Object.assign(log, orig); }
}

/** `fn` with every bulk write to the jobs collection refused, as a store that stopped taking them does. */
async function withJobWritesRefused(fn) {
  const proto = Object.getPrototypeOf(mongo.col('probe'));
  const inner = proto.bulkWrite;
  proto.bulkWrite = function refused(...args) {
    if (String(this.collectionName).endsWith('_embed_jobs')) return Promise.reject(new Error('jobs collection refused the write'));
    return inner.apply(this, args);
  };
  try { return await fn(); } finally { proto.bulkWrite = inner; }
}

describe('the derived writers re-queue their file row (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('q428derivedrequeue');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
    derived = await import('../../server/dist/files/derived-fields.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
    ({ log } = await import('../../server/dist/util/log.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => { await files().deleteMany({}); await jobs().deleteMany({}); });

  it('(a) a re-queue the store refuses leaves the description landed and is said in ONE line naming the repair route, per failure', async () => {
    await embeddedRowWithNoText(FILE);
    await embeddedRowWithNoText(OTHER);
    const first = await withJobWritesRefused(() => logsDuring(async () =>
      derived.setDerivedDescriptionIfUnset(SPACE, await seedClaim(SPACE, FILE), FILE, 'A harbour at dusk', 'generated')));
    assert.equal(first.result, true, 'the write landed, so it answers landed, whatever the queue did');
    assert.equal((await files().findOne({ _id: FILE })).description, 'A harbour at dusk');
    assert.equal(await jobs().countDocuments({}), 0, 'fixture: the refused write queued a job');
    assert.equal(first.lines.length, 1, `one failed re-queue was said ${first.lines.length} times:\n  ${first.lines.join('\n  ')}`);
    assert.ok(first.lines[0].includes(REPAIR), `the line does not name the repair route: ${first.lines[0]}`);

    const second = await withJobWritesRefused(() => logsDuring(async () =>
      derived.setDerivedDescriptionIfUnset(SPACE, await seedClaim(SPACE, OTHER), OTHER, 'A market at noon', 'generated')));
    assert.equal(second.result, true);
    assert.equal(second.lines.length, 1, `a second failed re-queue was said ${second.lines.length} times:\n  ${second.lines.join('\n  ')}`);
  });

  it('(b) a derived excerpt that lands leaves a pending file job on the write lane; one that declines (the file is gone) queues nothing', async () => {
    await embeddedRowWithNoText(FILE);
    const landed = await derived.setDerivedExcerpt(SPACE, await seedClaim(SPACE, FILE), FILE, 'The harbour opens at dawn.');
    assert.equal(landed, 'written', 'fixture: the excerpt did not land');
    assert.equal((await files().findOne({ _id: FILE })).excerpt, 'The harbour opens at dawn.');
    const job = await jobs().findOne({ _id: queue.embedJobId('file', FILE) });
    assert.ok(job, 'the excerpt landed and no embed job was queued for the row: the excerpt never reaches the vector');
    assert.equal(job.status, 'pending');
    assert.equal(job.recordType, 'file');
    assert.equal(job.priority, queue.EMBED_PRIORITY.write);

    await jobs().deleteMany({});
    await files().deleteMany({});
    const declined = await derived.setDerivedExcerpt(SPACE, await seedClaim(SPACE, OTHER), OTHER, 'Nothing to land on');
    assert.notEqual(declined, 'written', 'fixture: an excerpt landed on a row that does not exist');
    assert.equal(await jobs().countDocuments({ recordType: 'file' }), 0, 'a write that landed nothing queued an embed job');
  });
});

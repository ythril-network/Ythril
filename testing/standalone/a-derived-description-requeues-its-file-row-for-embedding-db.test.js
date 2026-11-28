/**
 * A description a media job derives for a file is part of the file's embed text, so the write that lands it re-queues the file row's embed
 * job, as the excerpt's write does (Q-428, bundle-41).
 *
 * ## The defect
 *
 * `fileEmbedText` builds a file row's text from its path, its description and its excerpt. `setDerivedExcerpt` re-queues the row when its
 * write lands; `setDerivedDescriptionIfUnset` did not. An image's caption, written as the description of a file that had none, never reached
 * the row's vector: the file was not findable by what its caption says until somebody reindexed the space.
 *
 * ## What it holds
 *
 * A file row with no description and no excerpt, its embed job finished (the job document is deleted, as `completeEmbedJob` leaves it), then a
 * derived description written under a media claim: the write reports `true`, and a PENDING `file` job stands at the row's job id, on the
 * write lane. The control: a derived write that DECLINES (a person's description is there) queues nothing.
 *
 * Seen red on 890cf234b: no job after the landed write.
 *
 * Run: node --test testing/standalone/a-derived-description-requeues-its-file-row-for-embedding-db.test.js
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-q428-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo, meta, derived, queue;

const files = () => mongo.col(`${SPACE}_files`);
const jobs = () => mongo.col(`${SPACE}_embed_jobs`);

/** A file row with no description and no excerpt whose embed job has finished: the state a media job's caption arrives on. */
async function embeddedRowWithNoText() {
  await meta.upsertFileMeta(SPACE, FILE, 64, { tags: ['photo'] });
  const row = await files().findOne({ _id: FILE });
  assert.ok(row, 'fixture: the file row was not written');
  assert.ok(!row.description && !row.excerpt, `fixture: the row already carries text (${JSON.stringify({ d: row.description, e: row.excerpt })})`);
  await jobs().deleteMany({});
}

describe('a derived description re-queues its file row for embedding (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('q428descrequeue');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    meta = await import('../../server/dist/files/file-meta.js');
    derived = await import('../../server/dist/files/derived-fields.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await files().deleteMany({});
    await jobs().deleteMany({});
  });

  it('a derived description that lands leaves a pending file job for the row, on the write lane', async () => {
    await embeddedRowWithNoText();
    const landed = await derived.setDerivedDescriptionIfUnset(SPACE, await seedClaim(SPACE, FILE), FILE, 'A harbour at dusk with fishing boats', 'generated');
    assert.equal(landed, true, 'fixture: the derived description did not land');
    assert.equal((await files().findOne({ _id: FILE })).description, 'A harbour at dusk with fishing boats');

    const job = await jobs().findOne({ _id: queue.embedJobId('file', FILE) });
    assert.ok(job, 'the description landed and no embed job was queued for the row: its caption never reaches the vector');
    assert.equal(job.status, 'pending');
    assert.equal(job.recordType, 'file');
    assert.equal(job.recordId, FILE);
    assert.equal(job.priority, queue.EMBED_PRIORITY.write, 'a changed row is re-queued on the write lane, as the excerpt is');
  });

  it('control: a derived description that declines (a person wrote one) queues nothing', async () => {
    await meta.upsertFileMeta(SPACE, FILE, 64, { description: 'written by a person' });
    await jobs().deleteMany({});
    const landed = await derived.setDerivedDescriptionIfUnset(SPACE, await seedClaim(SPACE, FILE), FILE, 'derived', 'generated');
    assert.equal(landed, false, 'fixture: the derived write landed over a person\'s description');
    assert.equal(await jobs().countDocuments({ recordType: 'file' }), 0, 'a write that landed nothing queued an embed job');
  });
});

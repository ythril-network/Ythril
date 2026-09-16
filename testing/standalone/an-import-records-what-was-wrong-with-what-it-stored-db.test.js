/**
 * The admin import stores what it is given, says what was wrong with it, and queues it for embedding.
 *
 * ## What it did before
 *
 * `POST /api/admin/spaces/:spaceId/import` did `replaceOne(…, { upsert: true })` on arbitrary documents. Zero
 * validation, zero schema references — and no embed job either, so every imported record was stored and
 * **invisible to meaning-ranked search** until somebody thought to run a reindex.
 *
 * ## It read as a decision, and sync had already answered it
 *
 * The tension is real: an import is how you restore a backup, and a backup taken before a schema change would
 * be refused by its own instance — so refusing the import makes backups unrestorable. That was filed as a
 * question for the owner (P-21) and never put to them.
 *
 * It should not have been. `api/sync/_shared.ts` meets the identical problem on the identical kind of payload
 * and resolves it by RECORDING rather than refusing: the document is stored and the violations are reported
 * back. Import is the other bulk ingest path into the same collections, and one rule with two answers is the
 * defect this codebase produces most. So P-21 is withdrawn rather than answered.
 *
 * ## The embed queue is the half nobody filed
 *
 * `ingestBrainDoc` exists so that a new ingest site cannot be written without the queue — it is the only thing
 * in the sync router permitted to write a brain document, and it writes AND enqueues in one call. Import grew
 * its own `replaceOne` beside it and inherited none of that. A restored backup that never becomes searchable
 * is the same class of silence as a create that dropped `suppressEmbeddings`: a 200, a record, and a
 * capability quietly missing.
 *
 * ## What is deliberately NOT changed, and why
 *
 * **No `seq` allocation.** An exported document carries the seq it had, and a restore that renumbered them
 * would make the restored instance disagree with every peer about what is newer. Sync preserves the incoming
 * seq for the same reason.
 *
 * **No tombstone check.** Sync refuses a document whose id has been tombstoned, so a deleted record cannot be
 * resurrected by a peer that has not caught up. A RESTORE is the case where resurrection is the point — but it
 * means a record deleted after the backup comes back, and the tombstone will remove it again on the next sync.
 * That is worth knowing rather than discovering, so the route says it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/an-import-records-what-was-wrong-with-what-it-stored-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-import-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';

let mongo, importMod, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const jobsFor = (id) => coll('embed_jobs').countDocuments({ recordId: id });

/** A space that requires `owner` on a `service` entity, so a violating document is easy to build. */
function withSchema() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'import-test', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{
      id: SPACE, label: 'General', builtIn: true, folders: [],
      meta: {
        validationMode: 'strict',
        typeSchemas: { entity: { service: { propertySchemas: { owner: { type: 'string', required: true } } } } },
      },
    }],
  }, null, 2), { mode: 0o600 });
  loader.loadConfig();
}

describe('the admin import records rather than refuses', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('adminimport');
    loader = await import('../../server/dist/config/loader.js');
    withSchema();
    importMod = await import('../../server/dist/api/admin-import.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'facts', 'edges', 'chrono', 'files', 'embed_jobs', 'tombstones']) {
      await coll(c).deleteMany({});
    }
  });

  it('the importer is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof importMod.importDocuments, 'function');
  });

  it('a document that breaks the schema is STORED, and the violation is reported', async () => {
    /*
     * The whole point. Refusing it would make a backup taken before a schema change unrestorable — and the
     * schema is the instance's own, so the refusal would be about a rule that did not exist when the data did.
     */
    const out = await importMod.importDocuments(SPACE, {
      entities: [{ _id: 'e-bad', name: 'API', type: 'service', tags: [], seq: 7 }],
    });

    assert.equal(out.results.entities.inserted, 1, 'a violating document was refused rather than stored');
    assert.equal(await coll('entities').countDocuments({ _id: 'e-bad' }), 1);

    const reported = out.results.entities.schemaViolations ?? [];
    assert.equal(reported.length, 1, `expected one reported document, got ${JSON.stringify(reported)}`);
    assert.equal(reported[0]._id, 'e-bad', 'the report must name the record, or an operator cannot find it');
    assert.match(JSON.stringify(reported[0].violations), /owner/, 'and say what was wrong with it');
  });

  it('and a conformant document is reported with nothing', async () => {
    // The control: a report that fires on everything is a report nobody reads.
    const out = await importMod.importDocuments(SPACE, {
      entities: [{ _id: 'e-ok', name: 'API', type: 'service', properties: { owner: 'platform' }, tags: [], seq: 7 }],
    });
    assert.equal(out.results.entities.inserted, 1);
    assert.deepEqual(out.results.entities.schemaViolations ?? [], []);
  });

  it('an imported record is QUEUED for embedding', async () => {
    /*
     * The half nobody filed. A restored backup that never becomes searchable is the same silence as a create
     * that dropped a flag: a success, a record, and a capability quietly missing until somebody runs a reindex
     * they were never told they needed.
     */
    await importMod.importDocuments(SPACE, {
      entities: [{ _id: 'e-1', name: 'API', type: 'service', properties: { owner: 'x' }, tags: [], seq: 1 }],
      facts: [{ _id: 'm-1', fact: 'a fact', tags: [], seq: 1 }],
    });
    assert.equal(await jobsFor('e-1'), 1, 'the imported entity will never be searchable');
    assert.equal(await jobsFor('m-1'), 1, 'the imported memory will never be searchable');
  });

  it('the exported seq is preserved, not reallocated', async () => {
    // A restore that renumbered would make this instance disagree with every peer about what is newer.
    await importMod.importDocuments(SPACE, {
      entities: [{ _id: 'e-seq', name: 'API', type: 'service', properties: { owner: 'x' }, tags: [], seq: 4242 }],
    });
    const stored = await coll('entities').findOne({ _id: 'e-seq' });
    assert.equal(stored.seq, 4242);
  });

  it('the document is re-tagged to the TARGET space', async () => {
    // Pre-existing behaviour, asserted because this change rewrites the write: importing space A's export into
    // space B while keeping `spaceId: "A"` stores records that every list filters out — counted, and invisible.
    await importMod.importDocuments(SPACE, {
      entities: [{ _id: 'e-tag', spaceId: 'somewhere-else', name: 'API', type: 'service', properties: { owner: 'x' }, tags: [], seq: 1 }],
    });
    const stored = await coll('entities').findOne({ _id: 'e-tag' });
    assert.equal(stored.spaceId, SPACE);
  });

  it('a document with no usable id is an error, not a crash', async () => {
    const out = await importMod.importDocuments(SPACE, { entities: [{ name: 'no id' }, null, 'a string'] });
    assert.equal(out.results.entities.errors, 3);
    assert.equal(out.results.entities.inserted, 0);
  });

  it('files are stored without schema validation, and that is not an omission', async () => {
    // A file has no `type` and therefore no type schema — the same asymmetry `TtlBucket` and
    // `embeddingSuppressedFor` both encode. Validating one would mean inventing a rule for it to break.
    const out = await importMod.importDocuments(SPACE, { files: [{ _id: 'notes/a.md', path: 'notes/a.md', seq: 1 }] });
    assert.equal(out.results.files.inserted, 1);
    assert.deepEqual(out.results.files.schemaViolations ?? [], []);
  });
});

describe('the import writes through the one ingest function', () => {
  it('and does not carry its own replaceOne', () => {
    /*
     * `ingestBrainDoc` writes AND enqueues in one call, which is why the sync router permits nothing else to
     * write a brain document: a new ingest site cannot then be written without the queue. Import grew its own
     * `replaceOne` beside it and inherited none of that.
     */
    const src = stripComments(readFileSync('server/src/api/admin-import.js'.replace('.js', '.ts'), 'utf8'));
    assert.match(src, /ingestBrainDoc\(/, 'the import writes its own way into a brain collection again');
    assert.doesNotMatch(src, /\.replaceOne\(/,
      'a second write path into the same collections is how the embed queue got skipped the first time');
  });
});

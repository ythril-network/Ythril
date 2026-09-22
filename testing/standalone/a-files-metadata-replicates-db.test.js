/**
 * A file's METADATA replicates — its authored half only, merged over what the receiver derived itself.
 *
 * ## The disagreement this closes
 *
 * A file's bytes replicated and its metadata record did not. That was consistent while a link was only an
 * array field: nothing about a file crossed the wire except the blob, and `merkle.ts` hashed the manifest
 * rather than the document, in as many words.
 *
 * `M-2` made link records a replicated collection. So a file linked to an entity on one instance sent the
 * LINK and not the array it came from — the graph on a peer showed the connection and the peer's own Files
 * tab showed none. Two answers to one question, differing by which collection you asked.
 *
 * Owner's ruling on `P-32`, 2026-09-04: option A, replicate the metadata like every other record.
 *
 * ## Three halves, and the middle one is why this cannot be a `replaceOne`
 *
 * Every other collection ingests by whole-document replace. A file's meta record cannot, because it holds
 * three different kinds of field:
 *
 *   - **AUTHORED** — `description`, `tags`, the three link arrays, `properties`, `descriptionSource`. Somebody
 *     decided these. They replicate.
 *   - **DERIVED FROM THE LOCAL BLOB** — `sizeBytes`, `sha256`, `excerpt`, `embedding`, `chunkCount`,
 *     `embeddingStatus`, `conversionError`. The receiver computed these from bytes it already has, and a
 *     replace would wipe them: the file would report the sender's size, the sender's hash and no vector,
 *     and stop being findable by its own text until something re-embedded it.
 *   - **CHUNK-ONLY** — `parentFileId`, `content`, `chunkIndex`, `faceEntityId`. These are on records that must
 *     not travel at all: a chunk is derived from the blob, and the receiver makes its own.
 *
 * So the ingest is a `$set` of the authored keys, and the route pages parents only.
 *
 * ## And the hash has to move with it
 *
 * `merkle.ts` excluded `files` deliberately while nothing about the document replicated. Leaving it excluded
 * now would make two instances holding DIFFERENT descriptions compute the same root and report themselves
 * identical — which that module's own comment calls worse than not replicating at all, because a permanent
 * false negative is silent for ever.
 *
 * It must hash the AUTHORED set and nothing else, or the opposite failure arrives: two instances that agree
 * about everything anybody wrote diverge for ever on a size in bytes.
 *
 * Run: node --test testing/standalone/a-files-metadata-replicates-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-filemeta-sync-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const FILE = 'notes/spec.md';
const CHUNK = 'notes/spec.md#0';
const ENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEM = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTHOR = { instanceId: 'peer', instanceLabel: 'Peer' };

let mongo, shared, merkleMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const meta = () => coll('files').findOne({ _id: FILE });

/** What a peer sends: the authored half, and nothing it could not know. */
const arriving = (over = {}) => ({
  _id: FILE, spaceId: SPACE, path: FILE,
  description: 'the spec, as the peer describes it',
  descriptionSource: 'extracted',
  tags: ['spec', 'from-peer'],
  properties: { version: '2' },
  author: AUTHOR,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  seq: 99,
  ...over,
});

/** What the receiver worked out for itself, from bytes it already holds. */
const LOCAL_DERIVED = {
  sizeBytes: 4242,
  sha256: 'f'.repeat(64),
  excerpt: 'the opening prose, extracted here',
  embedding: [0.1, 0.2, 0.3],
  embeddingModel: 'local-model-v1',
  chunkCount: 7,
  embeddingStatus: 'complete',
};

describe("a file's metadata replicates", { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('filemetasync');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'receiver', instanceLabel: 'Receiver', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], completeLinkage: true }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    shared = await import('../../server/dist/api/sync/_shared.js');
    merkleMod = await import('../../server/dist/brain/merkle.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'facts', 'chrono', 'files', 'links', 'tombstones', 'embed_jobs']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertOne({ _id: ENT, spaceId: SPACE, name: 'One', type: 'thing', tags: [], seq: 1 });
    await coll('facts').insertOne({ _id: MEM, spaceId: SPACE, fact: 'a fact', tags: [], seq: 2 });
    // The receiver's own record: a file it already has, with everything it derived from the bytes.
    await coll('files').insertOne({
      _id: FILE, spaceId: SPACE, path: FILE,
      description: 'my own description', tags: ['mine'],
      author: { instanceId: 'receiver', instanceLabel: 'Receiver' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', seq: 5,
      ...LOCAL_DERIVED,
    });
  });

  it('the ingest schema and the door exist', () => {
    assert.ok(shared.IncomingFileMetaDoc, 'IncomingFileMetaDoc');
    assert.equal(typeof shared.ingestFileMeta, 'function',
      'ingestFileMeta — a $set of the authored keys, because a replace would wipe what the receiver derived');
  });

  it('the AUTHORED half lands', async () => {
    await shared.ingestFileMeta(SPACE, shared.IncomingFileMetaDoc.parse(arriving()));
    const m = await meta();
    assert.equal(m.description, 'the spec, as the peer describes it');
    assert.equal(m.descriptionSource, 'extracted');
    assert.deepEqual(m.tags, ['spec', 'from-peer']);
    assert.deepEqual(m.properties, { version: '2' });
    assert.equal(m.seq, 99);
  });

  it('and every LOCALLY DERIVED field survives it', async () => {
    /*
     * The reason this is a `$set` and not a `replaceOne`. A replace makes the file report the sender's size
     * and hash, lose its vector, and stop being findable by its own text — with nothing failing, until
     * somebody notices a document that used to answer a search and no longer does.
     */
    await shared.ingestFileMeta(SPACE, shared.IncomingFileMetaDoc.parse(arriving()));
    const m = await meta();
    for (const [k, v] of Object.entries(LOCAL_DERIVED)) {
      assert.deepEqual(m[k], v, `${k} was overwritten by the peer's copy — the receiver derived it from bytes`);
    }
  });

  it('a field the receiver has and the peer omits is NOT cleared', async () => {
    // `$set` of what arrived, never `$unset` of what did not. A peer on an older build sends fewer keys, and
    // reading absence as deletion would let it erase a description it has never heard of.
    await shared.ingestFileMeta(SPACE, shared.IncomingFileMetaDoc.parse(arriving({ description: undefined })));
    const m = await meta();
    assert.equal(m.description, 'my own description', 'an omitted field must be left alone, not cleared');
  });

  it('a file arriving for the FIRST time is created, not skipped', async () => {
    await coll('files').deleteMany({});
    await shared.ingestFileMeta(SPACE, shared.IncomingFileMetaDoc.parse(arriving()));
    const m = await meta();
    assert.ok(m, 'a file whose bytes have not arrived yet still gets its metadata');
    assert.equal(m.description, 'the spec, as the peer describes it');
    assert.equal(m.sizeBytes, undefined, 'and no size, because this instance has not seen the bytes');
  });

  it('a LINK FIELD on an arriving file is refused, and its links travel as their own records', async () => {
    /*
     * The 5.0 shape, and the refusal is the point. `IncomingFileMetaDoc` is `.strict()`, so a peer still
     * sending the 4.x arrays is a 400 rather than a document quietly stripped of them — and this schema is
     * the one collection where that choice was already made, because a stripped `parentFileId` turns a
     * chunk into a top-level file.
     *
     * A file's connections replicate as `LinkDoc` records on the same channel, so the ingest derives
     * nothing: deriving links from an arriving record was how a sender's idea of a file's links could
     * overwrite a receiver's, and there is no second representation left to disagree.
     */
    for (const field of ['entityIds', 'memoryIds', 'chronoIds', 'linkEntities']) {
      assert.throws(() => shared.IncomingFileMetaDoc.parse(arriving({ [field]: [ENT] })),
        `${field} was accepted on an arriving file — a link is a record of its own now`);
    }
    await shared.ingestFileMeta(SPACE, shared.IncomingFileMetaDoc.parse(arriving()));
    assert.deepEqual(await coll('links').find({}).toArray(), [],
      'the ingest invented link records from a document that carries none');
  });

  it('a CHUNK is refused by the schema, not silently stored', async () => {
    /*
     * A chunk is derived from the blob and the receiver makes its own. Arriving, it would carry passage text
     * and a vector from another instance's model — which is the one thing the 2026-09-01 embedding ruling is
     * about: ranking one model's vectors against another's returns plausible results in the wrong order.
     */
    const asChunk = arriving({ _id: CHUNK, path: CHUNK, parentFileId: FILE, chunkIndex: 0, content: 'passage' });
    assert.throws(() => shared.IncomingFileMetaDoc.parse(asChunk),
      'a chunk parsed as a file metadata document — it must be refused, not stored');
  });

  it('MERKLE hashes the authored half and not the derived half', async () => {
    /*
     * Both directions matter and each fails silently in its own way.
     *
     * Not hashed at all: two instances holding different descriptions compute the same root and report
     * themselves identical — a permanent false NEGATIVE on the one signal that says data really is missing.
     *
     * Hashed too widely: two instances that agree about everything anybody WROTE diverge for ever over a
     * size in bytes, and an operator learns to ignore the warning.
     */
    const before = (await merkleMod.computeMerkleRoot(SPACE)).root;

    // A derived field changes — the same file, differently sized here. The root must not move.
    await coll('files').updateOne({ _id: FILE }, { $set: { sizeBytes: 999_999, sha256: 'a'.repeat(64) } });
    assert.equal((await merkleMod.computeMerkleRoot(SPACE)).root, before,
      'the root moved on a locally-derived field, so two instances that agree on every authored value will '
      + 'report themselves divergent for ever');

    // An authored field changes. The root MUST move.
    await coll('files').updateOne({ _id: FILE }, { $set: { description: 'somebody edited this' } });
    assert.notEqual((await merkleMod.computeMerkleRoot(SPACE)).root, before,
      'the root did not move on an authored field, so two instances holding different descriptions report '
      + 'themselves identical — worse than not replicating at all');
  });

  it('and a CHUNK does not reach the hash either', async () => {
    // A chunk never replicates, so hashing it makes two correct instances diverge whenever their chunkers
    // disagree — which they will, across versions and across models.
    const before = (await merkleMod.computeMerkleRoot(SPACE)).root;
    await coll('files').insertOne({
      _id: CHUNK, spaceId: SPACE, path: CHUNK, parentFileId: FILE, chunkIndex: 0,
      content: 'a passage this instance chunked', tags: [], seq: 6,
    });
    assert.equal((await merkleMod.computeMerkleRoot(SPACE)).root, before,
      'a chunk changed the root. Chunks are derived locally and never travel, so this makes two correct '
      + 'instances report divergence whenever their chunkers differ.');
  });
});

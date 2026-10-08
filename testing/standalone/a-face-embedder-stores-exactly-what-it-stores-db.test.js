/**
 * CHARACTERIZATION (bundle-89): what the face path writes today — the face-chunk rows `embedFaces` stores, the label write
 * `propagateFaceLabel` makes, and how `embedImage` and `updateFileMeta` reach them. Written against the unmodified base 429e6d25 and
 * green there.
 *
 * ## Why this is its own file, and what it needs
 *
 * `face-embedder.ts:424` is one of the writers of derived rows that bundle-89 moves into `files/derived-fields.ts`, and the face row is
 * the one whose shape is least like the others: no `content`, no `embedding`, a `faceEmbedding` of a different model and width, and a
 * bounding box. It also needs a face PROVIDER to be driven at all. The external provider is used here (`mediaEmbedding.faceRecognition
 * .externalModel`): a stub that answers `{ faces: [...] }`, so the real `embedFaces` runs its decode, its size filter, its gallery lookup
 * and its writes with no model weights. The SSRF guard blocks loopback whatever the setting, so the stub binds the host's private
 * address (a private-address skip, which throws on CI like the rest of that family).
 *
 * ## What cannot be pinned here, and why
 *
 * **A gallery MATCH** (a labelled face nearby, so a new face is auto-labelled and the parent is linked to the person) needs an Atlas
 * vector-search index on `faceEmbedding`, which the test Mongo does not have. What IS pinned is what happens without one — the first
 * photo of a fresh gallery, which is every space's first face (`Q-165`: no index until the collection holds a record). The auto-label
 * write itself (`updateFileMeta` with `linkEntities` from inside `embedFaces`) is covered through the label-propagation cases below,
 * which run the same `updateFileMeta` branch from the other side.
 *
 * Not pinned: a job that outlives its file's flag (bundle-89 makes the face writer refuse for a flagged parent).
 *
 * Run: node --test testing/standalone/a-face-embedder-stores-exactly-what-it-stores-db.test.js
 * (requires a prior `npm run build` in server/, the test MongoDB and a non-loopback IPv4 address)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** The space at the `recognition` rung of the image ladder. */
const FACES = 'faces';
/** A space set to the `caption` rung: its images are described and never analysed for faces, whatever the instance ceiling allows. */
const PLAIN = 'plain';
const DIMS = 4;
const FACE_DIMS = 128;
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const T0 = '2026-08-01T00:00:00.000Z';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-face-'));

/**
 * Bytes as the PLAINTEXT HANDLE `embedFaces` takes since bundle-89 (`files/plaintext-file.ts`): a path and a size.
 *
 * The subject of this file is what the embedder STORES, and that did not change; what changed is that it is handed a
 * path so a 100 MiB picture is not held in memory beside its own decode. The fixture therefore writes its bytes once
 * and names them, which is also what the real worker does.
 */
let handleSeq = 0;
const handleOf = (bytes) => {
  const p = path.join(scratch, `fixture-${handleSeq++}.png`);
  fs.writeFileSync(p, bytes);
  return { path: p, size: bytes.length, copied: true, dispose: async () => { /* the suite removes its scratch */ } };
};
const CONFIG_PATH = path.join(scratch, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = scratch;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_ALLOW_PRIVATE_FACE_EXTERNAL'] = 'true';

let faceServer, embedServer, embedLocal, mongo, faceMod, imageMod, meta, loader, sharp, png;
/** What the stub face provider is asked, and what it answers (mutable per case). */
let faceRequests = [];
let faceAnswer;
let faceStatus = 200;
let embedded = [];

const files = (space = FACES) => mongo.col(`${space}_files`);
const entities = (space = FACES) => mongo.col(`${space}_entities`);
const mediaJobs = (space = FACES) => mongo.col(`${space}_media_jobs`);

/** A 128-wide descriptor, distinguishable per `seed`. */
const descriptor = (seed) => Array.from({ length: FACE_DIMS }, (_, i) => ((seed * 7 + i) % 100) / 100);
const BIG = [0.1, 0.1, 0.5, 0.5];
const TINY = [0.1, 0.1, 0.01, 0.01];

const parentRow = (id, over = {}, space = FACES) => ({ _id: id, spaceId: space, path: id, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 100, author: LOCAL, seq: 5, ...over });
const seedParent = async (id, over = {}, space = FACES) => { const d = parentRow(id, over, space); await files(space).insertOne(d); return d; };
const faceRows = (id, space = FACES) => files(space).find({ parentFileId: id, faceEmbedding: { $exists: true } }).sort({ chunkIndex: 1 }).toArray();

const FACE_KEYS = ['_id', 'spaceId', 'path', 'tags', 'createdAt', 'updatedAt', 'sizeBytes', 'author', 'parentFileId', 'chunkIndex', 'faceEmbedding'];
const keysOf = (doc) => Object.keys(doc).sort();

function configure({ reprocessSyncedImages = true } = {}) {
  const host = `${privateHostAddress()}:${faceServer.address().port}`;
  loader.getConfig().mediaEmbedding = {
    levels: { images: 'recognition' },
    faceRecognition: {
      enabled: true, reprocessSyncedImages,
      externalModel: { baseUrl: `http://${host}/detect`, acknowledgedHost: host },
    },
  };
}

describe('the face path stores exactly what it stores today (real MongoDB, real sharp, external face provider stub)', { skip }, () => {
  before(async () => {
    faceServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        faceRequests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
        res.writeHead(faceStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(faceAnswer()));
      });
    });
    // own-listener: binds every interface so the LAN address answers, because the SSRF guard blocks loopback and the face provider is fetched through it
    await new Promise((resolve) => faceServer.listen(0, '0.0.0.0', resolve));

    embedServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        embedded.push(JSON.parse(body).input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => i / 10 + 0.05) }] }));
      });
    });
    embedLocal = await listenOnLoopback(embedServer);
    process.env['EMBEDDING_URL'] = embedLocal.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...LOCAL,
      spaces: [{ id: FACES, label: 'Faces', imageAnalysis: 'recognition' }, { id: PLAIN, label: 'Plain', imageAnalysis: 'caption' }],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('b89c_face');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    configure();
    faceMod = await import('../../server/dist/files/media/face-embedder.js');
    imageMod = await import('../../server/dist/files/media/image-embedder.js');
    meta = await import('../../server/dist/files/file-meta.js');
    sharp = (await import('sharp')).default;
    png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#8899aa' } }).png().toBuffer();
  });

  after(async () => {
    await closeTestMongo();
    await new Promise((resolve) => faceServer?.close(() => resolve()));
    faceServer?.closeAllConnections?.();
    await embedLocal?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [FACES, PLAIN]) {
      await files(space).deleteMany({}); await entities(space).deleteMany({}); await mediaJobs(space).deleteMany({});
      await mongo.col(`${space}_links`).deleteMany({});
    }
    faceRequests = []; embedded = [];
    faceStatus = 200;
    faceAnswer = () => ({ faces: [] });
    configure();
    faceMod.noteExternalFaceProviderAnswered();
  });

  describe('embedFaces', () => {
    it('stores one row per detected face with exactly these keys; the id uses the face\'s position, so a face the size filter drops leaves a gap', async () => {
      const parent = await seedParent('photos/group.png');
      faceAnswer = () => ({ faces: [
        { embedding: descriptor(1), boxRaw: BIG },
        { embedding: descriptor(2), boxRaw: TINY },
        { embedding: descriptor(3) },
      ] });

      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));

      const rows = await faceRows('photos/group.png');
      assert.deepEqual(rows.map(r => r._id), ['photos/group.png#face-chunk0', 'photos/group.png#face-chunk2'], 'chunkIndex is the face\'s index in the answer, not a count');
      const [first, third] = rows;
      assert.deepEqual(keysOf(first), [...FACE_KEYS, 'faceBbox'].sort());
      assert.deepEqual(keysOf(third), FACE_KEYS.slice().sort(), 'a face with no box has no faceBbox key');
      for (const r of rows) {
        assert.equal(r.spaceId, FACES);
        assert.equal(r.path, r._id);
        assert.deepEqual(r.tags, []);
        assert.equal(r.createdAt, r.updatedAt);
        assert.equal(r.sizeBytes, FACE_DIMS * 4, 'the stored size is the descriptor\'s width in float32s');
        assert.deepEqual(r.author, LOCAL);
        assert.equal(r.parentFileId, 'photos/group.png');
        assert.ok(!('seq' in r) && !('embedding' in r) && !('content' in r) && !('matchedText' in r) && !('faceEntityId' in r) && !('faceScore' in r));
      }
      assert.deepEqual(first.faceEmbedding, descriptor(1));
      assert.deepEqual(first.faceBbox, BIG);
      assert.deepEqual(third.faceEmbedding, descriptor(3));
      assert.equal(first.chunkIndex, 0);
      assert.equal(third.chunkIndex, 2);
      assert.deepEqual(await files().findOne({ _id: 'photos/group.png' }), parent, 'the parent row was written to (a fresh gallery has no match to label it with)');
      assert.deepEqual(embedded, [], 'a face is not embedded through the text embedder');
    });

    it('what the provider is asked: the image as base64 in a JSON POST, nothing about the space or the file', async () => {
      await seedParent('photos/group.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }] });
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));
      assert.equal(faceRequests.length, 1);
      assert.equal(faceRequests[0].method, 'POST');
      assert.equal(faceRequests[0].url, '/detect');
      assert.equal(faceRequests[0].body.image, png.toString('base64'));
      assert.deepEqual(Object.keys(faceRequests[0].body).sort(), ['image'], 'no model configured, so nothing but the image is sent');
    });

    it('a descriptor of the wrong width is dropped before anything is stored', async () => {
      await seedParent('photos/group.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1).slice(0, 64), boxRaw: BIG }, { embedding: descriptor(2), boxRaw: BIG }] });
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));
      assert.deepEqual((await faceRows('photos/group.png')).map(r => r._id), ['photos/group.png#face-chunk0'], 'the surviving face takes the first index: the width filter runs inside the provider call');
    });

    it('no faces, or a provider that fails with the in-process fallback off (the default): nothing is stored and the call returns normally', async () => {
      await seedParent('photos/group.png');
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));
      assert.equal((await faceRows('photos/group.png')).length, 0);

      faceStatus = 500;
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));
      assert.equal((await faceRows('photos/group.png')).length, 0);
      assert.equal(faceRequests.length, 2, 'the provider was asked each time');
    });

    it('bytes that are not an image: nothing is stored, the provider is not asked, and the call returns normally', async () => {
      await seedParent('photos/not.png');
      await faceMod.embedFaces(FACES, 'photos/not.png', handleOf(Buffer.from('definitely not an image')));
      assert.equal((await faceRows('photos/not.png')).length, 0);
      assert.equal(faceRequests.length, 0);
    });

    it('a space below the `recognition` rung is never analysed: the provider is not asked and nothing is stored', async () => {
      await seedParent('photos/group.png', {}, PLAIN);
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }] });
      await faceMod.embedFaces(PLAIN, 'photos/group.png', png);
      assert.equal(faceRequests.length, 0);
      assert.equal((await faceRows('photos/group.png', PLAIN)).length, 0);
    });

    it('a re-run replaces each row by id; it neither duplicates a row nor removes one the new run did not produce', async () => {
      await seedParent('photos/group.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }, { embedding: descriptor(2), boxRaw: BIG }] });
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));
      faceAnswer = () => ({ faces: [{ embedding: descriptor(9), boxRaw: BIG }] });
      await faceMod.embedFaces(FACES, 'photos/group.png', handleOf(png));

      const rows = await faceRows('photos/group.png');
      assert.deepEqual(rows.map(r => [r._id, r.faceEmbedding[0]]), [['photos/group.png#face-chunk0', descriptor(9)[0]], ['photos/group.png#face-chunk1', descriptor(2)[0]]]);
    });
  });

  describe('embedImage reaching the face path', () => {
    const vision = { caption: async () => 'a grey square' };
    const SYNCED = { arrival: true };

    it('a local image gets its caption chunk AND its face rows; the caption is what is returned', async () => {
      await seedParent('photos/p.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }] });
      const caption = await imageMod.embedImage(FACES, 'photos/p.png', handleOf(png), 'image/png', vision);
      assert.equal(caption, 'a grey square');
      assert.ok(await files().findOne({ _id: 'photos/p.png#media-chunk0' }));
      assert.deepEqual((await faceRows('photos/p.png')).map(r => r._id), ['photos/p.png#face-chunk0']);
    });

    it('an ARRIVED image with reprocessSyncedImages off is captioned and never sent to the face provider; with it on, it is analysed', async () => {
      await seedParent('photos/p.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }] });
      configure({ reprocessSyncedImages: false });
      await imageMod.embedImage(FACES, 'photos/p.png', handleOf(png), 'image/png', vision, SYNCED);
      assert.equal(faceRequests.length, 0);
      assert.ok(await files().findOne({ _id: 'photos/p.png#media-chunk0' }));
      assert.equal((await faceRows('photos/p.png')).length, 0);

      configure({ reprocessSyncedImages: true });
      await imageMod.embedImage(FACES, 'photos/p.png', handleOf(png), 'image/png', vision, SYNCED);
      assert.equal(faceRequests.length, 1);
      assert.equal((await faceRows('photos/p.png')).length, 1);
    });

    it('a LOCAL image is analysed whatever reprocessSyncedImages says', async () => {
      await seedParent('photos/p.png');
      faceAnswer = () => ({ faces: [{ embedding: descriptor(1), boxRaw: BIG }] });
      configure({ reprocessSyncedImages: false });
      await imageMod.embedImage(FACES, 'photos/p.png', handleOf(png), 'image/png', vision);
      assert.equal(faceRequests.length, 1);
    });

    it('a face failure never fails the image job: the caption chunk is stored and the caption returned', async () => {
      await seedParent('photos/p.png');
      const caption = await imageMod.embedImage(FACES, 'photos/p.png', Buffer.from('bytes sharp cannot decode'), 'image/png', vision);
      assert.equal(caption, 'a grey square');
      assert.ok(await files().findOne({ _id: 'photos/p.png#media-chunk0' }));
      assert.equal((await faceRows('photos/p.png')).length, 0);
    });
  });

  describe('propagateFaceLabel, and what triggers it through updateFileMeta', () => {
    const PERSON = '55555555-5555-4555-8555-555555555555';
    const PERSON_2 = '66666666-6666-4666-8666-666666666666';
    const PLACE = '77777777-7777-4777-8777-777777777777';
    const faceChunk = (parent, i, over = {}) => ({
      _id: `${parent}#face-chunk${i}`, spaceId: FACES, path: `${parent}#face-chunk${i}`, tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 512,
      author: LOCAL, parentFileId: parent, chunkIndex: i, faceEmbedding: descriptor(i + 1), ...over,
    });
    const entity = (id, type) => ({ _id: id, spaceId: FACES, name: id, type, tags: [], createdAt: T0, seq: 1, author: LOCAL });

    it('sets faceEntityId and updatedAt on every face row of the file — and ONLY those: not another file\'s, not a non-face row, not the parent', async () => {
      const parent = await seedParent('photos/p.png');
      await files().insertMany([
        faceChunk('photos/p.png', 0), faceChunk('photos/p.png', 1), faceChunk('photos/other.png', 0),
        { _id: 'photos/p.png#media-chunk0', spaceId: FACES, path: 'photos/p.png#media-chunk0', parentFileId: 'photos/p.png', chunkIndex: 0, content: 'caption', tags: [], createdAt: T0, updatedAt: T0, sizeBytes: 7, author: LOCAL },
      ]);
      const untouched = await files().find({ _id: { $in: ['photos/other.png#face-chunk0', 'photos/p.png#media-chunk0'] } }).sort({ _id: 1 }).toArray();

      await faceMod.propagateFaceLabel(FACES, 'photos/p.png', PERSON);

      const rows = await faceRows('photos/p.png');
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.equal(r.faceEntityId, PERSON);
        assert.ok(r.updatedAt > T0, 'the label write stamps updatedAt');
        assert.deepEqual(keysOf(r), [...FACE_KEYS, 'faceEntityId'].sort(), 'and nothing else');
        assert.ok(!('seq' in r));
      }
      assert.deepEqual(await files().find({ _id: { $in: ['photos/other.png#face-chunk0', 'photos/p.png#media-chunk0'] } }).sort({ _id: 1 }).toArray(), untouched);
      assert.deepEqual(await files().findOne({ _id: 'photos/p.png' }), parent);
    });

    it('a file with no face rows: nothing happens and nothing is created', async () => {
      await seedParent('photos/p.png');
      await faceMod.propagateFaceLabel(FACES, 'photos/p.png', PERSON);
      assert.equal(await files().countDocuments({}), 1);
    });

    it('linking a file with ONE face to exactly ONE person entity labels that face; a non-person entity beside the person is ignored', async () => {
      await seedParent('photos/p.png');
      await files().insertOne(faceChunk('photos/p.png', 0));
      await entities().insertMany([entity(PERSON, 'person'), entity(PLACE, 'location')]);

      await meta.updateFileMeta(FACES, 'photos/p.png', { linkEntities: [PERSON, PLACE] });

      assert.equal((await files().findOne({ _id: 'photos/p.png#face-chunk0' })).faceEntityId, PERSON);
    });

    it('two person entities are ambiguous: no face is labelled; neither is a file with two faces', async () => {
      await seedParent('photos/two.png');
      await files().insertOne(faceChunk('photos/two.png', 0));
      await entities().insertMany([entity(PERSON, 'person'), entity(PERSON_2, 'person')]);
      await meta.updateFileMeta(FACES, 'photos/two.png', { linkEntities: [PERSON, PERSON_2] });
      assert.ok(!('faceEntityId' in await files().findOne({ _id: 'photos/two.png#face-chunk0' })));

      await seedParent('photos/crowd.png');
      await files().insertMany([faceChunk('photos/crowd.png', 0), faceChunk('photos/crowd.png', 1)]);
      await meta.updateFileMeta(FACES, 'photos/crowd.png', { linkEntities: [PERSON] });
      for (const r of await faceRows('photos/crowd.png')) assert.ok(!('faceEntityId' in r), 'a label was guessed onto one of several faces');
    });

    it('linking an image with NO face rows queues a media job for it (so faces are produced), when synced images are reprocessed', async () => {
      await seedParent('photos/p.png');
      await entities().insertOne(entity(PERSON, 'person'));

      await meta.updateFileMeta(FACES, 'photos/p.png', { linkEntities: [PERSON] });

      const job = await mediaJobs().findOne({ _id: 'photos/p.png' });
      assert.ok(job, 'no media job was queued');
      assert.equal(job.mediaType, 'image');
      assert.equal(job.mimeType, 'image/png');
    });
  });
});

/**
 * A rebuild embeds exactly what the record's producer embedded — for every kind, and for the derived records too.
 *
 * ## Why this is a behavioural test now (Q-99 part 2)
 *
 * A reindex used to be five hand-written loops in `brain/reindex.ts`, each calling the `*EmbedText` builder its
 * collection's write path calls. The gate protecting them read the SOURCE and asserted the builder names, and it
 * passed on the defect it existed for: the loops skipped every chunk, media chunk and caption (`parentFileId` set),
 * so after a model change those records kept vectors from the old model for ever, with nothing reporting it.
 *
 * Reindex now goes through the embed queue, so `embedStoredRecord(..., { rebuild: true })` is the ONE place a
 * vector is rebuilt. What a caller needs from it is the guarantee, stated per record and checked against the
 * stored result rather than the source:
 *
 *  1. **Same text.** A rebuilt record stores the matchedText its creator stored. Kinds are derived from
 *     `COLLECTION`, with a floor, so a sixth kind is covered the day it is added or fails here for want of a creator.
 *  2. **Derived records are literal fixtures**, copied from what each producer writes (`files/converters/pipeline.ts`,
 *     `files/media/*-embedder.ts`). They are NOT derived from `derivedHasText` — a fixture built from the predicate
 *     under test asserts that the predicate equals itself.
 *  3. **An ancestor's suppression reaches its derived records**, up to the grandparent an extracted image's caption
 *     has, and a missing ancestor fails closed.
 *  4. **A rebuild forces** past the "unchanged" skip, because after a model change "the same text" is exactly the
 *     case that must still be re-embedded.
 *  5. **A transient failure during a rebuild strips nothing.** An outage mid-reindex must not remove vectors from
 *     a whole space; any other failure is still Q-94 (drop the stale vector, write the current text).
 *
 * The embedder is the real `embed()` over a stub OpenAI-compatible endpoint — see `embed-queue-drain-db.test.js`
 * for why a stub endpoint rather than a stubbed function.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-rebuild-embeds-what-the-producer-embedded-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DIMS = 8;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rebuild-text-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

/** Every input the stub embedded, so a case can assert WHAT was embedded, not only that something was. */
let seen = [];
/** 'ok' answers; '503' is a transient refusal; '400' is a per-record one. */
let mode = 'ok';

let server, local, mongo, embedRecord, embedText, loader, fact, entities, edges, chrono, fileMeta, worker, queue;

const files = () => mongo.col(`${SPACE}_files`);
const vectorFor = (text) => Array.from({ length: DIMS }, (_, i) => ((text.length + i) % 10) / 10 + 0.05);

async function drainQueue() {
  queue.resetEmbedPendingHint();
  for (let i = 0; i < 50; i++) {
    if (!(await worker.runOneEmbedJob())) return;
  }
  assert.fail('the embed queue did not drain in 50 jobs');
}

describe('a rebuild embeds what the producer embedded (real MongoDB, real embed() over a stub endpoint)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        if (mode !== 'ok') {
          const status = Number(mode);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `stub refuses with ${status}` } }));
          return;
        }
        const input = JSON.parse(body).input;
        seen.push(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(input) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('rebuildtext');
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    embedText = await import('../../server/dist/brain/embed-text.js');
    fact = await import('../../server/dist/brain/fact.js');
    entities = await import('../../server/dist/brain/entities.js');
    edges = await import('../../server/dist/brain/edges.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    fileMeta = await import('../../server/dist/files/file-meta.js');
    worker = await import('../../server/dist/brain/embed-worker.js');
    queue = await import('../../server/dist/brain/embed-queue.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['facts', 'entities', 'edges', 'chrono', 'files', 'embed_jobs', 'links']) {
      await mongo.col(`${SPACE}_${c}`).deleteMany({});
    }
    seen = [];
    mode = 'ok';
  });

  // ── 1. Every kind: the creator's text is the rebuild's text ─────────────────────────────────────────────────
  //
  // Each creator returns `{ type, id }` of the record whose matchedText is compared. The four with an inline embed
  // use it (`waitForEmbedding: true`), because that path builds its text in the WRITER — an independent derivation
  // from `buildEmbedText`, which is what makes the comparison worth having. A file has no inline path: its creator
  // is `upsertFileMeta` plus the job it queues, and the excerpt arrives the way the converter writes it.
  const CREATORS = {
    fact: async () => {
      const d = await fact.saveFact(SPACE, 'node-7 runs the platform apps', [], ['prod'], 'a description',
        { rack: 'B12' }, undefined, { waitForEmbedding: true });
      return { type: 'fact', id: d._id };
    },
    entity: async () => {
      const r = await entities.upsertEntity(SPACE, 'node-9', 'machine', ['prod'], { rack: 'B12' }, 'a box',
        undefined, { waitForEmbedding: true });
      return { type: 'entity', id: r.entity._id };
    },
    chrono: async () => {
      const c = await chrono.createChrono(SPACE, {
        title: 'the cutover', type: 'event', startsAt: '2026-08-05T09:00:00Z', tags: ['prod'],
        description: 'moved the cluster', properties: { window: 'night' },
      }, undefined, undefined, { waitForEmbedding: true });
      return { type: 'chrono', id: c._id };
    },
    file: async () => {
      await fileMeta.upsertFileMeta(SPACE, 'docs/report.pdf', 1234,
        { description: 'the quarterly report', tags: ['finance'], properties: { quarter: 'Q3' } });
      // The excerpt is how a converted document's own prose reaches its vector, and the one argument a reindex
      // once dropped. Written by the producer's own call (`files/media/worker.ts`).
      await fileMeta.updateFileMeta(SPACE, 'docs/report.pdf', { excerpt: 'Revenue grew in every region.' });
      await drainQueue();
      return { type: 'file', id: 'docs/report.pdf' };
    },
    // An edge whose ends are a FACT and a FILE, so the endpoint-kind branch of the name resolver is the one
    // exercised — the branch that was correct while every endpoint was an entity.
    edge: async () => {
      const f = await fact.saveFact(SPACE, 'the report cites the audit', [], []);
      await fileMeta.upsertFileMeta(SPACE, 'docs/audit.pdf', 10, { description: 'audit' });
      await drainQueue();
      const e = await edges.upsertEdge(SPACE, f._id, 'docs/audit.pdf', 'cites', undefined, 'reference',
        'an edge between kinds', { page: 4 }, ['prod'], undefined, undefined,
        { waitForEmbedding: true, fromKind: 'fact', toKind: 'file' });
      assert.equal(e.fromKind, 'fact', 'precondition: the edge starts at a fact');
      assert.equal(e.toKind, 'file', 'precondition: the edge ends at a file');
      return { type: 'edge', id: e._id };
    },
  };

  it('every kind embedStoredRecord serves has a creator here (derived from COLLECTION, with a floor)', () => {
    const kinds = Object.keys(embedRecord.COLLECTION);
    assert.ok(kinds.length >= 5, `COLLECTION names only ${kinds.length} kinds — the derivation is reading the wrong thing`);
    const missing = kinds.filter(k => !(k in CREATORS));
    assert.deepEqual(missing, [], `no creator fixture for: ${missing.join(', ')} — add one, or a rebuild of that kind is untested`);
  });

  for (const kind of Object.keys(CREATORS)) {
    it(`${kind}: a forced rebuild re-embeds and stores the matchedText its creator stored`, async () => {
      const { type, id } = await CREATORS[kind]();
      const coll = mongo.col(`${SPACE}_${embedRecord.COLLECTION[type]}`);
      const created = await coll.findOne({ _id: id });
      assert.ok(typeof created.matchedText === 'string' && created.matchedText.length > 0,
        `precondition: the ${kind} creator stored a matchedText`);
      assert.ok(Array.isArray(created.embedding), `precondition: the ${kind} creator stored a vector`);

      const before = seen.length;
      const outcome = await embedRecord.embedStoredRecord(SPACE, type, id, { rebuild: true });

      assert.equal(outcome, 'embedded',
        `a rebuild of a ${kind} must call the model even when the text is unchanged — that is what a reindex after a model change IS`);
      assert.deepEqual(seen.slice(before), [created.matchedText],
        `the rebuild must embed exactly the text the ${kind}'s creator embedded`);
      const rebuilt = await coll.findOne({ _id: id });
      assert.equal(rebuilt.matchedText, created.matchedText, `the ${kind}'s stored matchedText must not change on a rebuild`);
    });
  }

  // ── 2. Derived records, as their producers write them ───────────────────────────────────────────────────────

  /** A parent file the derived records hang from. Not suppressed unless the case says so. */
  async function seedParent(id, over = {}) {
    await files().insertOne({
      _id: id, spaceId: SPACE, path: id, tags: [], createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z', sizeBytes: 100, seq: 1, ...over,
    });
  }

  /** What every producer puts on a derived record besides its own fields. */
  const derivedBase = (id) => ({
    _id: id, spaceId: SPACE, path: id, tags: [], createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z', sizeBytes: 10,
  });

  it('chunkEmbedText is the shared chunk-text builder', () => {
    assert.equal(typeof embedText.chunkEmbedText, 'function',
      'embed-text.ts must export chunkEmbedText, the one builder pipeline.ts and the rebuild share');
    assert.equal(embedText.chunkEmbedText('Intro', 'the body'), 'Intro the body');
    assert.equal(embedText.chunkEmbedText(null, 'the body'), 'the body');
    assert.equal(embedText.chunkEmbedText(undefined, 'the body'), 'the body');
  });

  const TEXT_CHUNKS = [
    {
      name: 'a text chunk with a heading',
      // `files/converters/pipeline.ts`: parentFileId, chunkIndex, headingText, content.
      doc: { parentFileId: 'docs/a.pdf', chunkIndex: 0, headingText: 'Revenue', content: 'grew in every region' },
      expected: 'Revenue grew in every region',
    },
    {
      name: 'a text chunk without a heading',
      doc: { parentFileId: 'docs/a.pdf', chunkIndex: 1, headingText: null, content: 'costs fell' },
      expected: 'costs fell',
    },
    {
      name: 'an image caption chunk',
      // `files/media/image-embedder.ts`: content is the caption.
      doc: { parentFileId: 'docs/a.pdf', chunkIndex: 0, content: 'a bar chart of revenue by region' },
      expected: 'a bar chart of revenue by region',
      idSuffix: '#media-chunk0',
    },
    {
      name: 'an audio transcript chunk',
      // `files/media/audio-embedder.ts`: content is the transcript.
      doc: { parentFileId: 'docs/a.pdf', chunkIndex: 2, content: 'welcome to the quarterly call', chunkOffsetMs: 0, chunkDurationMs: 30000 },
      expected: 'welcome to the quarterly call',
      idSuffix: '#media-chunk2',
    },
    {
      name: 'a video chunk (captions prepended to the transcript)',
      // `files/media/video-embedder.ts`: content is the captions and the transcript joined by newlines.
      doc: { parentFileId: 'docs/a.pdf', chunkIndex: 3, content: 'a man at a whiteboard\nso the plan is', chunkOffsetMs: 0, chunkDurationMs: 30000 },
      expected: 'a man at a whiteboard\nso the plan is',
      idSuffix: '#media-chunk3',
    },
  ];

  for (const c of TEXT_CHUNKS) {
    it(`${c.name}: the rebuild embeds chunkEmbedText(headingText, content)`, async () => {
      await seedParent('docs/a.pdf');
      const id = `docs/a.pdf${c.idSuffix ?? `#chunk${c.doc.chunkIndex}`}`;
      await files().insertOne({ ...derivedBase(id), ...c.doc });

      const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', id, { rebuild: true });

      assert.equal(outcome, 'embedded');
      assert.deepEqual(seen, [c.expected], 'the chunk must be embedded from its own passage, not from its path');
      const stored = await files().findOne({ _id: id });
      assert.equal(stored.matchedText, c.expected);
      if (typeof embedText.chunkEmbedText === 'function') {
        assert.equal(stored.matchedText, embedText.chunkEmbedText(c.doc.headingText, c.doc.content),
          'and that text is the shared builder\'s, which is what pipeline.ts stores');
      }
      assert.ok(Array.isArray(stored.embedding) && stored.embedding.length === DIMS);
    });
  }

  const TEXTLESS = [
    {
      name: 'a face chunk',
      // `files/media/face-embedder.ts`: a face vector, no text. The junk fields stand for a vector an older
      // reindex or sync wrote; the face vector is a different index and must survive.
      id: 'photos/team.jpg#face-chunk0',
      parent: 'photos/team.jpg',
      doc: { parentFileId: 'photos/team.jpg', chunkIndex: 0, faceEmbedding: [0.1, 0.2, 0.3, 0.4] },
    },
    {
      name: 'a converted-doc record',
      // `files/converters/pipeline.ts` step 1: the `_converted/<id>.md` record, parentFileId and no content.
      id: '_converted/docs/a.pdf.md',
      parent: 'docs/a.pdf',
      doc: { parentFileId: 'docs/a.pdf' },
    },
    {
      name: 'an extracted-image record',
      // `files/converters/pipeline.ts` step 2: the image's own record; its caption is a separate chunk.
      id: '_extracted/docs/a.pdf/image-0.png',
      parent: 'docs/a.pdf',
      doc: { parentFileId: 'docs/a.pdf' },
    },
  ];

  for (const c of TEXTLESS) {
    it(`${c.name}: textless — nothing embedded, any stale vector and text unset, faceEmbedding kept`, async () => {
      await seedParent(c.parent);
      await files().insertOne({
        ...derivedBase(c.id), ...c.doc,
        embedding: [9, 9, 9, 9, 9, 9, 9, 9], embeddingModel: 'a-stale-model', matchedText: c.id,
      });

      const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', c.id, { rebuild: true });

      assert.equal(outcome, 'textless', 'a derived record with no content has nothing to embed');
      assert.deepEqual(seen, [], 'the model must not be called for a record with no text — its path is not its content');
      const stored = await files().findOne({ _id: c.id });
      assert.equal(stored.embedding, undefined, 'a stale vector on a textless record must be removed');
      assert.equal(stored.embeddingModel, undefined);
      assert.equal(stored.matchedText, undefined, 'and so must its matchedText, or the lexical channel matches a path');
      if (c.doc.faceEmbedding) {
        assert.deepEqual(stored.faceEmbedding, c.doc.faceEmbedding, 'the face vector is not the text vector and stays');
      }
    });
  }

  // ── 3. An ancestor's suppression reaches what was derived from it ───────────────────────────────────────────

  it('a chunk whose parent file is suppressed is excluded and holds no vector', async () => {
    await seedParent('docs/secret.pdf', { suppressEmbeddings: true });
    const id = 'docs/secret.pdf#chunk0';
    await files().insertOne({
      ...derivedBase(id), parentFileId: 'docs/secret.pdf', chunkIndex: 0, headingText: null, content: 'the secret',
      embedding: vectorFor('the secret'), embeddingModel: 'm',
    });

    const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', id);

    assert.equal(outcome, 'excluded', 'the operator retired the FILE from search; its passages are the file');
    assert.deepEqual(seen, []);
    assert.equal((await files().findOne({ _id: id })).embedding, undefined, 'and the chunk keeps no vector');
  });

  it('an extracted image\'s caption chunk whose GRANDPARENT is suppressed is excluded', async () => {
    await seedParent('docs/secret.pdf', { suppressEmbeddings: true });
    const imageId = '_extracted/docs/secret.pdf/image-0.png';
    await files().insertOne({ ...derivedBase(imageId), parentFileId: 'docs/secret.pdf' });
    // `files/media/image-embedder.ts`: the caption chunk's parent is the extracted IMAGE, not the document.
    const captionId = `${imageId}#media-chunk0`;
    await files().insertOne({ ...derivedBase(captionId), parentFileId: imageId, chunkIndex: 0, content: 'a chart of salaries' });

    const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', captionId);

    assert.equal(outcome, 'excluded', 'the suppression is the top-level ancestor\'s, two levels up');
    assert.deepEqual(seen, []);
    assert.equal((await files().findOne({ _id: captionId })).embedding, undefined);
  });

  it('a chunk whose parent is missing is excluded (fail closed)', async () => {
    const id = 'docs/gone.pdf#chunk0';
    await files().insertOne({ ...derivedBase(id), parentFileId: 'docs/gone.pdf', chunkIndex: 0, headingText: null, content: 'orphan' });

    const outcome = await embedRecord.embedStoredRecord(SPACE, 'file', id);

    assert.equal(outcome, 'excluded', 'an ancestor nobody can read may have been suppressed; embedding it guesses that it was not');
    assert.deepEqual(seen, []);
  });

  it('a chunk whose parent is NOT suppressed is embedded (the walk does not exclude everything)', async () => {
    await seedParent('docs/open.pdf');
    const id = 'docs/open.pdf#chunk0';
    await files().insertOne({ ...derivedBase(id), parentFileId: 'docs/open.pdf', chunkIndex: 0, headingText: null, content: 'public text' });

    assert.equal(await embedRecord.embedStoredRecord(SPACE, 'file', id), 'embedded');
    assert.deepEqual(seen, ['public text']);
  });

  // ── 4. A rebuild forces past "unchanged" ────────────────────────────────────────────────────────────────────

  async function seedCurrentEntity(id) {
    const c = mongo.col(`${SPACE}_entities`);
    const doc = {
      _id: id, spaceId: SPACE, name: 'vault', type: 'service', description: 'rotates credentials',
      tags: [], properties: {}, seq: 1, createdAt: '2026-08-01T00:00:00.000Z',
    };
    const text = await embedRecord.buildEmbedText(SPACE, 'entity', doc);
    await c.insertOne({ ...doc, embedding: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      embeddingModel: loader.getEmbeddingConfig().model, matchedText: text });
    return { c, text };
  }

  it('text, vector and model unchanged: no rebuild -> unchanged, rebuild -> the model is called', async () => {
    const { c, text } = await seedCurrentEntity('e-force');

    assert.equal(await embedRecord.embedStoredRecord(SPACE, 'entity', 'e-force'), 'unchanged',
      'the ordinary path keeps its skip: a write that changed nothing the vector depends on pays nothing');
    assert.deepEqual(seen, []);

    assert.equal(await embedRecord.embedStoredRecord(SPACE, 'entity', 'e-force', { rebuild: true }), 'embedded',
      'a rebuild must not take the skip — the operator asked for every vector to be made again');
    assert.deepEqual(seen, [text]);
    assert.deepEqual((await c.findOne({ _id: 'e-force' })).embedding, vectorFor(text));
  });

  // ── 5. Failure during a rebuild ─────────────────────────────────────────────────────────────────────────────

  /** A record as a model change leaves it: a vector from the OLD model, and the current text. */
  async function seedStaleModelEntity(id) {
    const c = mongo.col(`${SPACE}_entities`);
    const doc = {
      _id: id, spaceId: SPACE, name: 'vault', type: 'service', description: 'rotates credentials',
      tags: [], properties: {}, seq: 1, createdAt: '2026-08-01T00:00:00.000Z',
    };
    const text = await embedRecord.buildEmbedText(SPACE, 'entity', doc);
    const oldVector = [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
    await c.insertOne({ ...doc, embedding: oldVector, embeddingModel: 'the-previous-model', matchedText: text });
    return { c, text, oldVector };
  }

  it('a TRANSIENT failure on a rebuild leaves the vector and matchedText exactly as they were', async () => {
    const { c, text, oldVector } = await seedStaleModelEntity('e-outage');
    mode = '503';

    await assert.rejects(embedRecord.embedStoredRecord(SPACE, 'entity', 'e-outage', { rebuild: true }),
      /503/, 'the failure still reaches the worker, so the job retries');

    const after = await c.findOne({ _id: 'e-outage' });
    assert.deepEqual(after.embedding, oldVector,
      'an embedder outage during a reindex must not strip the space of its vectors');
    assert.equal(after.embeddingModel, 'the-previous-model', 'and the model stamp is kept, so the record still reads as stale');
    assert.equal(after.matchedText, text);
  });

  it('a NON-transient failure on a rebuild still drops the vector and writes the current text (Q-94)', async () => {
    const c = mongo.col(`${SPACE}_entities`);
    await c.insertOne({
      _id: 'e-bad', spaceId: SPACE, name: 'vault', type: 'service', description: 'now says something else',
      tags: [], properties: {}, seq: 1, embedding: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
      embeddingModel: 'the-previous-model', matchedText: 'what it used to say',
    });
    const text = await embedRecord.buildEmbedText(SPACE, 'entity', await c.findOne({ _id: 'e-bad' }));
    mode = '400';

    await assert.rejects(embedRecord.embedStoredRecord(SPACE, 'entity', 'e-bad', { rebuild: true }), /400/);

    const after = await c.findOne({ _id: 'e-bad' });
    assert.equal(after.embedding, undefined, 'a per-record failure drops the vector of text that is gone');
    assert.equal(after.matchedText, text, 'and the lexical channel matches what the record says now');
  });

  it('a transient failure WITHOUT rebuild is still Q-94 (only a rebuild keeps the old vector)', async () => {
    const c = mongo.col(`${SPACE}_entities`);
    await c.insertOne({
      _id: 'e-write', spaceId: SPACE, name: 'vault', type: 'service', description: 'edited',
      tags: [], properties: {}, seq: 1, embedding: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
      embeddingModel: 'm', matchedText: 'before the edit',
    });
    mode = '503';

    await assert.rejects(embedRecord.embedStoredRecord(SPACE, 'entity', 'e-write'), /503/);

    assert.equal((await c.findOne({ _id: 'e-write' })).embedding, undefined,
      'after a write the old vector describes text that is gone, outage or not');
  });
});

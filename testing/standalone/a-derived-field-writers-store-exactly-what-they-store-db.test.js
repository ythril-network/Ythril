/**
 * CHARACTERIZATION (bundle-89): what every writer of a derived field on a FILE row stores today, field for field, and what it
 * reports. Written against the unmodified base 429e6d25 and green there.
 *
 * ## What this is, and what it is not
 *
 * These cases describe what is, not what should be. Bundle-89 moves every derived-field write on the files collection into one
 * module (`files/derived-fields.ts`, plan rev 3 E2 item 5), and a move of that size can drop a write without a single type
 * error: the new module compiles, the old call sites are gone, and the field simply stops being set. Each case below holds one
 * writer to the exact fields it sets and unsets, the fields it must leave alone, and the outcome it reports, so a writer that
 * stops writing — or starts writing a field it never wrote — is red.
 *
 * It deliberately does NOT pin what bundle-89 changes on purpose:
 *  - a write to a row flagged `deletedAt` (today every writer below lands on it; the bundle makes them refuse);
 *  - the space counter's movement when a conditional write lands nothing (E1: today it burns a number, the bundle stops that);
 *  - the strip at flag time (new behaviour).
 * Where a case could be read as pinning one of those it says so and avoids it.
 *
 * ## The writers, and where each is driven
 *
 *  - `embedStoredRecord` (`brain/embed-record.ts`): its four guarded writes — the textless unset, the suppressed branch, the
 *    failure path and the success write — plus the outcomes `gone`, `unchanged` and `superseded`.
 *  - `setDerivedDescriptionIfUnset` (`files/file-meta.ts`): every reason it accepts and every reason it declines.
 *  - `setFileProcessingState` (`files/processing-state.ts`): set, unset, absent-is-untouched, several ids, and its refusals.
 *  - `updateFileMeta`'s excerpt write: local (stamps neither `seq` nor `updatedAt`), and the authored mix that does.
 *
 * The media embedders and `storeConversionResults` have their own files (`the-media-embedders-store-exactly-what-they-store-db`,
 * `a-conversion-store-writes-exactly-what-it-writes-db`).
 *
 * Run: node --test testing/standalone/a-derived-field-writers-store-exactly-what-they-store-db.test.js
 * (requires a prior `npm run build` in server/ and the test MongoDB)
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

const OPEN = 'general';
/** Suppresses every record in it (space tier). */
const QUIET = 'quiet';
const DIMS = 4;
const LOCAL = { instanceId: 'local-instance', instanceLabel: 'Local' };
const PEER = { instanceId: 'peer-instance', instanceLabel: 'Publisher' };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-writers-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

/** Text that makes the stub endpoint refuse the request, so the embed fails the way a provider's rejection does. */
const REFUSED = 'REFUSE-THIS-TEXT';

let server, local, mongo, embedRecord, meta, processing;
/** Every input the stub was asked to embed. */
let seen = [];
/** Runs inside the stub BEFORE it answers: the window in which a newer copy can land. */
let whileEmbedding = null;

const files = (space = OPEN) => mongo.col(`${space}_files`);
const jobs = (space = OPEN) => mongo.col(`${space}_embed_jobs`);

const T0 = '2026-08-01T00:00:00.000Z';
/** A file row as an upload leaves it, plus whatever a case adds. */
const row = (id, over = {}) => Object.fromEntries(Object.entries({
  _id: id, spaceId: OPEN, path: id, tags: ['t'], description: 'about the report', createdAt: T0, updatedAt: T0, sizeBytes: 100,
  author: LOCAL, seq: 5, ...over,
  // An `undefined` here means "no such key": the driver would store it as null, which is a different row.
}).filter(([, v]) => v !== undefined));
const seed = async (doc, space = OPEN) => { await files(space).insertOne(doc); return doc; };
const stored = (id, space = OPEN) => files(space).findOne({ _id: id });

/** The row without the named keys: what a write that changed ONLY those keys leaves behind. */
const without = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));

describe('every writer of a file row\'s derived fields stores exactly what it stores today (real MongoDB, real embed() over a stub)', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        if (whileEmbedding) { const f = whileEmbedding; whileEmbedding = null; await f(); }
        if (String(input).includes(REFUSED)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'refused' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((String(input).length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      ...LOCAL,
      spaces: [
        { id: OPEN, label: 'General' },
        { id: QUIET, label: 'Quiet', meta: { suppressEmbeddings: true } },
      ],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('b89c_writers');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    meta = await import('../../server/dist/files/file-meta.js');
    processing = await import('../../server/dist/files/processing-state.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [OPEN, QUIET]) {
      await files(space).deleteMany({});
      await jobs(space).deleteMany({});
    }
    seen = [];
    whileEmbedding = null;
  });

  // ── embedStoredRecord ───────────────────────────────────────────────────────────────────────────────────────────

  describe('embedStoredRecord, on a file row', () => {
    it('the success write: the vector, its model and the text it embedded, and nothing else — seq and updatedAt included', async () => {
      const before = await seed(row('docs/a.md', { excerpt: 'the opening prose', properties: { k: 'v' } }));

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md'), 'embedded');

      const after = await stored('docs/a.md');
      const text = await embedRecord.buildEmbedText(OPEN, 'file', before);
      assert.equal(after.matchedText, text, 'matchedText is the exact string that was embedded');
      for (const part of ['docs/a.md', 'about the report', 'the opening prose']) {
        assert.ok(text.includes(part), `the file's embed text no longer carries "${part}": ${text}`);
      }
      assert.deepEqual(seen, [text], 'the model was asked once, for exactly that text');
      assert.ok(Array.isArray(after.embedding) && after.embedding.length === DIMS, 'a vector of the space\'s width is stored');
      assert.equal(typeof after.embeddingModel, 'string', 'the model that made it is stored beside it');
      assert.deepEqual(without(after, ['embedding', 'embeddingModel', 'matchedText']), before,
        'the success write touched a field beyond the three it owns (a derived write must not stamp seq or updatedAt)');
    });

    it('an unchanged text, a vector and the same model: nothing is written and the model is not asked; rebuild asks again', async () => {
      await seed(row('docs/a.md'));
      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md'), 'embedded');
      const first = await stored('docs/a.md');
      seen = [];

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md'), 'unchanged');
      assert.deepEqual(seen, [], 'an unchanged record paid for a model call');
      assert.deepEqual(await stored('docs/a.md'), first, 'an unchanged record was written');

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md', { rebuild: true }), 'embedded');
      assert.equal(seen.length, 1, 'a rebuild must ask the model even when nothing changed');
    });

    it('a chunk row embeds its own content (heading and body), not its path', async () => {
      await seed(row('docs/a.pdf'));
      const chunk = await seed(row('docs/a.pdf#chunk0', { parentFileId: 'docs/a.pdf', chunkIndex: 0, headingText: 'Results', content: 'revenue grew', description: undefined, tags: [] }));

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.pdf#chunk0'), 'embedded');

      const after = await stored('docs/a.pdf#chunk0');
      assert.equal(after.matchedText, await embedRecord.buildEmbedText(OPEN, 'file', chunk));
      assert.ok(after.matchedText.includes('revenue grew') && after.matchedText.includes('Results'), `chunk text: ${after.matchedText}`);
      assert.ok(!after.matchedText.includes('chunk0'), 'a chunk was embedded from its path, which gives every chunk of a file one vector');
      assert.ok(Array.isArray(after.embedding) && after.embedding.length === DIMS);
      assert.deepEqual(without(after, ['embedding', 'embeddingModel', 'matchedText']), chunk);
      assert.equal(await files().countDocuments({ _id: 'docs/a.pdf' }), 1, 'the parent row was touched or removed');
      assert.equal((await stored('docs/a.pdf')).embedding, undefined, 'embedding a chunk wrote a vector on its parent');
    });

    it('a derived row with NO text is owed nothing: every derived field is unset, matchedText included, and the face vector is kept', async () => {
      await seed(row('photos/p.png'));
      const face = await seed(row('photos/p.png#face-chunk0', {
        parentFileId: 'photos/p.png', chunkIndex: 0, faceEmbedding: [0.1, 0.2, 0.3, 0.4], faceEntityId: 'e-1',
        embedding: [0.9, 0.9, 0.9, 0.9], embeddingModel: 'old-model', matchedText: 'a path someone embedded once', description: undefined, tags: [],
      }));

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'photos/p.png#face-chunk0'), 'textless');

      const after = await stored('photos/p.png#face-chunk0');
      for (const f of ['embedding', 'embeddingModel', 'matchedText']) assert.ok(!(f in after), `${f} survived on a textless derived row`);
      assert.deepEqual(after.faceEmbedding, face.faceEmbedding, 'the face vector is another index of another model and is not this writer\'s');
      assert.equal(after.faceEntityId, 'e-1');
      assert.deepEqual(without(after, []), without(face, ['embedding', 'embeddingModel', 'matchedText']), 'the unset touched a field beyond the derived ones');
      assert.deepEqual(seen, [], 'a row with no text was sent to the embedder');
    });

    it('a derived row with no text and nothing derived on it is left exactly as it is', async () => {
      const bare = await seed(row('photos/p.png#face-chunk1', { parentFileId: 'photos/p.png', chunkIndex: 1, faceEmbedding: [0.1, 0.2, 0.3, 0.4], description: undefined, tags: [] }));
      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'photos/p.png#face-chunk1'), 'textless');
      assert.deepEqual(await stored('photos/p.png#face-chunk1'), bare);
    });

    for (const [name, space, over] of [
      ['the record\'s own flag', OPEN, { suppressEmbeddings: true }],
      ['the space setting', QUIET, {}],
    ]) {
      it(`suppressed by ${name}: the vector and its model go, matchedText becomes the current text, the model is not asked`, async () => {
        const before = await seed(row('docs/a.md', { spaceId: space, embedding: [0.5, 0.5, 0.5, 0.5], embeddingModel: 'old', matchedText: 'stale text', ...over }), space);

        assert.equal(await embedRecord.embedStoredRecord(space, 'file', 'docs/a.md'), 'excluded');

        const after = await stored('docs/a.md', space);
        assert.ok(!('embedding' in after) && !('embeddingModel' in after), 'a suppressed record kept a vector');
        assert.equal(after.matchedText, await embedRecord.buildEmbedText(space, 'file', before), 'the lexical channel must search the CURRENT text');
        assert.notEqual(after.matchedText, 'stale text');
        assert.deepEqual(without(after, ['matchedText']), without(before, ['embedding', 'embeddingModel', 'matchedText']));
        assert.deepEqual(seen, [], 'text of a suppressed file went to the embedder');
      });
    }

    it('a chunk whose PARENT is suppressed is excluded the same way (the flag is read up the tree)', async () => {
      await seed(row('docs/secret.pdf', { suppressEmbeddings: true }));
      await seed(row('docs/secret.pdf#chunk0', { parentFileId: 'docs/secret.pdf', chunkIndex: 0, content: 'classified text', description: undefined, tags: [], embedding: [0.2, 0.2, 0.2, 0.2], embeddingModel: 'old' }));

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/secret.pdf#chunk0'), 'excluded');

      const after = await stored('docs/secret.pdf#chunk0');
      assert.ok(!('embedding' in after) && !('embeddingModel' in after));
      assert.ok(after.matchedText.includes('classified text'), 'a suppressed chunk keeps the text the lexical channel searches');
      assert.deepEqual(seen, []);
    });

    it('the failure path: it throws, the vector of the old text is dropped and matchedText becomes the new text', async () => {
      const before = await seed(row('docs/a.md', { description: `${REFUSED} here`, embedding: [0.4, 0.4, 0.4, 0.4], embeddingModel: 'old', matchedText: 'the text before' }));

      await assert.rejects(() => embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md'));

      const after = await stored('docs/a.md');
      assert.ok(!('embedding' in after) && !('embeddingModel' in after), 'a stale vector survived a failed embed');
      assert.equal(after.matchedText, await embedRecord.buildEmbedText(OPEN, 'file', before));
      assert.ok(after.matchedText.includes(REFUSED));
      assert.deepEqual(without(after, ['matchedText']), without(before, ['embedding', 'embeddingModel', 'matchedText']));
      assert.equal(seen.length, 1, 'the model was asked once and refused');
    });

    it('a record that is not there is `gone`, and nothing is created', async () => {
      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/never.md'), 'gone');
      assert.equal(await files().countDocuments({}), 0);
    });

    it('a copy that landed while the model ran is `superseded`: the old text\'s vector is not written onto it', async () => {
      await seed(row('docs/a.md'));
      whileEmbedding = async () => { await files().updateOne({ _id: 'docs/a.md' }, { $set: { seq: 6, description: 'the newer copy' } }); };

      assert.equal(await embedRecord.embedStoredRecord(OPEN, 'file', 'docs/a.md'), 'superseded');

      const after = await stored('docs/a.md');
      assert.ok(!('embedding' in after) && !('matchedText' in after), 'the job wrote the old version\'s vector onto the newer copy');
      assert.equal(after.description, 'the newer copy');
      assert.equal(after.seq, 6);
    });
  });

  // ── setDerivedDescriptionIfUnset ────────────────────────────────────────────────────────────────────────────────

  describe('setDerivedDescriptionIfUnset', () => {
    const ACCEPTED = {
      'no description field': { description: undefined },
      'a null description': { description: null },
      'an empty description': { description: '' },
      'a whitespace-only description': { description: ' \t\n ' },
      'a row authored by THIS instance': { author: LOCAL, description: undefined },
      'a legacy row that names no author': { author: undefined, description: undefined },
    };
    for (const [reason, over] of Object.entries(ACCEPTED)) {
      it(`accepts ${reason}: writes the description, its source, a new seq and updatedAt, and nothing else`, async () => {
        // seq 0, so "a seq above the old one" is a statement about the stamp and not about where the counter happens to stand.
        const before = await seed(row('docs/a.md', { seq: 0, ...over }));

        assert.equal(await meta.setDerivedDescriptionIfUnset(OPEN, 'docs/a.md', 'Derived summary', 'generated'), true);

        const after = await stored('docs/a.md');
        assert.equal(after.description, 'Derived summary');
        assert.equal(after.descriptionSource, 'generated');
        assert.ok(Number.isInteger(after.seq) && after.seq > before.seq, `an authored write stamps a seq above ${before.seq}, got ${after.seq}`);
        assert.ok(after.updatedAt > before.updatedAt, 'an authored write stamps updatedAt');
        assert.deepEqual(without(after, ['description', 'descriptionSource', 'seq', 'updatedAt']),
          without(before, ['description', 'seq', 'updatedAt']),
          'the derived description write changed a field it does not own (author included: it never claims a legacy row)');
        assert.equal(await jobs().countDocuments({}), 0, 'a derived description write enqueues no embed job of its own');
      });
    }

    const DECLINED = {
      'a description a person wrote': { description: 'MINE' },
      'a one-character description': { description: 'x' },
      'a description with surrounding whitespace': { description: '  mine  ' },
      'a row authored by ANOTHER instance': { author: PEER },
    };
    for (const [reason, over] of Object.entries(DECLINED)) {
      it(`declines ${reason}: returns false and the row is exactly as it was`, async () => {
        const before = await seed(row('docs/a.md', { descriptionSource: 'extracted', ...over }));

        assert.equal(await meta.setDerivedDescriptionIfUnset(OPEN, 'docs/a.md', 'Derived summary', 'generated'), false);

        assert.deepEqual(await stored('docs/a.md'), before);
      });
    }

    it('declines a path with no row at all: false, and no row is created', async () => {
      assert.equal(await meta.setDerivedDescriptionIfUnset(OPEN, 'docs/none.md', 'Derived summary', 'generated'), false);
      assert.equal(await files().countDocuments({}), 0);
    });

    it('both sources are written as given, and a missing source REMOVES the previous one', async () => {
      await seed(row('docs/a.md', { description: '', descriptionSource: 'generated' }));
      assert.equal(await meta.setDerivedDescriptionIfUnset(OPEN, 'docs/a.md', 'Extracted opening', 'extracted'), true);
      assert.equal((await stored('docs/a.md')).descriptionSource, 'extracted');

      await files().updateOne({ _id: 'docs/a.md' }, { $set: { description: '' } });
      assert.equal(await meta.setDerivedDescriptionIfUnset(OPEN, 'docs/a.md', 'Unknown provenance'), true);
      const after = await stored('docs/a.md');
      assert.equal(after.description, 'Unknown provenance');
      assert.ok(!('descriptionSource' in after), 'a description with no source inherited the previous one\'s label');
    });
  });

  // ── setFileProcessingState ──────────────────────────────────────────────────────────────────────────────────────

  describe('setFileProcessingState', () => {
    it('sets every field it is given and nothing else: seq, updatedAt and the authored half are untouched', async () => {
      const before = await seed(row('docs/a.md'));

      await processing.setFileProcessingState(OPEN, 'docs/a.md', {
        embeddingStatus: 'partial', mediaJobError: 'boom', mediaType: 'image', chunkCount: 7, convertedFileId: '_converted/docs/a.md.md', conversionError: 'oops',
      });

      const after = await stored('docs/a.md');
      assert.deepEqual(after, {
        ...before, embeddingStatus: 'partial', mediaJobError: 'boom', mediaType: 'image', chunkCount: 7,
        convertedFileId: '_converted/docs/a.md.md', conversionError: 'oops',
      });
    });

    it('a key given as undefined is REMOVED, and a key left out is LEFT ALONE', async () => {
      await seed(row('docs/a.md', { embeddingStatus: 'failed', mediaJobError: 'old error', chunkCount: 3 }));

      await processing.setFileProcessingState(OPEN, 'docs/a.md', { embeddingStatus: 'complete', mediaJobError: undefined });

      const after = await stored('docs/a.md');
      assert.equal(after.embeddingStatus, 'complete');
      assert.ok(!('mediaJobError' in after), 'undefined must remove the field, not store null');
      assert.equal(after.chunkCount, 3, 'a field the state does not name was changed');
    });

    it('several ids are one write over each; an id with no row creates nothing', async () => {
      await seed(row('docs/a.md'));
      await seed(row('docs/b.md'));

      await processing.setFileProcessingState(OPEN, ['docs/a.md', 'docs/b.md', 'docs/none.md'], { embeddingStatus: 'pending' });

      assert.equal((await stored('docs/a.md')).embeddingStatus, 'pending');
      assert.equal((await stored('docs/b.md')).embeddingStatus, 'pending');
      assert.equal(await stored('docs/none.md'), null, 'a processing mark created a row');
      assert.equal(await files().countDocuments({}), 2);
    });

    it('an empty target list is a no-op, not an error', async () => {
      const before = await seed(row('docs/a.md'));
      await processing.setFileProcessingState(OPEN, [], { embeddingStatus: 'pending' });
      assert.deepEqual(await stored('docs/a.md'), before);
    });

    it('refuses a hashed field, a field that is not a processing field, and an empty state — and writes nothing', async () => {
      const before = await seed(row('docs/a.md'));
      for (const [label, state, pattern] of [
        ['a hashed field', { description: 'x' }, /is hashed and replicates/],
        ['updatedAt', { updatedAt: 'x' }, /is hashed and replicates/],
        ['seq', { seq: 9 }, /is hashed and replicates/],
        ['a field that is not a processing field', { embedding: [1] }, /is not a file processing field/],
        ['a made-up field', { nonsense: 1 }, /is not a file processing field/],
        ['an empty state', {}, /nothing to record/],
      ]) {
        await assert.rejects(() => processing.setFileProcessingState(OPEN, 'docs/a.md', state), pattern, label);
      }
      assert.deepEqual(await stored('docs/a.md'), before);
    });

    it('a refusal is checked before ANY field is written, so a mixed state writes none of it', async () => {
      const before = await seed(row('docs/a.md'));
      await assert.rejects(() => processing.setFileProcessingState(OPEN, 'docs/a.md', { embeddingStatus: 'complete', description: 'x' }), /is hashed/);
      assert.deepEqual(await stored('docs/a.md'), before);
    });
  });

  // ── updateFileMeta: the excerpt ─────────────────────────────────────────────────────────────────────────────────

  describe('updateFileMeta, as the media worker writes a derived excerpt', () => {
    it('an excerpt alone is a LOCAL write: it sets the excerpt, stamps neither seq nor updatedAt, queues one embed job, and returns the row', async () => {
      const before = await seed(row('docs/a.md'));

      const returned = await meta.updateFileMeta(OPEN, 'docs/a.md', { excerpt: 'the opening prose' });

      const after = await stored('docs/a.md');
      assert.deepEqual(after, { ...before, excerpt: 'the opening prose' }, 'the excerpt write changed a field beyond the excerpt');
      assert.equal(returned.excerpt, 'the opening prose');
      assert.equal(returned.seq, before.seq);
      const queued = await jobs().find({}).toArray();
      assert.equal(queued.length, 1, 'one embed job is queued for the record, whichever field moved');
      assert.equal(queued[0].recordType, 'file');
      assert.equal(queued[0].recordId, 'docs/a.md');
    });

    it('an excerpt WITH an authored field is an authored write: seq and updatedAt move', async () => {
      const before = await seed(row('docs/a.md'));

      await meta.updateFileMeta(OPEN, 'docs/a.md', { excerpt: 'prose', tags: ['t', 'u'] });

      const after = await stored('docs/a.md');
      assert.equal(after.excerpt, 'prose');
      assert.deepEqual(after.tags, ['t', 'u']);
      assert.ok(after.seq > before.seq, 'an authored write stamps a seq');
      assert.ok(after.updatedAt > before.updatedAt);
    });

    it('removing the excerpt through deleteFields is local too: the field goes and nothing is stamped', async () => {
      const before = await seed(row('docs/a.md', { excerpt: 'prose' }));

      await meta.updateFileMeta(OPEN, 'docs/a.md', {}, ['excerpt']);

      assert.deepEqual(await stored('docs/a.md'), without(before, ['excerpt']));
    });

    it('a description with no source REMOVES the stored source; a description with one sets both', async () => {
      await seed(row('docs/a.md', { descriptionSource: 'generated' }));
      await meta.updateFileMeta(OPEN, 'docs/a.md', { description: 'a person wrote this' });
      assert.ok(!('descriptionSource' in await stored('docs/a.md')));

      await meta.updateFileMeta(OPEN, 'docs/a.md', { description: 'a model wrote this', descriptionSource: 'generated' });
      const after = await stored('docs/a.md');
      assert.equal(after.description, 'a model wrote this');
      assert.equal(after.descriptionSource, 'generated');
    });

    it('a path with no row returns null, creates nothing and queues nothing', async () => {
      assert.equal(await meta.updateFileMeta(OPEN, 'docs/none.md', { excerpt: 'x' }), null);
      assert.equal(await files().countDocuments({}), 0);
      assert.equal(await jobs().countDocuments({}), 0);
    });
  });
});

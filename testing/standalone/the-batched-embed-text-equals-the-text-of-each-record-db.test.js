/**
 * `buildEmbedTexts` gives the string `buildEmbedText` gives, for every document, of every kind (bundle-49).
 *
 * ## The rule
 *
 * A vector is built from one text, and the repair sweep and the arrival writer compare a record's `matchedText` with what
 * the text builder says today. A second way to build the same text that differs in one edge case reports every record that
 * has it as changed for ever (or, the other way, as current). The batched builder exists so an edge page costs one read of
 * endpoint names per kind instead of two reads per edge, and it is the one-document builder's equal by construction: the
 * normalisation of a name (the fallback to the id, the cut at `ENDPOINT_NAME_MAX`) is one function both call.
 *
 * ## What is compared
 *
 * Per kind, derived from the code (`EMBED_SWEEP_KINDS`, floor of five): documents seeded into the collection and built both
 * ways. An edge covers an endpoint that is missing (the id stands for it), a blank name, a file endpoint (its id IS its path),
 * a fact and a chrono endpoint, and a name longer than `ENDPOINT_NAME_MAX`. A file covers a top-level row and a derived one with
 * and without text (`null`).
 *
 * Run: node --test testing/standalone/the-batched-embed-text-equals-the-text-of-each-record-db.test.js
 * (requires a prior `npm run build:server`, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-batched-text-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
let mongo, embedRecord, endpointNames, sweep;
const coll = (name) => mongo.col(`${SPACE}_${name}`);

/** Endpoints: an entity with a long name, one with a blank name, a fact, a chrono entry. */
const LONG_NAME = `long ${'x'.repeat(400)}`;
const ENTITIES = [
  { _id: 'ent-long', spaceId: SPACE, name: LONG_NAME, type: 'thing', tags: [] },
  { _id: 'ent-blank', spaceId: SPACE, name: '   ', type: 'thing', tags: [] },
  { _id: 'ent-padded', spaceId: SPACE, name: '  padded name  ', type: 'thing', tags: [] },
  { _id: 'ent-plain', spaceId: SPACE, name: 'plain', type: 'thing', tags: [] },
];
const FACTS = [{ _id: 'fact-end', spaceId: SPACE, fact: `a fact that is also an endpoint ${'y'.repeat(300)}`, tags: [] }];
const CHRONO = [{ _id: 'chrono-end', spaceId: SPACE, title: 'an endpoint title', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', status: 'upcoming', tags: [] }];

const EDGES = [
  { from: 'ent-plain', to: 'ent-plain', label: 'relates' },
  { from: 'ent-long', to: 'ent-plain', label: 'relates' },
  { from: 'ent-blank', to: 'ent-padded', label: 'relates', tags: ['t'], description: 'd' },
  { from: 'ent-missing', to: 'ent-plain', label: 'relates' },
  { from: 'fact-end', fromKind: 'fact', to: 'chrono-end', toKind: 'chrono', label: 'cites' },
  { from: 'docs/a.md', fromKind: 'file', to: 'ent-plain', label: 'about' },
  { from: 'fact-missing', fromKind: 'fact', to: 'ent-plain', label: 'about', type: 'kind', properties: { k: 'v' } },
].map((e, i) => ({ _id: `edge-${i}`, spaceId: SPACE, tags: [], ...e }));

const DOCS = {
  fact: [{ _id: 'f1', spaceId: SPACE, fact: 'one', tags: ['a'], description: 'd', properties: { p: 1 } }, { _id: 'f2', spaceId: SPACE, fact: 'two' }],
  entity: ENTITIES,
  edge: EDGES,
  chrono: [{ _id: 'c1', spaceId: SPACE, title: 't', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', status: 'upcoming', tags: [] }],
  file: [
    { _id: 'docs/a.md', spaceId: SPACE, path: 'docs/a.md', tags: ['x'], description: 'about', excerpt: 'an excerpt' },
    { _id: 'docs/a.md#chunk0', spaceId: SPACE, parentFileId: 'docs/a.md', content: 'a passage', headingText: 'Heading' },
    { _id: 'docs/a.md#chunk1', spaceId: SPACE, parentFileId: 'docs/a.md', content: '' },
    { _id: 'docs/a.md#chunk2', spaceId: SPACE, parentFileId: 'docs/a.md' },
  ],
};

describe('the batched embed text equals the text of each record', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('batchedtext');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'batched-text-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    endpointNames = await import('../../server/dist/brain/edge-endpoint-names.js');
    sweep = { EMBED_SWEEP_KINDS: (await import('../../server/dist/brain/reembed.js')).REEMBED_KINDS };
    await coll('entities').insertMany(ENTITIES);
    await coll('facts').insertMany([...DOCS.fact, ...FACTS]);
    await coll('chrono').insertMany([...DOCS.chrono, ...CHRONO]);
    await coll('edges').insertMany(EDGES);
    await coll('files').insertMany(DOCS.file);
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('covers every embed kind, derived from the code, and the long name is really over the cut', () => {
    assert.ok(sweep.EMBED_SWEEP_KINDS.length >= 5, `the floor of five kinds fell to ${sweep.EMBED_SWEEP_KINDS.length}`);
    assert.deepEqual(Object.keys(DOCS).sort(), [...sweep.EMBED_SWEEP_KINDS].sort(), 'a kind has no documents in this test');
    assert.ok(LONG_NAME.length > endpointNames.ENDPOINT_NAME_MAX, 'the long name is not over ENDPOINT_NAME_MAX: the cut is not tested');
  });

  for (const kind of ['fact', 'entity', 'edge', 'chrono', 'file']) {
    it(`${kind}: the batched text is the one-document text, document for document`, async () => {
      const docs = DOCS[kind];
      const batched = await embedRecord.buildEmbedTexts(SPACE, kind, docs);
      assert.equal(batched.length, docs.length, 'one text (or null) per document, in order');
      for (let i = 0; i < docs.length; i++) {
        assert.equal(batched[i], await embedRecord.buildEmbedText(SPACE, kind, docs[i]), `${kind} ${docs[i]._id}`);
      }
    });
  }

  it('an edge\'s text is the text of its endpoints as the per-endpoint resolver names them, not only as the batch does', async () => {
    // Independent of both builders' shared plumbing: each endpoint resolved by `resolveEdgeEndpointNames`, the text composed by `edgeEmbedText`.
    const { edgeEmbedText } = await import('../../server/dist/brain/embed-text.js');
    const batched = await embedRecord.buildEmbedTexts(SPACE, 'edge', EDGES);
    for (let i = 0; i < EDGES.length; i++) {
      const e = EDGES[i];
      const [fromName, toName] = await endpointNames.resolveEdgeEndpointNames(SPACE, e.from, e.to, e.fromKind, e.toKind);
      assert.equal(batched[i], edgeEmbedText(fromName, e.label, toName, e.tags ?? [], e.type, e.description, e.properties), `edge ${e._id}`);
    }
  });

  for (const kind of ['fact', 'entity', 'edge', 'chrono', 'file']) {
    it(`${kind}: a document whose fields have the wrong type has no text, and the rest of the page keeps its own`, async () => {
      // A pull stores a record that fails its schema, so a page can hold `tags: 'x'`. The builder threw on it, and the arrival writer
      // (a suppressed space's page) and the repair's stale walk both build a whole page at once: one such record failed the page on
      // every cycle, and every reembed call of the space.
      const good = DOCS[kind][0];
      const bad = { ...good, _id: `${good._id}-wrongtype`, tags: 'x' };
      const texts = await embedRecord.buildEmbedTexts(SPACE, kind, [bad, good]);
      assert.deepEqual(texts, [null, await embedRecord.buildEmbedText(SPACE, kind, good)]);
    });
  }

  it('an empty page is an empty answer, and a page of one edge is the one-document answer', async () => {
    assert.deepEqual(await embedRecord.buildEmbedTexts(SPACE, 'edge', []), []);
    const [one] = await embedRecord.buildEmbedTexts(SPACE, 'edge', [EDGES[1]]);
    assert.equal(one, await embedRecord.buildEmbedText(SPACE, 'edge', EDGES[1]));
  });
});

/**
 * A converge never stores new text beside an old vector (bundle-49, rule I).
 *
 * ## The rule
 *
 * A vector is stored only beside the text it was made from: `matchedText` beside a vector is that vector's text, and
 * with no vector it is the text the lexical channel searches. The embed job reads the pair as its "nothing to do"
 * test (`embed-record.ts`: vector present, `matchedText === text`, same model -> `unchanged`), so a write that puts
 * the NEW text beside the OLD vector makes the job answer `unchanged` and the vector describes text the record no
 * longer has, for ever, although the enqueue succeeded.
 *
 * ## What is asked, for every kind that has a converge
 *
 * Seed a record, give it a vector made from its text (the worker's own write), converge it by its identity with new
 * text, and ask: the vector that is still there is stored beside the OLD text (or is gone), and the job that follows
 * never answers `unchanged` and leaves no vector made from the old text. A converge the record now suppresses leaves
 * no vector and the NEW text, and a suppressed local edge has its text like the other kinds.
 *
 * The kinds are derived from the code (`COLLECTION` minus files, which have no converge), with a floor.
 *
 * Run: node --test testing/standalone/a-converge-never-stores-new-text-beside-an-old-vector-db.test.js
 * (requires a prior `npm run build:server`, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-converge-pair-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = '8';

const SPACE = 'general';
const SEEDED = Array.from({ length: 8 }, (_, i) => (i + 1) / 10);

/** Every input the stub endpoint embedded: the inline-vector case asks WHICH text the writer embedded. */
const seen = [];
let server, local;

let mongo, embedRecord, fact, entities, chrono, edges, loader;
const coll = (name) => mongo.col(`${SPACE}_${name}`);

/** An edge hangs between entities that exist (strict linkage): one per name, made once. */
const endpoints = new Map();
async function endpoint(name) {
  if (!endpoints.has(name)) endpoints.set(name, (await entities.upsertEntity(SPACE, name, 'endpoint')).entity._id);
  return endpoints.get(name);
}

/** Per kind: how a door writes it (create or converge, with a suppression opt) and the field its text changes. */
const DOORS = {
  fact: {
    write: (text, { id, suppress } = {}) => fact.saveFact(SPACE, text, [], [], undefined, undefined, undefined,
      suppress ? { suppressEmbeddings: true } : undefined, undefined, undefined, id),
  },
  entity: {
    write: async (text, { id, suppress } = {}) => (await entities.upsertEntity(SPACE, text, 'concept', [], {}, undefined, id,
      suppress ? { suppressEmbeddings: true } : undefined)).entity,
  },
  chrono: {
    write: (text, { id, suppress } = {}) => chrono.createChrono(SPACE,
      { title: text, type: 'event', startsAt: '2026-09-01T00:00:00.000Z', id }, undefined, undefined,
      suppress ? { suppressEmbeddings: true } : undefined),
  },
  edge: {
    // An edge is addressed by its triplet; its text is its description, so the wording rides there.
    write: async (text, { suppress, from = 'edge-from', to = 'edge-to' } = {}) => edges.upsertEdge(SPACE, await endpoint(from), await endpoint(to),
      'relates', undefined, undefined, text, undefined, undefined, undefined, undefined, suppress ? { suppressEmbeddings: true } : undefined),
  },
};

async function asEmbedded(kind, id) {
  const family = embedRecord.COLLECTION[kind];
  const doc = await coll(family).findOne({ _id: id });
  const text = await embedRecord.buildEmbedText(SPACE, kind, doc);
  await coll(family).updateOne({ _id: id }, { $set: { embedding: SEEDED, embeddingModel: loader.getEmbeddingConfig().model, matchedText: text } });
  return text;
}

describe('a converge never stores new text beside an old vector', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const input = JSON.parse(body).input;
        seen.push(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, (_, i) => ((input.length + i) % 10) / 10 + 0.05) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;
    mongo = await openTestMongo('convergepair');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'converge-pair-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    embedRecord = await import('../../server/dist/brain/embed-record.js');
    fact = await import('../../server/dist/brain/fact.js');
    entities = await import('../../server/dist/brain/entities.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    edges = await import('../../server/dist/brain/edges.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('covers every kind that has a converge, derived from the code', () => {
    const kinds = Object.keys(embedRecord.COLLECTION).filter(k => k !== 'file');
    assert.ok(kinds.length >= 4, `the floor of four kinds fell to ${kinds.length}`);
    assert.deepEqual(Object.keys(DOORS).sort(), [...kinds].sort(), 'a kind has no door in this test, or this test names one the code lost');
  });

  /**
   * A converge STORES THE MERGE (tags union, properties shallow-merge, description kept when the write names none), so the
   * text it stores or embeds must be built from the merge too, not from the input fields. The seeds above carry no tags,
   * description or properties, where input text and merged text are the same string and nothing is checked.
   */
  const MERGED = {
    fact: {
      seed: () => fact.saveFact(SPACE, 'fact merged first', [], ['a'], 'Paris office', { k: 'v' }),
      converge: (id, opts) => fact.saveFact(SPACE, 'fact merged second', [], ['b'], undefined, { j: 'w' },
        undefined, opts, undefined, undefined, id),
    },
    chrono: {
      seed: () => chrono.createChrono(SPACE, {
        title: 'chrono merged first', type: 'event', startsAt: '2026-09-01T00:00:00.000Z',
        tags: ['a'], description: 'Paris office', properties: { k: 'v' },
      }),
      converge: (id, opts) => chrono.createChrono(SPACE, {
        title: 'chrono merged second', type: 'event', startsAt: '2026-09-01T00:00:00.000Z',
        tags: ['b'], properties: { j: 'w' }, id,
      }, undefined, undefined, opts),
    },
  };

  for (const kind of ['fact', 'chrono']) {
    for (const [name, opts] of [['suppressed', { suppressEmbeddings: true }], ['embedded inline', { waitForEmbedding: true }]]) {
      it(`${kind}: a converge that is ${name} stores the text of the MERGED record`, async () => {
        const first = await MERGED[kind].seed();
        await MERGED[kind].converge(first._id, opts);
        const stored = await coll(embedRecord.COLLECTION[kind]).findOne({ _id: first._id });
        assert.deepEqual(stored.tags, ['a', 'b'], 'the converge did not merge the tags: the test checks nothing');
        assert.equal(stored.description, 'Paris office', 'the converge dropped the description it was not told to change');
        const merged = await embedRecord.buildEmbedText(SPACE, kind, stored);
        assert.match(merged, /Paris office/, 'the merged text does not hold the kept description: the test checks nothing');
        assert.equal(stored.matchedText, merged,
          `the converge stored ${JSON.stringify(stored.matchedText)} but the record it stored reads ${JSON.stringify(merged)}`);
        if (opts.waitForEmbedding) {
          assert.ok(Array.isArray(stored.embedding), 'the inline converge stored no vector');
          assert.ok(seen.includes(merged), 'the vector was made from a text other than the merged record\'s');
        } else {
          assert.equal(stored.embedding, undefined);
        }
      });
    }
  }

  for (const kind of ['fact', 'entity', 'chrono', 'edge']) {
    it(`${kind}: the vector left by a converge sits beside its own text, and the job never answers unchanged`, async () => {
      const door = DOORS[kind];
      const first = await door.write(`${kind} first wording`, { from: `${kind}-from`, to: `${kind}-to` });
      const id = first._id;
      const oldText = await asEmbedded(kind, id);
      const family = embedRecord.COLLECTION[kind];

      await door.write(`${kind} second wording`, { id, from: `${kind}-from`, to: `${kind}-to` });
      const after = await coll(family).findOne({ _id: id });
      const newText = await embedRecord.buildEmbedText(SPACE, kind, after);
      assert.notEqual(newText, oldText, 'the converge did not change the text: the test checks nothing');
      if (Array.isArray(after.embedding)) {
        assert.equal(after.matchedText, oldText,
          `the converge stored ${JSON.stringify(after.matchedText)} beside a vector made from ${JSON.stringify(oldText)}`);
      }

      let outcome;
      try { outcome = await embedRecord.embedStoredRecord(SPACE, kind, id); } catch { outcome = 'threw'; }
      assert.notEqual(outcome, 'unchanged', 'the job took the old vector for the new text and never re-embedded it');
      const settled = await coll(family).findOne({ _id: id });
      assert.notDeepEqual(settled.embedding, SEEDED, 'the vector of the old text is still stored after the job');
      assert.equal(settled.matchedText, newText, 'the job did not settle the text it searches');
    });

    it(`${kind}: a converge the record now suppresses leaves no vector and the new text`, async () => {
      const door = DOORS[kind];
      const ends = { from: `${kind}-sfrom`, to: `${kind}-sto` };
      const first = await door.write(`${kind} before suppression`, ends);
      const id = first._id;
      await asEmbedded(kind, id);
      assert.ok(Array.isArray((await coll(embedRecord.COLLECTION[kind]).findOne({ _id: id })).embedding), 'the seed holds no vector');

      await door.write(`${kind} after suppression`, { id, suppress: true, ...ends });
      const stored = await coll(embedRecord.COLLECTION[kind]).findOne({ _id: id });
      assert.equal(stored.embedding, undefined, 'a suppressed converge left the vector the flag forbids');
      assert.equal(stored.embeddingModel, undefined, 'a suppressed converge left the model of a vector it dropped');
      assert.equal(stored.matchedText, await embedRecord.buildEmbedText(SPACE, kind, stored),
        'a suppressed record is not findable by its new text');
    });

    it(`${kind}: a suppressed insert is findable by its text`, async () => {
      const stored = await DOORS[kind].write(`${kind} suppressed from birth`, { suppress: true, from: `${kind}-bfrom`, to: `${kind}-bto` });
      const row = await coll(embedRecord.COLLECTION[kind]).findOne({ _id: stored._id });
      assert.equal(row.embedding, undefined);
      assert.equal(row.matchedText, await embedRecord.buildEmbedText(SPACE, kind, row), 'a suppressed new record has no text to search');
    });
  }
});

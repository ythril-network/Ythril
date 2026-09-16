/**
 * A record can be created ALREADY retired from meaning-ranked search, on all four types.
 *
 * ## The report
 *
 * The fleet integrator, 2026-08-30: `suppressEmbeddings` is documented, works on update, and is silently
 * dropped on create. Their cost, in their words — a dedupe marker written on every inbound message needs two
 * writes, an embedding computed only to be thrown away, and a window in between where the record IS
 * searchable when it was never meant to be.
 *
 * They are unblocked: the schema tier covers their case, because every marker shares one type, and that was
 * answered on the board. This is the general fix rather than a rescue.
 *
 * ## It was four writers, not one
 *
 * The report names `saveFact`. Every create path passed a TYPE-ONLY object to `embeddingSuppressedFor` —
 * `{ type }`, `{ label }`, `{ type: fields.type }` — so the schema and space tiers were consulted and the
 * record tier was simply not stated, on memories, entities, edges and chrono alike. Fixing the one that was
 * reported and leaving three is this repo's signature defect arriving as an omission, which is why the sweep
 * below is derived from the calls rather than from the reported name.
 *
 * ## What "suppressed" has to mean at create time
 *
 * Three things, and a fix that does two of them is worse than none:
 *
 *  1. no vector on the stored record;
 *  2. **no embed job queued** — skipping the inline embed while still queueing one stores exactly what the
 *     flag forbids a few seconds later, with nothing to come back and remove it;
 *  3. the flag STORED, so the tier resolves the same way on every later read — a reindex, a queue retry, an
 *     update that does not restate it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-record-can-be-created-already-retired-from-search-db.test.js
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
import { bodyOf } from './_structural-window.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-create-suppressed-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const A = 'aaaaaaaa-0000-4000-8000-00000000a1ce';
const B = 'aaaaaaaa-0000-4000-8000-00000000b0b0';

let mongo, mem, ents, edges, chrono, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** Embed jobs queued for one record, which is the half a "no vector" assertion cannot see. */
const jobsFor = (id) => coll('embed_jobs').countDocuments({ recordId: id });

describe('a record can be created already retired from search', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('createsuppressed');
    loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'create-suppressed-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    mem = await import('../../server/dist/brain/fact.js');
    ents = await import('../../server/dist/brain/entities.js');
    edges = await import('../../server/dist/brain/edges.js');
    chrono = await import('../../server/dist/brain/chrono.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'embed_jobs', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: A, spaceId: SPACE, name: 'A', type: 'person', tags: [], seq: 1 },
      { _id: B, spaceId: SPACE, name: 'B', type: 'person', tags: [], seq: 1 },
    ]);
  });

  /**
   * The four creates, each as `(opts) => Promise<storedId>`, so every case below is written once.
   *
   * Listed by NAME because they are a closed set the type system already fixes — four record kinds, one create
   * each. A fifth would need a collection, a schema key and a classifier too, so this is not a list that goes
   * stale in silence.
   */
  const CREATES = {
    fact: async (opts) => (await mem.saveFact(SPACE, 'a fact', [], [], undefined, undefined, 'note', opts))._id,
    entity: async (opts) => (await ents.upsertEntity(SPACE, 'Thing', 'concept', [], {}, undefined, undefined, opts)).entity._id,
    edge: async (opts) => (await edges.upsertEdge(SPACE, A, B, 'knows', undefined, undefined, undefined, undefined, undefined, undefined, undefined, opts))._id,
    // `opts` is the FIFTH parameter here — `actor` and `ttlDays` sit between it and `fields`. Passing it
    // third made this case fail against correct code, which is the shape of every positional-argument bug
    // this file's writers have collected `opts` objects to avoid.
    chrono: async (opts) => (await chrono.createChrono(SPACE, {
      title: 'an event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
    }, undefined, undefined, opts))._id,
  };

  const COLLECTION = { fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono' };

  it('every writer is reachable (the suite cannot pass by importing nothing)', () => {
    for (const [kind, fn] of Object.entries(CREATES)) {
      assert.equal(typeof fn, 'function', `${kind} create is missing`);
    }
  });

  for (const kind of Object.keys(CREATES)) {
    it(`a ${kind} created with suppressEmbeddings gets no vector, no job, and keeps the flag`, async () => {
      const id = await CREATES[kind]({ suppressEmbeddings: true });
      const doc = await coll(COLLECTION[kind]).findOne({ _id: id });

      assert.ok(doc, 'the record was not stored at all');
      assert.equal(doc.embedding, undefined, 'a vector was computed for a record retired from ranking');
      assert.equal(await jobsFor(id), 0,
        'an embed job was queued, so the vector arrives seconds later and nothing comes back to remove it — '
        + 'which is the same outcome as ignoring the flag, only harder to notice');
      assert.equal(doc.suppressEmbeddings, true,
        'the flag was not stored, so a reindex or a queue retry will embed this record anyway: the record '
        + 'tier has to survive the write, not just steer it once');
    });

    it(`and a ${kind} created WITHOUT it is queued as normal`, async () => {
      // The control, and it is not optional: "no job queued" passes on a broken embed queue, and then every
      // case above would be green while the feature did nothing.
      const id = await CREATES[kind]({});
      assert.equal(await jobsFor(id), 1, `nothing was queued for a ${kind} that should be embedded`);
    });
  }

  it('a stated `false` does not override a suppressing SPACE', async () => {
    /*
     * `false` means "this record does not suppress", not "embed this anyway". It is stored and it falls
     * through, exactly as the field's own description says — a caller who could switch a space-wide setting
     * off per record would be able to undo it one write at a time.
     */
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'create-suppressed-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: { suppressEmbeddings: true } }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    try {
      const id = await CREATES.fact({ suppressEmbeddings: false });
      assert.equal(await jobsFor(id), 0, 'a record-level false re-enabled embedding in a suppressed space');
      const doc = await coll('facts').findOne({ _id: id });
      assert.equal(doc.suppressEmbeddings, false, 'a stated false was not stored');
    } finally {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        instanceId: 'create-suppressed-test', instanceLabel: 'test', tokens: [], networks: [],
        spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
      }, null, 2), { mode: 0o600 });
      loader.loadConfig();
    }
  });

  it('suppression wins over an explicit waitForEmbedding', async () => {
    /*
     * `waitForEmbedding` asks for a record that is searchable when the call returns; suppression says it never
     * is. Computing the vector here and skipping the enqueue would store exactly what the flag forbids, which
     * is the trap `upsertEntity`'s own comment names.
     */
    const id = await CREATES.entity({ suppressEmbeddings: true, waitForEmbedding: true });
    const doc = await coll('entities').findOne({ _id: id });
    assert.equal(doc.embedding, undefined, 'an explicit wait computed a vector the flag forbids');
    assert.equal(await jobsFor(id), 0);
  });
});

describe('every create path states the record tier', () => {
  /*
   * The source half, and it is what makes the fix general rather than one report answered.
   *
   * `embeddingSuppressedFor` resolves `record > schema > space` from the object it is handed. Hand it
   * `{ type }` and the record tier is not *overridden* — it is not stated, so the schema tier answers and the
   * caller's flag has nowhere to be read from. That is a silent hole rather than an error, and it was open on
   * all four writers while the field was documented and worked on update.
   */
  const WRITERS = [
    { file: 'server/src/brain/fact.ts', fn: 'saveFact' },
    { file: 'server/src/brain/entities.ts', fn: 'upsertEntity' },
    { file: 'server/src/brain/edges.ts', fn: 'upsertEdge' },
    { file: 'server/src/brain/chrono.ts', fn: 'createChrono' },
  ];

  for (const w of WRITERS) {
    it(`${w.fn} hands the record's own flag to the resolver`, () => {
      const body = bodyOf(stripComments(readFileSync(w.file, 'utf8')), w.fn);
      const at = body.indexOf('embeddingSuppressedFor(');
      assert.ok(at > 0, `${w.fn} never asks whether this record is suppressed`);
      const call = body.slice(at, body.indexOf(')', body.indexOf('{', at)) + 1);
      assert.match(call, /suppressEmbeddings/,
        `${w.fn} asks the resolver with a type-only object, so the record tier is never stated and the `
        + 'caller\'s flag cannot be read — the schema tier answers instead, silently');
    });
  }
});

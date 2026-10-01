/**
 * A record STORED as retired from meaning-ranked search stays retired when a writer rewrites it without
 * restating the flag — on every writer that can compute a vector inline.
 *
 * ## The defect (`Q-194`)
 *
 * `suppressEmbeddings` resolves `record > schema > space`, and the record tier is the flag ON THE RECORD. Every
 * create/converge writer asks the resolver with the PAYLOAD's flag — `opts?.suppressEmbeddings` — and never with
 * the stored one. So a converge that does not restate it reads the record tier as "not stated", falls through to
 * a space that does not suppress, and:
 *
 *  - with `waitForEmbedding` (or `checkDuplicates`, which implies the wait on fact and entity) computes a vector
 *    inline and STORES it — on a record whose stored flag still says it has none;
 *  - without either, queues an embed job for it.
 *
 * The record keeps `suppressEmbeddings: true` throughout, so nothing reads as wrong — the record says it is out
 * of meaning-ranked search and is in it. `a-record-can-be-created-already-retired-from-search` covers the
 * create; this is the write after it.
 *
 * ## The set is derived
 *
 * "Every writer with an inline path" is read out of the source: every `await embed(` in `server/src/brain/`
 * that embeds a record (not a query) is in a function this file exercises, or in a named exemption with its
 * reason. Deriving it found a fifth writer the ticket did not name — `executeMerge`, which asks the resolver
 * with `{ type }` alone — so the survivor of a merge is covered here too.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-retired-record-stays-retired-when-rewritten-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-retired-rewritten-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);

const SPACE = 'general';
const A = 'aaaaaaaa-0000-4000-8000-0000000c1941';
const B = 'aaaaaaaa-0000-4000-8000-0000000c1942';

let server, mongo, factMod, entMod, edgeMod, chronoMod, bulkMod, mergeMod;
/** How many times the embedder was asked — the inline path's own witness, independent of what got stored. */
let embedCalls = 0;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const jobsFor = (id) => coll('embed_jobs').countDocuments({ recordId: id });

/**
 * Per writer: seed a record stored as suppressed (through the writer itself, so the stored shape is the
 * writer's), then rewrite it through the same writer with `opts` and NO flag.
 */
const WRITERS = {
  saveFact: {
    collection: 'facts',
    seed: async () => (await factMod.saveFact(SPACE, 'a retired fact', [], [], undefined, undefined, 'note',
      { suppressEmbeddings: true }))._id,
    rewrite: (id, opts) => factMod.saveFact(SPACE, 'a retired fact, rewritten', [], ['again'], undefined, undefined,
      'note', opts, undefined, undefined, id),
    bulk: (id) => ({ facts: [{ id, fact: 'a retired fact, rewritten', tags: ['again'], type: 'note' }] }),
  },
  upsertEntity: {
    collection: 'entities',
    seed: async () => (await entMod.upsertEntity(SPACE, 'Retired', 'concept', [], {}, undefined, undefined,
      { suppressEmbeddings: true })).entity._id,
    rewrite: (id, opts) => entMod.upsertEntity(SPACE, 'Retired', 'concept', ['again'], {}, undefined, id, opts),
    bulk: (id) => ({ entities: [{ id, name: 'Retired', type: 'concept', tags: ['again'] }] }),
  },
  upsertEdge: {
    collection: 'edges',
    seed: async () => (await edgeMod.upsertEdge(SPACE, A, B, 'knows', undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, { suppressEmbeddings: true }))._id,
    rewrite: (_id, opts) => edgeMod.upsertEdge(SPACE, A, B, 'knows', undefined, undefined, undefined, undefined,
      ['again'], undefined, undefined, opts),
    bulk: () => ({ edges: [{ from: A, to: B, label: 'knows', tags: ['again'] }] }),
  },
  createChrono: {
    collection: 'chrono',
    seed: async () => (await chronoMod.createChrono(SPACE, {
      title: 'a retired event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
    }, undefined, undefined, { suppressEmbeddings: true }))._id,
    rewrite: (id, opts) => chronoMod.createChrono(SPACE, {
      id, title: 'a retired event, rewritten', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', tags: ['again'],
    }, undefined, undefined, opts),
    bulk: (id) => ({ chrono: [{ id, title: 'a retired event, rewritten', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', tags: ['again'] }] }),
  },
};

/**
 * The inline-embed sites in `server/src/brain/` that are NOT a create/converge writer, each with the reason it
 * is not exercised as one. A site that is neither here nor in `WRITERS`/`executeMerge` fails the derivation.
 */
const NOT_A_WRITER = {
  embedStoredRecord: 'the queue job itself: it reads the record tier from the STORED document (`recordSuppression`), '
    + 'which is the behaviour every writer here is asked to match',
};

/** Rewrites asked of every writer. `{}` is the plain converge, which must not QUEUE a vector either. */
const MODES = {
  'no options': {},
  waitForEmbedding: { waitForEmbedding: true },
  checkDuplicates: { checkDuplicates: true },
};

/** `name` of the function each record-embedding `await embed(` sits in, across every tracked brain module. */
function inlineEmbedSites() {
  const files = trackedSources('server/src/brain', { floor: 20, specs: false });
  const sites = [];
  for (const file of files) {
    const src = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const call = /await\s+embed\(([^)]*)\)/g;
    for (let m; (m = call.exec(src));) {
      if (/'query'/.test(m[1])) continue; // a search embeds its QUERY, which is not a record
      const before = src.slice(0, m.index);
      const decls = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)];
      sites.push({ file, fn: decls.length ? decls[decls.length - 1][1] : '(top level)' });
    }
  }
  return sites;
}

describe('every inline-embed writer is covered (derived, not listed)', () => {
  it('each record-embedding call site is a writer exercised below, or a named exemption', () => {
    const sites = inlineEmbedSites();
    assert.ok(sites.length >= 5, `found only ${sites.length} inline embed sites — the derivation is reading nothing`);
    const covered = new Set([...Object.keys(WRITERS), 'executeMerge', ...Object.keys(NOT_A_WRITER)]);
    const unknown = sites.filter(s => !covered.has(s.fn)).map(s => `${s.file}:${s.fn}`);
    assert.deepEqual(unknown, [],
      'a function computes a record vector inline and is neither exercised here nor exempted with a reason — '
      + 'it can store a vector on a record whose stored flag forbids one');
    const seen = new Set(sites.map(s => s.fn));
    for (const fn of covered) {
      assert.ok(seen.has(fn), `${fn} is covered here but no longer embeds inline — re-derive rather than keep a stale row`);
    }
  });
});

describe('a record stored as suppressed stays suppressed when rewritten without the flag', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        embedCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0)) }] }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env['EMBEDDING_URL'] = `http://127.0.0.1:${server.address().port}`;

    mongo = await openTestMongo('retiredrewritten');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'retired-rewritten-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    factMod = await import('../../server/dist/brain/fact.js');
    entMod = await import('../../server/dist/brain/entities.js');
    edgeMod = await import('../../server/dist/brain/edges.js');
    chronoMod = await import('../../server/dist/brain/chrono.js');
    bulkMod = await import('../../server/dist/brain/bulk.js');
    mergeMod = await import('../../server/dist/brain/merge.js');
  });

  after(async () => {
    await closeTestMongo();
    await new Promise(r => server.close(r));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'embed_jobs', 'tombstones', 'links']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: A, spaceId: SPACE, name: 'A', type: 'person', tags: [], seq: 1 },
      { _id: B, spaceId: SPACE, name: 'B', type: 'person', tags: [], seq: 1 },
    ]);
    embedCalls = 0;
  });

  it('control: the embedder is reachable, so "no vector" below is a decision and not an outage', async () => {
    const id = (await entMod.upsertEntity(SPACE, 'Live', 'concept', [], {}, undefined, undefined, { waitForEmbedding: true })).entity._id;
    const doc = await coll('entities').findOne({ _id: id });
    assert.ok(Array.isArray(doc.embedding) && doc.embedding.length === DIMS, 'the stub embedder did not answer');
  });

  /** The three things "still suppressed" means after the rewrite. */
  async function assertStillSuppressed(collection, id, how) {
    const doc = await coll(collection).findOne({ _id: id });
    assert.ok(doc, 'the record is gone');
    assert.equal(doc.suppressEmbeddings, true, `${how}: the stored flag was lost, so this case no longer asks its question`);
    assert.equal(doc.embedding, undefined,
      `${how}: a vector was stored on a record whose stored flag says it has none — the writer asked the resolver `
      + 'without the record\'s own stored flag, so the record tier read as "not stated"');
    assert.equal(await jobsFor(id), 0,
      `${how}: an embed job was queued for a record stored as suppressed, so the vector the flag forbids arrives `
      + 'a few seconds later');
  }

  for (const [fn, w] of Object.entries(WRITERS)) {
    for (const [mode, opts] of Object.entries(MODES)) {
      it(`${fn}, rewriting a suppressed record with ${mode} and no flag, stores no vector and queues no job`, async () => {
        const id = await w.seed();
        await assertStillSuppressedBefore(w.collection, id);
        await w.rewrite(id, opts);
        await assertStillSuppressed(w.collection, id, `${fn} with ${mode}`);
      });
    }
    it(`${fn} through bulkWrite, rewriting a suppressed record with no flag, queues no job`, async () => {
      const id = await w.seed();
      await assertStillSuppressedBefore(w.collection, id);
      const res = await bulkMod.bulkWrite(SPACE, w.bulk(id));
      assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
      await assertStillSuppressed(w.collection, id, `bulkWrite → ${fn}`);
    });
  }

  it('executeMerge, whose survivor is stored as suppressed, gives the survivor no vector', async () => {
    const S = 'aaaaaaaa-0000-4000-8000-0000000c1943';
    const X = 'aaaaaaaa-0000-4000-8000-0000000c1944';
    await coll('entities').insertMany([
      { _id: S, spaceId: SPACE, name: 'Survivor', type: 'concept', tags: [], seq: 1, suppressEmbeddings: true },
      { _id: X, spaceId: SPACE, name: 'Absorbed', type: 'concept', tags: ['x'], seq: 1 },
    ]);
    const survivor = await coll('entities').findOne({ _id: S });
    const absorbed = await coll('entities').findOne({ _id: X });
    await mergeMod.executeMerge(SPACE, survivor, absorbed, {});
    await assertStillSuppressed('entities', S, 'executeMerge');
  });

  /** The seed is what the case says it is: stored suppressed, no vector, no job. */
  async function assertStillSuppressedBefore(collection, id) {
    const doc = await coll(collection).findOne({ _id: id });
    assert.equal(doc?.suppressEmbeddings, true, 'the seed was not stored as suppressed');
    assert.equal(doc.embedding, undefined, 'the seed already has a vector');
    assert.equal(await jobsFor(id), 0, 'the seed already has a job');
  }
});

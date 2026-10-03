/**
 * The space hash a peer is served is reused while nothing changed, and is never a different answer from a full
 * recompute after anything did (`Q-107` part 4).
 *
 * ## What it costs today
 *
 * `computeMerkleRoot` streams every document of all six record collections, plus the file manifest, on every call —
 * and it is called on every sync cycle for every `merkle: true` space (`sync/engine.ts`) and on every peer's
 * `GET /api/sync/merkle`. A space of a million records is re-read in full every few seconds whether or not a single
 * record moved.
 *
 * ## The two rules
 *
 *  1. **Nothing changed, nothing scanned.** A second call with no write in between issues no read on any record
 *     collection (the file manifest still stats the tree; its own hash cache is what spares the bytes).
 *  2. **A cached root equals a full recompute — after EVERY kind of write.** The cache is invalidated by the write
 *     observer (`db/record-write-observer.ts`), which sees writes by method, so each method family is a separate way
 *     to be missed: an insert, an update, a replace, a delete, a `bulkWrite`, a write inside a transaction (reported
 *     only when the session ends), a database RESTORE (written by its own client, invisible to the observer, and
 *     announced only through `reportDatabaseReplaced` — `O9`: a space the cache holds and nothing else ever touched
 *     must not keep its pre-restore root), and a file's bytes changing on disk (not a database write at all).
 *
 * The full recompute is computed in a SEPARATE PROCESS against the same database: a fresh process has no cache, so
 * its `computeMerkleRoot` is a full read whatever the implementation keeps in memory — the reference cannot share the
 * defect it checks. Each case also checks the write moved the full root, or the equality would pass on a no-op.
 *
 * Every case asks rule 1 first, so each is red today for the reason the plan gives: there is no cache.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-cached-merkle-root-equals-a-recompute-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { REPO_ROOT } from './_sources.mjs';

const skip = await mongoSkipReason();

const S = 'merklecache';
const DB = `ythril_harness_${S}`;
const AUTHOR = { instanceId: 'merklecache-receiver', instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';

let door, merkle, BRAIN_COLLECTIONS;
let seq = 100;

const dist = (p) => pathToFileURL(path.join(REPO_ROOT, 'server', 'dist', p)).href;

/** The root a process with no cache computes for the space — a full read, whatever this process keeps. */
function fullRecompute() {
  const src = `
    (await import(${JSON.stringify(dist('config/loader.js'))})).loadConfig();
    const mongo = await import(${JSON.stringify(dist('db/mongo.js'))});
    await mongo.connectMongo();
    try {
      const { computeMerkleRoot } = await import(${JSON.stringify(dist('brain/merkle.js'))});
      process.stdout.write(JSON.stringify(await computeMerkleRoot(process.env.MERKLE_SPACE)));
    } finally { await mongo.closeMongo(); }`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', src],
      { cwd: REPO_ROOT, env: { ...process.env, MERKLE_SPACE: S }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`the full recompute failed: ${err.message}\n${stderr}`)); return; }
        try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); } catch (e) { reject(new Error(`unparsable: ${stdout}\n${stderr}`)); }
      });
  });
}

/** The reads `fn` issued against the space's record collections. */
async function recordScansDuring(fn) {
  const record = new Set(BRAIN_COLLECTIONS.map(c => `${S}_${c}`));
  let out;
  const seen = await door.commandsDuring(async () => { out = await fn(); });
  return { out, scans: seen.filter(c => /^(find|aggregate|count|distinct) /.test(c) && record.has(c.split(' ')[1])) };
}

const fact = (_id, text) => ({ _id, spaceId: S, fact: text, tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq });
const entity = (_id, name) => ({ _id, spaceId: S, name, type: 'thing', tags: [], properties: {}, author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq });
const edge = (_id, from, to) => ({ _id, spaceId: S, from, to, label: 'rel', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq });
const filesDir = () => path.join(process.env['DATA_ROOT'], 'files', S);

describe('a cached merkle root equals a full recompute', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: S, monitorCommands: true, spaces: [{ id: S, label: 'Merkle', folders: [], completeLinkage: true, meta: {} }] });
    // Loaded BEFORE any handle the cases write through is taken: a write listener hears the collections it asks for
    // from the moment it subscribes, and a cache that never heard the write would be tested against nothing.
    merkle = await import('../../server/dist/brain/merkle.js');
    ({ BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js'));
    assert.ok(BRAIN_COLLECTIONS.length >= 6, `only ${BRAIN_COLLECTIONS.length} record collections`);
    await door.coll(S, 'facts').insertMany([fact('f-1', 'one'), fact('f-2', 'two'), fact('f-3', 'three')]);
    await door.coll(S, 'entities').insertMany([entity('e-1', 'Alpha'), entity('e-2', 'Beta')]);
    await door.coll(S, 'edges').insertOne(edge('g-1', 'e-1', 'e-2'));
  });
  after(async () => { await door?.close(); });

  /** Rule 1, asked before every write case: a warm second call reads no record collection. */
  async function assertWarmCallScansNothing() {
    await merkle.computeMerkleRoot(S);
    const { scans } = await recordScansDuring(() => merkle.computeMerkleRoot(S));
    assert.deepEqual(scans, [],
      `a second computeMerkleRoot with nothing changed read the record collections again (${scans.length} read(s): `
      + `${scans.slice(0, 4).join('; ')}) — the root is recomputed in full on every call`);
  }

  it('a second call with nothing changed does no collection scan, and returns the same root', async () => {
    const first = await merkle.computeMerkleRoot(S);
    const { out: second, scans } = await recordScansDuring(() => merkle.computeMerkleRoot(S));
    assert.equal(second.root, first.root);
    assert.deepEqual(scans, [],
      `${scans.length} record-collection read(s) on a call with nothing changed: ${scans.slice(0, 4).join('; ')}`);
  });

  /** Each write shape, through the server's own (observed) handles unless the shape is precisely that it is not. */
  const SHAPES = [
    ['an insert', () => door.coll(S, 'facts').insertOne(fact('f-4', 'four'))],
    ['an update', () => door.coll(S, 'facts').updateOne({ _id: 'f-1' }, { $set: { fact: 'one, edited', seq: ++seq } })],
    ['a replace', () => door.coll(S, 'entities').replaceOne({ _id: 'e-2' }, entity('e-2', 'Beta, replaced'))],
    ['a delete', () => door.coll(S, 'facts').deleteOne({ _id: 'f-2' })],
    ['a bulkWrite', () => door.coll(S, 'edges').bulkWrite([
      { insertOne: { document: edge('g-2', 'e-2', 'e-1') } },
      { updateOne: { filter: { _id: 'g-1' }, update: { $set: { label: 'rel-renamed', seq: ++seq } } } },
    ])],
    ['a write inside a transaction', async () => {
      const session = door.mongo.getMongo().startSession();
      try {
        await session.withTransaction(async () => {
          await door.coll(S, 'facts').insertOne(fact('f-5', 'five, in a transaction'), { session });
          await door.coll(S, 'entities').updateOne({ _id: 'e-1' }, { $set: { name: 'Alpha, in a transaction', seq: ++seq } }, { session });
        });
      } finally { await session.endSession(); }
    }],
    ['a restore (its own client, announced by reportDatabaseReplaced)', async () => {
      // The restore writes past the observer — `db/restore.ts` has its own client — and says so afterwards.
      const raw = door.mongo.getMongo().db(DB);
      await raw.collection(`${S}_facts`).deleteMany({});
      await raw.collection(`${S}_facts`).insertOne(fact('f-restored', 'restored from a backup'));
      door.mongo.reportDatabaseReplaced();
    }],
    ['a file written to the space', async () => {
      fs.mkdirSync(path.join(filesDir(), 'notes'), { recursive: true });
      fs.writeFileSync(path.join(filesDir(), 'notes', 'a.md'), 'first text');
    }],
    ['a file whose bytes change on disk', async () => {
      fs.writeFileSync(path.join(filesDir(), 'notes', 'a.md'), 'second text, and longer than the first');
    }],
  ];

  for (const [shape, write] of SHAPES) {
    it(`after ${shape}, the cached root equals a full recompute`, { timeout: 120_000 }, async () => {
      await assertWarmCallScansNothing();
      const before_ = await merkle.computeMerkleRoot(S);
      await write();
      const cached = await merkle.computeMerkleRoot(S);
      const full = await fullRecompute();
      assert.notEqual(full.root, before_.root, `${shape} did not change the space's full root, so this case asks nothing`);
      assert.equal(cached.root, full.root,
        `after ${shape} this process served root ${cached.root} (${cached.leafCount} leaves) and a full recompute is `
        + `${full.root} (${full.leafCount} leaves) — the cache answered for the space as it was before the write`);
      assert.equal(cached.leafCount, full.leafCount);
    });
  }
});

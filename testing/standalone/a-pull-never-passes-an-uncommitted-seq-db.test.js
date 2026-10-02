/**
 * A seq-paged pull never serves a seq at or above one that is allocated but not yet committed (`Q-196`).
 *
 * ## The defect
 *
 * A write takes its `seq` from `nextSeq` (`util/seq.ts`, a `findOneAndUpdate` with `$inc`) and writes the record
 * in a SEPARATE round trip afterwards — and three of the four create/converge writers await an embed, a duplicate
 * check or an endpoint lookup in between. Every pull route serves `seq > since`, sorted, with no horizon, and the
 * pulling engine (`sync/engine.ts`) moves its `deliveredThrough` watermark to the highest seq it was handed.
 *
 * So: write A allocates 7 and is still embedding; write B allocates 8 and commits; a peer pulls, is served 8, and
 * stores 8 as its watermark. A then commits at 7 — BELOW the watermark — and that peer never asks for it again.
 * Silent, permanent loss of one record on one peer, with every later cycle reporting nothing to do.
 *
 * ## The rule this file holds
 *
 * **While a seq is allocated and its write has not settled, no seq-paged pull route serves that seq or any above
 * it, and the cursor it returns does not pass it. Once the write settles, both records are served.**
 *
 * ## How a write is held, deterministically, on the code as it stands
 *
 * No sleeps and no timing races. The REAL writer runs (real `nextSeq`, real record write), and the driver call
 * that commits its record is parked: `Collection.prototype`'s write methods are wrapped so that the FIRST write to
 * the target collection after arming awaits a gate the test opens. The wrapper also hands back the `seq` the
 * parked write carries, which proves the hold sits between allocation and commit rather than before allocation.
 * That is the in-flight window exactly, and it is implementation-agnostic: whatever registry the fix adds, a real
 * writer held at its commit must hold the pull.
 *
 * ## The seam the implementation must provide (the nested describe — red at the missing export today)
 *
 * The design names "an in-process registry of in-flight allocations, released when the write settles". A bare
 * `nextSeq` returning a number cannot be released when its write settles — nothing tells the registry — so the
 * allocation must take the write with it. `util/seq.ts` must export:
 *
 *   - `withAllocatedSeqs(spaceId, n, write: (first: number) => Promise<T>): Promise<T>` — one `$inc: n`,
 *     registers `first .. first+n-1` as in flight BEFORE `write` runs, and releases them in a `finally`, so a
 *     write that throws cannot leave the horizon stuck (the guard a hand-written copy would drop).
 *   - `lowestUncommittedSeq(spaceId): number | undefined` — the lowest registered seq; every seq-paged pull
 *     route serves only `seq < lowestUncommittedSeq` (and returns a cursor no higher than the last served).
 *
 * ## Which routes — derived, never listed
 *
 * Every GET registration in `server/src/api/sync/*.ts` whose handler pages by seq: it calls a pager defined in its
 * file (a function whose body reads `seq: { $gt` or calls `listTombstones`) or does so itself. Each derived route
 * needs a case below; a new seq-paged route without one fails the coverage test rather than passing unnoticed.
 *
 * Out of scope here: the PUSH loop (`pushCollection` in `sync/engine.ts`) pages `seq > lastSeqPushed` the same
 * way and advances `lastSeqPushed` the same way, so a sender can pass its own uncommitted seq too.
 *
 * Run: node --test testing/standalone/a-pull-never-passes-an-uncommitted-seq-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom, bodyOf } from './_structural-window.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-pull-horizon-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
/** A space nothing in this file touches before its one case — the in-process seq state of a fresh start. */
const RESTARTED = 'restarted';
const ENT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ENT_B = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const FACT_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const FACT_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const AUTH = { rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } }; // reaches every space
const HOLD_TIMEOUT = 30_000; // a hang (e.g. a fix that serialises allocation) reports instead of wedging the run

// ── The derivation: every seq-paged GET route on the sync surface ────────────────────────────────────────────
function seqPagedRoutes() {
  const readsBySeq = (text) => /seq:\s*\{\s*\$gt|listTombstones\(/.test(text);
  const routes = [];
  for (const { file, text } of readTrackedSources('server/src/api/sync', { ext: ['.ts'], floor: 5 })) {
    const src = stripComments(text);
    // Pagers defined in this file: a top-level function whose body reads by seq.
    const pagers = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)]
      .map(m => m[1])
      .filter(name => readsBySeq(bodyOf(src, name)));
    for (const m of src.matchAll(/(\w+Router)\.get\(\s*'([^']+)'/g)) {
      const reg = statementFrom(src, m.index, `${file} ${m[2]}`);
      const paged = readsBySeq(reg) || pagers.some(p => new RegExp(`\\b${p}\\b`).test(reg));
      if (paged) routes.push({ file: file.replace(/\\/g, '/'), router: m[1], path: m[2] });
    }
  }
  return routes;
}

let mongo, fact, ents, edges, chrono, links, fileMeta, shared, seqMod;
const routers = {};
const coll = (n) => mongo.col(`${SPACE}_${n}`);

// ── The hold: park the first write to one collection until the test opens the gate ─────────────────────────
const WRITE_METHODS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'bulkWrite',
  'findOneAndUpdate', 'findOneAndReplace'];
let armed = null; // { name, reached, gate }
let originals = null;

function seqCarriedBy(method, args) {
  if (method === 'insertOne') return args[0]?.seq;
  if (method === 'replaceOne' || method === 'findOneAndReplace') return args[1]?.seq;
  if (method === 'updateOne' || method === 'findOneAndUpdate') return args[1]?.$set?.seq;
  // A block write carries several seqs; the LOWEST is the one the horizon must stop below.
  const seqs = method === 'insertMany' ? (args[0] ?? []).map(d => d?.seq)
    : method === 'bulkWrite' ? (args[0] ?? []).map(op =>
      op.insertOne?.document?.seq ?? op.replaceOne?.replacement?.seq ?? op.updateOne?.update?.$set?.seq)
    : [];
  const numbers = seqs.filter(s => typeof s === 'number');
  return numbers.length > 0 ? Math.min(...numbers) : undefined;
}

function installHold(proto) {
  originals = {};
  for (const m of WRITE_METHODS) {
    const orig = proto[m];
    originals[m] = orig;
    proto[m] = async function held(...args) {
      if (armed && this.collectionName === armed.name) {
        const a = armed; armed = null; // first write only; the second writer runs free
        a.reached({ method: m, seq: seqCarriedBy(m, args) });
        await a.gate;
      }
      return orig.apply(this, args);
    };
  }
}

function arm(collectionName) {
  let reached, release;
  const reachedP = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  armed = { name: collectionName, reached, gate };
  return { reached: reachedP, release };
}

/** Invoke a route's own handler in-process, past rate-limit and auth middleware the test does not exercise. */
async function pull(route, query = {}) {
  const router = routers[route.router];
  const layer = router.stack.find(l => l.route?.path === route.path && l.route.methods.get);
  assert.ok(layer, `${route.router} has no GET ${route.path}`);
  const handler = layer.route.stack.at(-1).handle;
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query: { spaceId: SPACE, sinceSeq: '0', full: 'true', ...query }, params: {}, authToken: AUTH, get: () => undefined }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}

/** What a page delivered, as seqs, and the cursor position it hands back (or null). */
function delivered(body) {
  if (Array.isArray(body?.items)) {
    return { seqs: body.items.map(i => i.seq), cursor: body.nextCursor ? shared.decodeCursor(body.nextCursor) : null };
  }
  // The tombstones route answers grouped by collection.
  return { seqs: Object.values(body).flat().map(t => t.seq), cursor: null };
}

/**
 * One case per seq-paged route: which collection the route serves from, and two REAL writes into it.
 * Literal on purpose — a fixture, not a derivation; the derivation is what decides that a case is owed.
 */
const CASES = {
  '/facts': { coll: 'facts',
    first: () => fact.saveFact(SPACE, 'held fact', [], [], undefined, undefined, 'note'),
    second: () => fact.saveFact(SPACE, 'later fact', [], [], undefined, undefined, 'note') },
  '/entities': { coll: 'entities',
    first: () => ents.upsertEntity(SPACE, 'Held', 'concept', [], {}),
    second: () => ents.upsertEntity(SPACE, 'Later', 'concept', [], {}) },
  '/edges': { coll: 'edges',
    first: () => edges.upsertEdge(SPACE, ENT_A, ENT_B, 'held'),
    second: () => edges.upsertEdge(SPACE, ENT_A, ENT_B, 'later') },
  '/chrono': { coll: 'chrono',
    first: () => chrono.createChrono(SPACE, { title: 'held', type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }),
    second: () => chrono.createChrono(SPACE, { title: 'later', type: 'event', startsAt: '2026-01-02T00:00:00.000Z' }) },
  '/links': { coll: 'links',
    first: () => links.addLink(SPACE, FACT_1, 'fact', ENT_A, 'entity'),
    second: () => links.addLink(SPACE, FACT_2, 'fact', ENT_A, 'entity') },
  '/filemeta': { coll: 'files',
    first: () => fileMeta.upsertFileMeta(SPACE, 'held.md', 10),
    second: () => fileMeta.upsertFileMeta(SPACE, 'later.md', 10) },
  '/tombstones': { coll: 'tombstones',
    first: () => fact.deleteFact(SPACE, FACT_1),
    second: () => fact.deleteFact(SPACE, FACT_2) },
};

const ROUTES = seqPagedRoutes();

describe('a pull never passes an uncommitted seq', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('pullhorizon');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'pull-horizon-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} },
        { id: RESTARTED, label: 'Restarted', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    ents = await import('../../server/dist/brain/entities.js');
    edges = await import('../../server/dist/brain/edges.js');
    chrono = await import('../../server/dist/brain/chrono.js');
    links = await import('../../server/dist/brain/links.js');
    fileMeta = await import('../../server/dist/files/file-meta.js');
    shared = await import('../../server/dist/api/sync/_shared.js');
    seqMod = await import('../../server/dist/util/seq.js');
    for (const r of ROUTES) {
      const mod = await import(`../../server/dist/${r.file.replace(/^server\/src\//, '').replace(/\.ts$/, '.js')}`);
      routers[r.router] = mod[r.router];
      assert.ok(routers[r.router], `${r.file} does not export ${r.router}`);
    }
    installHold(Object.getPrototypeOf(mongo.col('probe')));
  });

  after(async () => {
    if (originals) {
      const proto = Object.getPrototypeOf(mongo.col('probe'));
      for (const [m, f] of Object.entries(originals)) proto[m] = f;
    }
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    armed = null;
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'links', 'files', 'tombstones', 'embed_jobs']) {
      await coll(c).deleteMany({});
    }
    // Endpoints and link sources the writers read. Written directly, so they allocate nothing.
    await coll('entities').insertMany([
      { _id: ENT_A, spaceId: SPACE, name: 'A', type: 'person', tags: [], seq: 0 },
      { _id: ENT_B, spaceId: SPACE, name: 'B', type: 'person', tags: [], seq: 0 },
    ]);
    await coll('facts').insertMany([
      { _id: FACT_1, spaceId: SPACE, fact: 'one', tags: [], seq: 0 },
      { _id: FACT_2, spaceId: SPACE, fact: 'two', tags: [], seq: 0 },
    ]);
  });

  it('the derivation finds the seq-paged pull routes, so an empty set cannot pass', () => {
    assert.ok(ROUTES.length >= 6, `only ${ROUTES.length} seq-paged route(s) derived — the sweep is broken: `
      + JSON.stringify(ROUTES));
  });

  it('every derived seq-paged route has a held-write case', () => {
    const missing = ROUTES.filter(r => !CASES[r.path]).map(r => `${r.file} GET ${r.path}`);
    assert.deepEqual(missing, [], 'a seq-paged pull route with no case here is one nobody checked for the horizon');
  });

  for (const route of ROUTES) {
    const c = CASES[route.path];
    if (!c) continue;
    it(`GET ${route.path}: a page stops below a held write, then serves both once it settles`, { timeout: HOLD_TIMEOUT }, async () => {
      const hold = arm(`${SPACE}_${c.coll}`);
      const firstWrite = c.first();
      const parked = await Promise.race([
        hold.reached,
        firstWrite.then(() => { throw new Error(`the first ${c.coll} write finished without reaching its record write`); }),
      ]);
      const heldSeq = parked.seq;
      assert.equal(typeof heldSeq, 'number',
        `the parked ${parked.method} carries no seq — the hold is not between allocation and commit`);

      let during;
      let later;
      try {
        await c.second();
        later = await coll(c.coll).find({ seq: { $gt: heldSeq } }).sort({ seq: -1 }).limit(1).next();
        assert.ok(later, `the second ${c.coll} write did not commit above the held seq ${heldSeq}`);
        during = delivered(await pull(route));
      } finally {
        hold.release();
        await firstWrite;
      }
      assert.ok(!during.seqs.includes(later.seq),
        `GET ${route.path} served seq ${later.seq} while seq ${heldSeq} was allocated and uncommitted. `
        + 'A peer stores the highest seq it is handed as its watermark, so the held record — committed a moment '
        + 'later BELOW that watermark — is never pulled by that peer. Served: ' + JSON.stringify(during.seqs));
      assert.ok(during.seqs.every(s => s < heldSeq),
        `GET ${route.path} served a seq at or above the uncommitted ${heldSeq}: ${JSON.stringify(during.seqs)}`);
      assert.ok(during.cursor === null || during.cursor < heldSeq,
        `GET ${route.path} returned a cursor at ${during.cursor}, past the uncommitted ${heldSeq}`);

      const settled = delivered(await pull(route));
      assert.ok(settled.seqs.includes(heldSeq), `after it settled, the held seq ${heldSeq} is not served`);
      assert.ok(settled.seqs.includes(later.seq), `after the hold, the later seq ${later.seq} is not served`);
    });
  }

  describe('the seam: an allocation carries its write, and the registry releases on settle', () => {
    /*
     * Written against the API the implementation must export (see the docblock). On the base it fails at the
     * export check — that is its red, and it is the contract rather than an accident.
     */
    const factsRoute = () => ROUTES.find(r => r.path === '/facts');

    it('util/seq.ts exports withAllocatedSeqs and lowestUncommittedSeq', () => {
      assert.equal(typeof seqMod.withAllocatedSeqs, 'function',
        'withAllocatedSeqs(spaceId, n, write) — the allocation must take its write, or the registry cannot be '
        + 'released when the write settles');
      assert.equal(typeof seqMod.lowestUncommittedSeq, 'function',
        'lowestUncommittedSeq(spaceId) — the horizon every seq-paged pull serves below');
    });

    it('a held block holds the pull below its first seq, and is released when its write succeeds', { timeout: HOLD_TIMEOUT }, async () => {
      assert.equal(typeof seqMod.withAllocatedSeqs, 'function', 'withAllocatedSeqs is not exported');
      let open, entered;
      const gate = new Promise(r => { open = r; });
      const inside = new Promise(r => { entered = r; });
      const held = seqMod.withAllocatedSeqs(SPACE, 2, async (first) => {
        entered(first);
        await gate;
        await coll('facts').insertMany([
          { _id: 'held-a', spaceId: SPACE, fact: 'a', tags: [], seq: first },
          { _id: 'held-b', spaceId: SPACE, fact: 'b', tags: [], seq: first + 1 },
        ]);
      });
      const first = await inside;
      let during;
      try {
        assert.equal(seqMod.lowestUncommittedSeq(SPACE), first);
        await fact.saveFact(SPACE, 'later fact', [], [], undefined, undefined, 'note');
        during = delivered(await pull(factsRoute()));
      } finally { open(); await held; }
      assert.ok(during.seqs.every(s => s < first), `served at or above the held block ${first}: ${JSON.stringify(during.seqs)}`);

      assert.equal(seqMod.lowestUncommittedSeq(SPACE), undefined, 'the block was not released after its write');
      const settled = delivered(await pull(factsRoute()));
      assert.ok(settled.seqs.includes(first) && settled.seqs.includes(first + 1) && settled.seqs.some(s => s > first + 1),
        `after the block settled, not everything was served: ${JSON.stringify(settled.seqs)}`);
    });

    it('a record that ARRIVED with a seq above the local counter is served — the horizon is not the counter', async () => {
      /*
       * Found by the sync suite (`full=true returns complete memory documents`): a single-document push stores
       * the sender's seq and does not move this instance's counter, so a horizon capped at the highest seq the
       * process had ALLOCATED hid the record from every pull. What is stored must be what can be served.
       *
       * Written through the ARRIVAL WRITER, the one thing every door stores a peer's record with (5.6.2, `Q-218`).
       * It reaches the horizon by bumping the counter over the received seq, and on 5.6.x also notes the landed
       * seq (`noteSeqStored`), so a counter that could not be moved still leaves the record servable.
       */
      const arrivals = await import('../../server/dist/sync/arrivals.js').catch(() => null);
      assert.equal(typeof arrivals?.writeArrivals, 'function',
        'sync/arrivals.js exports no writeArrivals — an arriving record is not stored by the one arrival writer');
      const above = (await seqMod.currentSeq(SPACE)) + 1000;
      await arrivals.writeArrivals(SPACE, 'facts', 'fact', [{
        _id: 'arrived-high', spaceId: SPACE, fact: 'arrived from a peer', tags: [], seq: above,
        author: { instanceId: 'peer', instanceLabel: 'Peer' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }], {});
      const page = delivered(await pull(factsRoute(), { sinceSeq: String(above - 1) }));
      assert.ok(page.seqs.includes(above), `an ingested record at seq ${above} is not served: ${JSON.stringify(page.seqs)}`);
    });

    it('after a restart, records stored above the counter are served on every seq-paged route', async () => {
      /*
       * The in-process bound is seeded on first use. Seeded from the counter alone, it hides every record an
       * older version stored above it — which a single-document push always did — for as long as the counter
       * stays below. `RESTARTED` is a space this process has never touched, which is what a restart looks like.
       */
      const docs = {
        facts: { fact: 'stored high', tags: [] },
        entities: { name: 'Stored high', type: 'concept', tags: [] },
        edges: { from: ENT_A, to: ENT_B, label: 'stored_high', tags: [] },
        chrono: { title: 'stored high', type: 'event', startsAt: '2026-01-01T00:00:00.000Z', status: 'upcoming', tags: [] },
        links: { from: FACT_1, fromKind: 'fact', to: ENT_A, toKind: 'entity', label: 'mentions' },
        files: { path: 'stored-high.md', sizeBytes: 1 },
        tombstones: { type: 'fact', deletedAt: new Date().toISOString(), instanceId: 'peer' },
      };
      let seq = 5000;
      const expected = [];
      for (const route of ROUTES) {
        const c = CASES[route.path];
        const doc = docs[c.coll];
        assert.ok(doc, `no stored-high fixture for ${c.coll} — add one, or this route goes unchecked`);
        seq += 1;
        await mongo.col(`${RESTARTED}_${c.coll}`).insertOne({
          _id: `stored-high-${c.coll}`, spaceId: RESTARTED, seq, createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), author: { instanceId: 'peer', instanceLabel: 'Peer' }, ...doc,
        });
        expected.push({ route, seq });
      }
      for (const { route, seq: s } of expected) {
        const page = delivered(await pull(route, { spaceId: RESTARTED, sinceSeq: String(s - 1) }));
        assert.ok(page.seqs.includes(s),
          `GET ${route.path}: a record stored at seq ${s} above the counter is hidden after a restart: ${JSON.stringify(page.seqs)}`);
      }
    });

    it('a write that throws releases its block, so the horizon cannot stick', async () => {
      assert.equal(typeof seqMod.withAllocatedSeqs, 'function', 'withAllocatedSeqs is not exported');
      await assert.rejects(seqMod.withAllocatedSeqs(SPACE, 1, async () => { throw new Error('write failed'); }), /write failed/);
      assert.equal(seqMod.lowestUncommittedSeq(SPACE), undefined,
        'a failed write left its seq registered — every pull of this space would stall below it for ever');
    });
  });
});

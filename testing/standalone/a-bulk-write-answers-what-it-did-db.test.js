/**
 * What `bulkWrite` (brain/bulk.ts) answers for a batch — the outcomes the plan/commit rewrite (`Q-99` part 3)
 * must CHANGE, and the ones it must KEEP.
 *
 * ## Why every expectation here is written out by hand
 *
 * Once the batch and the single-record writers share one planner, a test that derives its expected answer
 * from either of them compares the code with itself and passes whatever the code does. So each case states
 * the answer a caller is owed — counts, refusals, stored shape — as literals. The one comparison that is NOT
 * a literal is the preserved-behaviour half: N one-item batches in order against ONE batch of the same N.
 * That compares two different paths through the code (no overlay vs the in-batch overlay), which is exactly
 * the part the rewrite replaces, and each such case also carries its own hand-written outcome so that both
 * sides being wrong in the same way still fails.
 *
 * ## The two halves
 *
 * - **Changed** (red before the rewrite): a converge counts as UPDATED for every kind that can converge on a
 *   supplied id (fact, chrono — entities already do); a converge-only batch is still a write for the summary
 *   webhook; an item that depends on a `$ref` whose declaring item FAILED says so, for every kind that can
 *   declare a key; a per-item reason never carries raw driver text; and a batch costs a bounded number of
 *   database commands per kind rather than a few per item.
 * - **Preserved** (green before and after): the cases where an item in a batch sees an EARLIER item of the
 *   same batch — a repeated triplet, a functional label's count, the name+type warning, an endpoint rule
 *   against an entity the batch created — answer and store exactly what the same items written one at a time
 *   in order would. And 500 items is a batch that writes 500 records.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs` for the env overrides), then
 *      node --test testing/standalone/a-bulk-write-answers-what-it-did-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bulk-outcomes-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SUITE = 'bulkoutcomes';
const DB = `ythril_harness_${SUITE}`;
/** Two spaces with the SAME meta: one written item by item, one written as a batch. */
const SINGLES = 'singles';
const BATCHED = 'batched';
const SPACE = BATCHED;

const ALICE = 'aaaaaaaa-0000-4000-8000-00000000a1ce';
const BOB   = 'aaaaaaaa-0000-4000-8000-00000000b0b0';
const CAROL = 'aaaaaaaa-0000-4000-8000-00000000ca01';

const KINDS = ['entities', 'facts', 'edges', 'chrono', 'links', 'embed_jobs', 'tombstones'];

const META = {
  validationMode: 'strict',
  strictLinkage: true,
  typeSchemas: {
    // A strict space with edge schemas allows ONLY the labels it declares, so every label used below is here.
    edge: {
      knows: {},
      mentions: {},
      reports_to: { endpoints: { from: ['person'], to: ['person'] }, functional: true },
      authored: { endpoints: { from: ['person'], to: ['document'] } },
    },
  },
};

let mongo, bulkMod, edgeId;
/** Command names issued against the harness database while `counting` is set. */
let counting = false;
let commands = [];

const coll = (space, n) => mongo.col(`${space}_${n}`);
const person = (space, id, name) => ({ _id: id, spaceId: space, name, type: 'person', tags: [], seq: 1 });

async function wipe() {
  for (const s of [SINGLES, BATCHED]) for (const c of KINDS) await coll(s, c).deleteMany({});
}

/** Commands a batch issued, minus the driver's own housekeeping. */
async function commandsDuring(fn) {
  commands = [];
  counting = true;
  try { await fn(); } finally { counting = false; }
  return commands.filter(c => !['hello', 'isMaster', 'ping', 'endSessions', 'saslContinue', 'saslStart'].includes(c));
}

describe('bulkWrite answers what it did', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'bulk-outcomes-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [SINGLES, BATCHED].map(id => ({ id, label: id, folders: [], meta: META })),
    }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo(SUITE);
    /*
     * Reconnect the server's own client with command monitoring on. Test-only, through the URI, so production
     * code needs no branch for it: the commands counted are the ones the real Mongo layer sends.
     */
    await mongo.closeMongo();
    process.env['MONGO_URI'] = `${testMongoUri(DB)}&monitorCommands=true`;
    mongo._resetDbName?.();
    await mongo.connectMongo();
    mongo.getMongo().on('commandStarted', (ev) => {
      if (counting && ev.databaseName === DB) commands.push(ev.commandName);
    });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    bulkMod = await import('../../server/dist/brain/bulk.js');
    edgeId = (await import('../../server/dist/brain/edge-id.js')).edgeIdFor;
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(wipe);

  it('the writer is reachable and monitoring sees commands (the suite cannot pass by counting nothing)', async () => {
    assert.equal(typeof bulkMod.bulkWrite, 'function');
    const seen = await commandsDuring(() => bulkMod.bulkWrite(SPACE, { facts: [{ fact: 'monitor probe' }] }));
    assert.ok(seen.length >= 1, 'command monitoring recorded nothing, so every ceiling below would pass vacuously');
  });

  // ── CHANGED: a converge is an update ─────────────────────────────────────────────────────────────────────

  describe('a converge on a supplied id counts as UPDATED, for every kind that converges (fact, chrono)', () => {
    /*
     * `inserted` is documented as NEW documents. A fact or chrono item carrying the id of an existing record
     * converges on it (W-22) and creates nothing — today both count it as inserted, so a caller resending a
     * batch after a timeout is told it created everything twice. Entities already count it as updated; this
     * holds the other two kinds to the same meaning.
     */
    it('a fact and a chrono entry converging onto existing ids are updated, not inserted', async () => {
      const first = await bulkMod.bulkWrite(SPACE, {
        facts: [{ fact: 'the sky is blue', $ref: 'f' }],
        chrono: [{ title: 'Launch', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', $ref: 'c' }],
      });
      assert.deepEqual(first.errors, []);
      const factId = first.refs.f.id;
      const chronoId = first.refs.c.id;

      const again = await bulkMod.bulkWrite(SPACE, {
        facts: [{ id: factId, fact: 'the sky is blue', tags: ['retry'] }],
        chrono: [{ id: chronoId, title: 'Launch', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', tags: ['retry'] }],
      });
      assert.deepEqual(again.errors, []);
      assert.equal(await coll(SPACE, 'facts').countDocuments({}), 1, 'the converge created a second fact');
      assert.equal(await coll(SPACE, 'chrono').countDocuments({}), 1, 'the converge created a second chrono entry');
      assert.deepEqual(
        { inserted: { facts: again.inserted.facts, chrono: again.inserted.chrono },
          updated: { facts: again.updated.facts, chrono: again.updated.chrono } },
        { inserted: { facts: 0, chrono: 0 }, updated: { facts: 1, chrono: 1 } },
        'a converge onto an existing id must count as updated — nothing new was created');
      assert.equal(bulkMod.bulkWriteTotal(again), 2,
        'a batch of two converges wrote two records; the bulk.write summary must count them');
    });

    for (const kind of ['facts', 'chrono']) {
      it(`a result holding only updated ${kind} is still a write (bulkWriteTotal > 0)`, () => {
        // A hand-built answer, so this pins the total's rule independently of how the counts are reached.
        const zero = { facts: 0, entities: 0, edges: 0, chrono: 0 };
        const r = { inserted: { ...zero }, updated: { ...zero, [kind]: 3 }, connections: { links: 0, edges: 0 }, errors: [], refs: {} };
        assert.equal(bulkMod.bulkWriteTotal(r), 3,
          `${kind} converges are records written; a converge-only batch must still emit bulk.write`);
      });
    }
  });

  // ── CHANGED: a failed dependency is named ────────────────────────────────────────────────────────────────

  describe('a key whose item failed is absent from refs, and its dependants say it failed — every declaring kind', () => {
    const FAILING = {
      facts: { fact: 'bad ttl', ttlDays: -1 },
      entities: { name: 'Bad', type: 'person', ttlDays: -1 },
      chrono: { title: 'Bad', type: 'event', startsAt: '2026-10-01T00:00:00.000Z', ttlDays: -1 },
    };
    const FROM_KIND = { facts: 'fact', entities: 'entity', chrono: 'chrono' };
    for (const [kind, item] of Object.entries(FAILING)) {
      it(`a failed ${kind} item: its key is not in refs, and the edge naming it fails naming that failure`, async () => {
        await coll(SPACE, 'entities').insertOne(person(SPACE, ALICE, 'Alice'));
        const res = await bulkMod.bulkWrite(SPACE, {
          [kind]: [{ ...item, $ref: 'k1' }],
          edges: [{ from: '$ref:k1', fromKind: FROM_KIND[kind], to: ALICE, label: 'mentions' }],
        });
        assert.equal(res.refs.k1, undefined, 'a refused item\'s key resolved to a record that was never written');
        const edgeErr = res.errors.find(e => e.type === 'edge');
        assert.ok(edgeErr, `the dependent edge was not refused: ${JSON.stringify(res)}`);
        assert.equal(await coll(SPACE, 'edges').countDocuments({}), 0);
        assert.match(edgeErr.reason, /k1/, 'the reason must name the key it depended on');
        // The dependency's OWN reason is `ttlDays` — "unknown $ref" tells a caller the key was never declared,
        // which is false: it was declared on an item that failed.
        assert.match(edgeErr.reason, /ttlDays/,
          `the dependant must carry the reason its dependency failed, not "unknown": ${edgeErr.reason}`);
      });
    }
  });

  // ── CHANGED: per-item reasons are phrased ────────────────────────────────────────────────────────────────

  it('a per-item reason never carries raw driver text (a forced duplicate key on an edge)', async () => {
    /*
     * The only duplicate-key path a single batch can reach: a stored edge whose `_id` is the id this triplet
     * derives, but whose own triplet differs, so the triplet lookup misses it and the insert collides on `_id`.
     * Facts, entities and chrono mint fresh UUIDs and cannot be driven onto a duplicate key from one call.
     */
    await coll(SPACE, 'entities').insertMany([person(SPACE, ALICE, 'Alice'), person(SPACE, BOB, 'Bob')]);
    await coll(SPACE, 'edges').insertOne({
      _id: edgeId(ALICE, BOB, 'knows'), spaceId: SPACE, from: ALICE, to: BOB, label: 'knows-legacy', tags: [], seq: 1,
    });
    const res = await bulkMod.bulkWrite(SPACE, { edges: [{ from: ALICE, to: BOB, label: 'knows' }] });
    assert.equal(res.errors.length, 1, `expected the colliding edge to be refused: ${JSON.stringify(res)}`);
    const { reason } = res.errors[0];
    assert.ok(reason.length > 0);
    for (const raw of [/E11000/, /dup key/i, /_edges\b/, /ythril_harness/, /index:/]) {
      assert.doesNotMatch(reason, raw, `a per-item reason leaked raw Mongo text: ${reason}`);
    }
  });

  // ── CHANGED: a bounded number of commands per kind ───────────────────────────────────────────────────────

  describe('a batch costs a bounded number of database commands per kind, not a few per item', () => {
    /*
     * The ceiling is from the design: per collection one seq `$inc`, chunked `$in` reads, one record
     * bulkWrite, one embed-job bulk write. 12 leaves room for chunking and the edge triplet read while being
     * far below the commands PER ITEM the loop issues today.
     */
    const CEILING = 12;
    const N = 200;

    it(`${N} facts`, async () => {
      const facts = Array.from({ length: N }, (_, i) => ({ fact: `ceiling fact ${i}` }));
      let res;
      const seen = await commandsDuring(async () => { res = await bulkMod.bulkWrite(SPACE, { facts }); });
      assert.equal(res.inserted.facts, N, JSON.stringify(res.errors.slice(0, 3)));
      assert.ok(seen.length <= CEILING,
        `${N} facts issued ${seen.length} commands (ceiling ${CEILING}): ${summarise(seen)}`);
    });

    it(`${N} edges with entity ends`, async () => {
      const ends = Array.from({ length: N }, (_, i) =>
        person(SPACE, `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, `P${i}`));
      await coll(SPACE, 'entities').insertMany([person(SPACE, ALICE, 'Alice'), ...ends]);
      const edges = ends.map(e => ({ from: ALICE, to: e._id, label: 'knows' }));
      let res;
      const seen = await commandsDuring(async () => { res = await bulkMod.bulkWrite(SPACE, { edges }); });
      assert.equal(res.inserted.edges, N, JSON.stringify(res.errors.slice(0, 3)));
      assert.ok(seen.length <= CEILING,
        `${N} edges issued ${seen.length} commands (ceiling ${CEILING}): ${summarise(seen)}`);
    });

    /*
     * The ceiling holds for every SHAPE of edge the planner tells apart, not only the one measured first: the
     * explicit-id case above passed while an edge to a record this batch mints was read back one triplet at a
     * time — a record minted a moment ago has no stored edge, so that read can only answer "none" (found by the
     * pre-ship lens sweep, 2026-10-01).
     */
    it(`${N} top-level edges between entities the same batch mints ($ref ends)`, async () => {
      const entities = Array.from({ length: N + 1 }, (_, i) => ({ $ref: `m${i}`, name: `Minted ${i}`, type: 'person' }));
      const edges = Array.from({ length: N }, (_, i) => ({ from: `$ref:m${i}`, to: `$ref:m${i + 1}`, label: 'knows' }));
      let res;
      const seen = await commandsDuring(async () => { res = await bulkMod.bulkWrite(SPACE, { entities, edges }); });
      assert.equal(res.inserted.edges, N, JSON.stringify(res.errors.slice(0, 3)));
      assert.ok(seen.length <= CEILING * 2,
        `${N} $ref edges with their ${N + 1} entities issued ${seen.length} commands (ceiling ${CEILING * 2}): ${summarise(seen)}`);
    });

    it(`${N} entities each carrying its own edge`, async () => {
      await coll(SPACE, 'entities').insertOne(person(SPACE, ALICE, 'Alice'));
      const entities = Array.from({ length: N }, (_, i) => ({
        name: `Carrier ${i}`, type: 'person', edges: [{ to: ALICE, label: 'knows' }],
      }));
      let res;
      const seen = await commandsDuring(async () => { res = await bulkMod.bulkWrite(SPACE, { entities }); });
      assert.equal(res.inserted.entities, N, JSON.stringify(res.errors.slice(0, 3)));
      assert.ok(seen.length <= CEILING * 2,
        `${N} entities with an edge each issued ${seen.length} commands (ceiling ${CEILING * 2}): ${summarise(seen)}`);
    });
  });

  // ── PRESERVED: exactly 500 ───────────────────────────────────────────────────────────────────────────────

  it('exactly 500 is a batch, and all 500 are written', async () => {
    // `brain.test.js` asserts inserted + errors === 500, which a batch where every item FAILS also passes.
    const facts = Array.from({ length: 500 }, (_, i) => ({ fact: `five hundred ${i}` }));
    const res = await bulkMod.bulkWrite(SPACE, { facts });
    assert.deepEqual(res.errors, []);
    assert.equal(res.inserted.facts, 500);
    assert.equal(await coll(SPACE, 'facts').countDocuments({}), 500);
  });

  // ── PRESERVED: an item sees the earlier items of its own batch ───────────────────────────────────────────

  describe('N one-item batches in order store and answer what ONE batch of the same N does', () => {
    /*
     * Every case is one where the batch overlay matters: an item that must see an EARLIER item of the same
     * batch. Ids are NOT normalised away — a minted id is replaced by the `$ref` key that named it, after
     * asserting it is not an id the caller supplied, and an edge's `_id` is checked against the identity it
     * must derive from before it is replaced the same way. Only seq, the two timestamps and the space id
     * (the two runs write to two spaces) are dropped.
     */
    const CASES = [
      {
        name: 'a repeated triplet becomes ONE edge, the second an update that merges',
        seed: (s) => [person(s, ALICE, 'Alice'), person(s, BOB, 'Bob')],
        input: { edges: [
          { from: ALICE, to: BOB, label: 'knows', tags: ['a'] },
          { from: ALICE, to: BOB, label: 'knows', tags: ['b'], weight: 0.5 },
        ] },
        expect: (res, stored) => {
          assert.deepEqual(res.errors, []);
          assert.equal(res.inserted.edges, 1);
          assert.equal(res.updated.edges, 1);
          assert.equal(stored.edges.length, 1);
          assert.deepEqual([...stored.edges[0].tags].sort(), ['a', 'b']);
          assert.equal(stored.edges[0].weight, 0.5);
        },
      },
      {
        name: 'a functional label counts an edge written earlier in the same batch',
        seed: (s) => [person(s, ALICE, 'Alice'), person(s, BOB, 'Bob'), person(s, CAROL, 'Carol')],
        input: { edges: [
          { from: ALICE, to: BOB, label: 'reports_to' },
          { from: ALICE, to: CAROL, label: 'reports_to' },
        ] },
        expect: (res, stored) => {
          assert.equal(res.inserted.edges, 1);
          assert.equal(res.errors.length, 1);
          assert.equal(res.errors[0].type, 'edge');
          assert.equal(res.errors[0].index, 1);
          assert.match(res.errors[0].reason, /functional/);
          assert.deepEqual(stored.edges.map(e => e.to), [BOB]);
        },
      },
      {
        name: 'the name+type duplicate warning sees an entity created earlier in the same batch',
        seed: () => [],
        input: { entities: [
          { name: 'Dana', type: 'person', $ref: 'd1' },
          { name: 'Dana', type: 'person', $ref: 'd2' },
        ] },
        expect: (res, stored) => {
          assert.equal(res.inserted.entities, 2);
          assert.equal(res.errors.length, 1);
          assert.equal(res.errors[0].index, 1);
          assert.match(res.errors[0].reason, /1 existing entity with name 'Dana' and type 'person'/);
          assert.equal(stored.entities.length, 2);
        },
      },
      {
        name: 'an edge to an entity created earlier in the same batch obeys its type\'s endpoint rule',
        seed: () => [],
        input: {
          entities: [
            { name: 'Eve', type: 'person', $ref: 'eve' },
            { name: 'Spec', type: 'document', $ref: 'doc' },
          ],
          edges: [
            { from: '$ref:eve', to: '$ref:doc', label: 'reports_to' },
            { from: '$ref:eve', to: '$ref:doc', label: 'authored' },
          ],
        },
        expect: (res, stored) => {
          assert.equal(res.inserted.entities, 2);
          assert.equal(res.inserted.edges, 1);
          assert.equal(res.errors.length, 1);
          assert.equal(res.errors[0].type, 'edge');
          assert.equal(res.errors[0].index, 0);
          assert.match(res.errors[0].reason, /person/, 'the refusal must say which type IS allowed');
          assert.deepEqual(stored.edges.map(e => e.label), ['authored']);
        },
      },
    ];

    for (const c of CASES) {
      it(c.name, async () => {
        for (const s of [SINGLES, BATCHED]) {
          const seed = c.seed(s);
          if (seed.length) await coll(s, 'entities').insertMany(seed);
        }
        const batched = await bulkMod.bulkWrite(BATCHED, c.input);
        const singles = await writeOneAtATime(SINGLES, c.input);

        const supplied = new Set(c.seed(BATCHED).map(e => e._id));
        const bStored = await storedNormalised(BATCHED, batched.refs, supplied);
        const sStored = await storedNormalised(SINGLES, singles.refs, supplied);

        c.expect(batched, bStored);
        assert.deepEqual(
          answerNormalised(singles, singles.refs), answerNormalised(batched, batched.refs),
          'one batch answered differently from the same items written one at a time');
        assert.deepEqual(sStored, bStored, 'one batch stored differently from the same items written one at a time');
      });
    }
  });
});

/** The processing order a batch documents — so the one-at-a-time run writes in the same order. */
const ORDER = ['facts', 'entities', 'chrono', 'edges'];

/**
 * Write each item of `input` as its own one-item batch, in batch order, and add the answers up as one batch
 * would. A `$ref` cannot cross calls, so a use is replaced by the id the earlier call answered with.
 */
async function writeOneAtATime(space, input) {
  const zero = () => ({ facts: 0, entities: 0, edges: 0, chrono: 0 });
  const total = { inserted: zero(), updated: zero(), connections: { links: 0, edges: 0 }, errors: [], refs: {} };
  const sub = (v) => (typeof v === 'string' && v.startsWith('$ref:') ? total.refs[v.slice(5)]?.id ?? v : v);
  for (const kind of ORDER) {
    const items = input[kind] ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = { ...items[i] };
      if (kind === 'edges') { item.from = sub(item.from); item.to = sub(item.to); }
      const r = await bulkMod.bulkWrite(space, { [kind]: [item] });
      for (const k of Object.keys(total.inserted)) {
        total.inserted[k] += r.inserted[k];
        total.updated[k] += r.updated[k];
      }
      total.connections.links += r.connections.links;
      total.connections.edges += r.connections.edges;
      for (const e of r.errors) total.errors.push({ ...e, index: i });
      Object.assign(total.refs, r.refs);
    }
  }
  return total;
}

/** `id -> <key>` for every id a `$ref` key named. */
function idNames(refs) {
  return new Map(Object.entries(refs).map(([k, v]) => [v.id, `<${k}>`]));
}

function renameIds(text, names) {
  let out = text;
  for (const [id, name] of names) out = out.split(id).join(name);
  return out;
}

function answerNormalised(r, refs) {
  const names = idNames(refs);
  return {
    inserted: r.inserted, updated: r.updated, connections: r.connections,
    errors: r.errors.map(e => ({ type: e.type, index: e.index, reason: renameIds(e.reason, names) }))
      .sort((a, b) => `${a.type}${a.index}`.localeCompare(`${b.type}${b.index}`)),
    refs: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v.kind])),
  };
}

const DROPPED = new Set(['seq', 'createdAt', 'updatedAt', 'spaceId']);

/**
 * Every stored entity and edge, with seq, time and the space id dropped, and minted ids replaced by the key
 * that named them — after asserting each minted id is NOT one the caller supplied (ID IS ID) and each edge
 * `_id` IS the identity its endpoints derive.
 */
async function storedNormalised(space, refs, supplied) {
  const names = idNames(refs);
  for (const id of names.keys()) assert.ok(!supplied.has(id), `a minted id equals a supplied one: ${id}`);
  const clean = (doc) => {
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
      if (DROPPED.has(k)) continue;
      out[k] = typeof v === 'string' ? (names.get(v) ?? v) : v;
    }
    return out;
  };
  const entities = (await coll(space, 'entities').find({}).toArray()).map(clean)
    .sort((a, b) => `${a.name}${a._id}`.localeCompare(`${b.name}${b._id}`));
  const rawEdges = await coll(space, 'edges').find({}).toArray();
  for (const e of rawEdges) {
    assert.equal(e._id, edgeId(e.from, e.to, e.label, e.fromKind, e.toKind),
      `edge ${e._id} is not the identity its triplet derives`);
  }
  const edges = rawEdges.map(e => ({ ...clean(e), _id: `edge(${names.get(e.from) ?? e.from},${names.get(e.to) ?? e.to},${e.label})` }))
    .sort((a, b) => a._id.localeCompare(b._id));
  return { entities, edges };
}

function summarise(names) {
  const counts = {};
  for (const n of names) counts[n] = (counts[n] ?? 0) + 1;
  return JSON.stringify(counts);
}

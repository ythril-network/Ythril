/**
 * A window of recall rows walked in step is, row for row, the walk each row makes alone (Q-136).
 *
 * ## The claim
 *
 * `row-graphs.ts` walks a page's rows a window at a time (`walk-in-step.ts`): one edge read and one record read
 * per kind per hop for the whole window, every row keeping its own visited set, paths and alternate routes. The
 * promise is that nothing about any row changes — its graph, the reason it is incomplete, how many nodes it
 * spent of the call's budget, and where a deadline or the call's walk bound ends the answer.
 *
 * ## How it is proved: a differential, on a graph built to hit every rule
 *
 * The per-seed walk stays callable — `traverseFromSeeds` with its default reads, and `rowGraphWalker` without
 * `seeds` — and is the reference. Every seed is walked both ways over a matrix of narrowings, depths 1, 2 and
 * 5, windows 1, 3 and 16, and two row ceilings, and the two must be `deepEqual`: the raw walk (every
 * neighbour, route, edge list and `scanCapped`) AND the row the answer is built from.
 *
 * The graph carries each case the rules exist for: a hub over the row ceiling (`walk_ceiling`), a node whose
 * edges all lead back to where the walk came from (`link_scan` — the capped edge read), a fan that reaches one
 * node by more routes than are recorded (`paths`), cycles, self-loops at a seed and at a reached node, several
 * edges between one pair, same-level edges, edges to fact, chrono and file endpoints, a dangling edge, linked
 * facts (attributed and not), chrono entries and files, a chunk that must not be walked, and non-entity seeds
 * whose own links are the first hop. Records are inserted in a shuffled order, so record order, `_id` order and
 * key order all differ — the tie the edge read's order needs a record id to break is really a tie here.
 *
 * ## And that the reference is still the walk that shipped
 *
 * The per-seed walk now sorts what each read returned into the order the indexes read in (`walk-reads.ts`), so
 * the two agree by construction. That sort must change nothing, and the third walk proves it: the same seeds
 * walked with the reads as they were before Q-136, literally — unsorted queries, written out here.
 *
 * ## And that "by construction" survives a planner that reads in another order
 *
 * On the indexes a space is built with, the stated order IS the planner's, so a window that trusted it past a
 * row's cap would still pass. A second space is built with a different edge index — `{to: 1, from: -1}` in
 * place of `{to: 1}` — so its inbound reads come back in an order the statement does not describe. There the
 * sort DOES change the per-seed answer (asserted, so the case cannot quietly stop meaning anything), and the
 * window must still equal the reference row for row: that is the rule that a row whose share would fill its
 * cap is read alone.
 *
 * Seen red: with `edgeReadOrder` reduced to key order alone (the record-id tie removed), windows differed from
 * the reference on every both-way case (`ent-040 walked in a window of 3 is not its own walk`); with the
 * capped-share fallback in `answerEdges` removed, the other-index space differed on its capped inbound rows;
 * with the shared read's own bound ignored (`whole` forced true), `ent-back` and `ent-fan-dst` differed in
 * windows of 3; with a cached record handed out uncopied, the no-shared-object assertion fired.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-batched-row-walk-is-the-per-seed-walk-db.test.js
 * (requires a prior `npm run build` in server/). Against a developer's own mongod with no users:
 *      YTHRIL_TEST_MONGO_PORT=27017 YTHRIL_TEST_MONGO_CREDS= node --test <this file>
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { recordTraffic } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-row-walk-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'walk';
/** The same graph under a different edge index, so its reads come back in an order `walk-reads.ts` does not state. */
const ALT = 'walkalt';
let mongo, seedWalk, rowsMod, inStep, bounds, frontierMod, projectionMod, frontierLinks, adjacency;

/** A seeded generator, so the graph is the same graph on every run and every machine. */
function prng(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}
const rand = prng(136);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const E = (n) => `ent-${String(n).padStart(3, '0')}`;
const F = (n) => `fact-${String(n).padStart(2, '0')}`;
const C = (n) => `chrono-${String(n).padStart(2, '0')}`;
const FILE = (n) => `docs/file-${n}.md`;

function buildGraph() {
  const entities = [];
  const ent = (id) => entities.push({ _id: id, spaceId: SPACE, name: `name of ${id}`, type: 'thing', tags: [], seq: entities.length + 1 });
  for (let i = 0; i < 60; i++) ent(E(i));
  for (const id of ['hub', 'back', 'fan-src', 'fan-dst', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'loop']) ent(`ent-${id}`);
  for (let i = 0; i < 40; i++) ent(`ent-mid-${String(i).padStart(2, '0')}`);

  const facts = Array.from({ length: 25 }, (_, i) => ({
    _id: F(i), spaceId: SPACE, fact: `fact number ${i}`, type: '', tags: [], properties: { attributed: i % 2 === 0 }, seq: 1000 + i,
  }));
  const chrono = Array.from({ length: 12 }, (_, i) => ({
    _id: C(i), spaceId: SPACE, title: `event ${i}`, type: 'event', tags: [], startsAt: '2026-01-01T00:00:00Z', seq: 2000 + i,
  }));
  const files = [
    ...Array.from({ length: 8 }, (_, i) => ({ _id: FILE(i), spaceId: SPACE, path: FILE(i), tags: [], sizeBytes: 10, description: `file ${i}` })),
    // Chunks: a link naming an entity from one of these must never be walked as if it were its file.
    ...Array.from({ length: 3 }, (_, i) => ({ _id: `${FILE(0)}#chunk-${i}`, spaceId: SPACE, path: `${FILE(0)}#chunk-${i}`, tags: [], sizeBytes: 1, parentFileId: FILE(0) })),
  ];

  const edges = [];
  const keys = new Set();
  let n = 0;
  const edge = (from, to, label, kinds = {}) => {
    const key = `${from}|${to}|${label}|${kinds.fromKind ?? ''}|${kinds.toKind ?? ''}`;
    if (keys.has(key)) return;
    keys.add(key);
    // Ids NOT in insertion order and not in key order, so neither can stand in for the other.
    const id = `edge-${String((n * 7919) % 100003).padStart(6, '0')}-${n}`;
    n++;
    edges.push({ _id: id, spaceId: SPACE, from, to, label, tags: [], seq: n, description: `why ${from} ${label} ${to}`, ...kinds });
  };
  // A hub over the small row ceiling, with inbound edges too.
  for (let i = 0; i < 30; i++) edge('ent-hub', E(i), 'rel');
  for (let i = 30; i < 35; i++) edge(E(i), 'ent-hub', 'rel');
  // A node whose every edge leads back to its parent: the capped edge read with nothing new behind it.
  edge(E(40), 'ent-back', 'rel');
  for (let i = 0; i < 20; i++) edge('ent-back', E(40), `back-${i}`);
  // One node by forty routes: more than MAX_ALT_PATHS_PER_NODE.
  for (let i = 0; i < 40; i++) {
    const mid = `ent-mid-${String(i).padStart(2, '0')}`;
    edge('ent-fan-src', mid, 'a');
    edge(mid, 'ent-fan-dst', 'b');
  }
  // A ring, with chords (same-level edges) and several edges between one pair, both ways.
  for (let i = 0; i < 6; i++) edge(`ent-r${i}`, `ent-r${(i + 1) % 6}`, 'next');
  edge('ent-r0', 'ent-r3', 'chord');
  edge('ent-r1', 'ent-r2', 'a');
  edge('ent-r1', 'ent-r2', 'b');
  edge('ent-r2', 'ent-r1', 'a');
  edge('ent-r1', 'ent-r5', 'a', { fromKind: 'entity', toKind: 'entity' });
  // Self-loops: at a node a seed reaches, and at seeds — an entity and a fact.
  edge('ent-r2', 'ent-r2', 'self');
  edge('ent-loop', 'ent-loop', 'self');
  edge('ent-loop', 'ent-r0', 'rel');
  edge(F(3), F(3), 'self', { fromKind: 'fact', toKind: 'fact' });
  // Non-entity endpoints, declared on the edge.
  edge('ent-r3', F(3), 'about', { toKind: 'fact' });
  edge(C(2), 'ent-r4', 'during', { fromKind: 'chrono' });
  edge('ent-r4', FILE(1), 'documented', { toKind: 'file' });
  edge(F(3), C(5), 'then', { fromKind: 'fact', toKind: 'chrono' });
  // An edge that outlived what it pointed at.
  edge('ent-r5', 'ent-missing', 'rel');
  // Noise: a random graph over the plain entities, with inbound ties on shared targets.
  for (let i = 0; i < 160; i++) edge(E(Math.floor(rand() * 50)), E(Math.floor(rand() * 50)), pick(['a', 'b', 'rel']));

  const links = [];
  const lkeys = new Set();
  const link = (from, fromKind, to, toKind) => {
    const key = `${from}|${fromKind}|${to}|${toKind}`;
    if (lkeys.has(key)) return;
    lkeys.add(key);
    links.push({ _id: `link-${links.length}`, spaceId: SPACE, from, fromKind, to, toKind });
  };
  for (let i = 0; i < 25; i++) {
    for (let k = 0; k < 1 + (i % 3); k++) link(F(i), 'fact', pick([E(Math.floor(rand() * 50)), 'ent-r0', 'ent-hub']), 'entity');
  }
  for (let i = 0; i < 12; i++) {
    link(C(i), 'chrono', E(Math.floor(rand() * 50)), 'entity');
    link(C(i), 'chrono', 'ent-r1', 'entity');
    link(C(i), 'chrono', F(i % 25), 'fact');
  }
  for (let i = 0; i < 8; i++) {
    link(FILE(i), 'file', E(i * 3), 'entity');
    link(FILE(i), 'file', F(i), 'fact');
    link(FILE(i), 'file', C(i % 12), 'chrono');
  }
  for (let i = 0; i < 3; i++) link(`${FILE(0)}#chunk-${i}`, 'file', 'ent-r0', 'entity');
  // A fact that names many entities: its own link scan fills a small ceiling.
  for (let i = 0; i < 20; i++) link(F(24), 'fact', E(i), 'entity');

  return { entities, facts, chrono, files, edges, links };
}

const SEEDS = [
  'ent-hub', 'ent-back', E(40), 'ent-fan-src', 'ent-fan-dst', 'ent-r0', 'ent-r1', 'ent-r2', 'ent-r3', 'ent-r4', 'ent-loop',
  E(0), E(7), E(13), E(21), E(33), E(45), E(49), 'ent-mid-05', 'ent-missing',
  F(3), F(4), F(24), C(2), C(7), FILE(1), FILE(4),
];
const seedsIn = (spaceId) => SEEDS.map(_id => ({ _id, spaceId }));

const NARROWINGS = [
  undefined,
  { direction: 'outbound' },
  { direction: 'inbound' },
  { edgeLabels: ['a', 'rel'] },
  { includeChrono: true, includeMemories: true, includeFiles: true },
  { includeMemories: false },
  { includeChrono: true, includeFiles: true, direction: 'outbound', edgeLabels: ['rel', 'next', 'chrono.entityIds', 'file.entityIds'] },
];
const DEPTHS = [1, 2, 5];
const WINDOWS = [1, 3, 16];
const CEILINGS = [5000, 12];

/**
 * The reads exactly as the walk made them before Q-136: each its own query, no sort. Written out rather than
 * derived, because it is the behaviour being compared AGAINST — a fixture computed from the code under test
 * would assert that the code equals itself.
 */
function readsAsShipped() {
  const never = projectionMod.NEVER_RETURNED_PROJECTION;
  return {
    async edgesTouching(spaceId, frontier, narrowing, limit, timeLeft) {
      const ms = timeLeft();
      let cursor = mongo.col(`${spaceId}_edges`).find(frontierMod.frontierEdgeQuery(spaceId, [...frontier], narrowing))
        .project(never).limit(limit);
      if (ms !== undefined) cursor = cursor.maxTimeMS(ms);
      return await cursor.toArray();
    },
    async recordsById(collection, ids, extra, timeLeft) {
      timeLeft?.();
      return await mongo.col(collection).find({ _id: { $in: [...ids] }, ...(extra ?? {}) }).project(never).toArray();
    },
    linksPointingAt: adjacency.linksPointingAt,
    linksStartingFrom: adjacency.linksStartingFrom,
    /*
     * Written out too, as it shipped: one query, the class scope and the narrowing beside the ids, no sort. This
     * used to be the live `adjacency.docsFromCollection`, which made the reference only as literal as that
     * function's order — and Q-211 moved it onto the one by-id reader, which answers in the caller's id order
     * (the walk sorts what it reads either way). The scope and projection are still the code's own: those are the
     * class definitions, not the read being compared.
     */
    async docsFromCollection(spaceId, collection, ids, projection, extra) {
      if (ids.length === 0) return [];
      const scope = adjacency.LINK_CLASSES.find(c => c.collection === collection)?.scope ?? {};
      return await mongo.col(`${spaceId}_${collection}`)
        .find({ _id: { $in: [...ids] }, ...scope, ...(extra ?? {}) },
          { projection: projection ?? adjacency.projectionForCollection(collection) })
        .toArray();
    },
  };
}

const describeNarrowing = (n) => JSON.stringify(n ?? null);

describe('a window of rows walked in step is each row\'s own walk', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('batchedrowwalk');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'row-walk-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: SPACE, label: 'Walk', builtIn: true, folders: [], completeLinkage: true },
        { id: ALT, label: 'Walk, other index', builtIn: true, folders: [], completeLinkage: true },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    seedWalk = await import('../../server/dist/brain/recall-seed-traversal.js');
    rowsMod = await import('../../server/dist/brain/row-graphs.js');
    inStep = await import('../../server/dist/brain/walk-in-step.js');
    bounds = await import('../../server/dist/brain/search-bounds.js');
    frontierMod = await import('../../server/dist/brain/frontier-query.js');
    projectionMod = await import('../../server/dist/brain/read-projection.js');
    frontierLinks = await import('../../server/dist/brain/link-frontier.js');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');

    // The indexes the walk reads through, as `initSpace` builds them — the ORDER a read returns is theirs.
    const db = mongo.getDb();
    for (const [space, to] of [[SPACE, { to: 1 }], [ALT, { to: 1, from: -1 }]]) {
      await db.collection(`${space}_edges`).createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
      await db.collection(`${space}_edges`).createIndex(to);
      for (const ix of adjacency.LINK_INDEXES) await db.collection(`${space}_links`).createIndex(ix.keys, ix.unique ? { unique: true } : {});
    }

    const g = buildGraph();
    for (const space of [SPACE, ALT]) {
      for (const [name, docs] of Object.entries({ entities: g.entities, facts: g.facts, chrono: g.chrono, files: g.files, edges: g.edges, links: g.links })) {
        await mongo.col(`${space}_${name}`).insertMany(shuffle(docs.map(d => ({ ...d, spaceId: space }))));
      }
    }
  });

  afterEach(() => bounds?.overrideWalkBoundsForTest(null));

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the modules are the ones this gate thinks they are', () => {
    assert.equal(typeof seedWalk.traverseFromSeeds, 'function');
    assert.equal(typeof inStep.walkInStep, 'function');
    assert.equal(typeof rowsMod.rowGraphWalker, 'function');
    assert.equal(typeof frontierLinks.STORED_LINK_READS.linksPointingAt, 'function');
  });

  /** Every raw walk, both ways, and every reason the reference gave — the floor under the matrix. */
  const seen = { walks: 0, windows: 0, reasons: new Map(), altReordered: 0 };

  /**
   * Walk every seed of `space` alone (the reference), with the reads as shipped, and in every window. In the
   * production-indexed space the shipped walk must BE the reference; in the other one it is counted where it
   * is not, and only the window is held to the reference.
   */
  async function differential(space, rowNodes, narrowing, depth) {
    const seeds = seedsIn(space);
    const limit = rowNodes + 1;
    const reference = [];
    for (const s of seeds) reference.push(await seedWalk.traverseFromSeeds(space, [s._id], depth, limit, narrowing));

    const asShipped = readsAsShipped();
    for (const [i, s] of seeds.entries()) {
      const shipped = await seedWalk.traverseFromSeeds(space, [s._id], depth, limit, narrowing, undefined, asShipped);
      if (space === ALT) { if (!isDeepStrictEqual(reference[i], shipped)) seen.altReordered++; continue; }
      assert.deepEqual(reference[i], shipped,
        `${s._id}: the per-seed walk is no longer the walk that shipped — the read-order sort changed an answer`);
    }

    for (const w of WINDOWS) {
      const cache = inStep.newRecordCache();
      for (let from = 0; from < seeds.length; from += w) {
        const window = seeds.slice(from, from + w);
        const walked = await Promise.all(inStep.walkInStep(
          window.map(s => (reads) => seedWalk.traverseFromSeeds(space, [s._id], depth, limit, narrowing, undefined, reads)),
          cache));
        walked.forEach((got, k) => {
          assert.deepEqual(got, reference[from + k], `${space}/${window[k]._id} walked in a window of ${w} is not its own walk`);
          seen.windows++;
        });
        // And no two rows hold the same document OBJECT, as two rows walked alone never do: one row's answer
        // must not be reachable from another's.
        const owner = new Map();
        walked.forEach((got, k) => {
          for (const n of got.neighbours) {
            for (const doc of [n.record, ...n.edges]) {
              const other = owner.get(doc);
              assert.ok(other === undefined || other === k,
                `${space}/${window[k]._id} and ${window[other]?._id} hold one document object between them`);
              owner.set(doc, k);
            }
          }
        });
      }
    }

    for (const walk of reference) {
      seen.walks++;
      const why = rowsMod.whyRowIsShort(walk, rowNodes) ?? (walk.neighbours.length > 0 ? 'whole' : 'empty');
      seen.reasons.set(why, (seen.reasons.get(why) ?? 0) + 1);
    }
  }

  for (const rowNodes of CEILINGS) {
    for (const narrowing of NARROWINGS) {
      for (const depth of DEPTHS) {
        it(`ceiling ${rowNodes}, depth ${depth}, narrowing ${describeNarrowing(narrowing)}: every row, every window`,
          () => differential(SPACE, rowNodes, narrowing, depth));
      }
    }
    for (const narrowing of [undefined, { direction: 'inbound' }]) {
      for (const depth of DEPTHS) {
        it(`other edge index — ceiling ${rowNodes}, depth ${depth}, narrowing ${describeNarrowing(narrowing)}`,
          () => differential(ALT, rowNodes, narrowing, depth));
      }
    }
  }

  it('the other-index space really reads in another order', () => {
    // Otherwise its cases pass for the easy reason: the planner agreeing with `edgeReadOrder` by luck.
    assert.ok(seen.altReordered > 0,
      'every walk in the other-index space matched the unsorted walk, so it tests nothing the first space does not');
  });

  it('the matrix reached every rule it is about', () => {
    // A differential over a graph that never capped would prove the easy half only. Every reason a row can be
    // short must have come up in the reference, and whole rows too.
    for (const why of ['walk_ceiling', 'link_scan', 'paths', 'whole', 'empty']) {
      assert.ok((seen.reasons.get(why) ?? 0) > 0, `no reference row was ${why} — the graph no longer exercises it`);
    }
    assert.equal(seen.windows, seen.walks * WINDOWS.length, 'a window walk was skipped');
    assert.ok(seen.walks >= SEEDS.length * (NARROWINGS.length + 2) * DEPTHS.length * CEILINGS.length);
  });

  /** Every row the answer builder would receive, until the walker stops the answer. */
  async function rowsOf(walk) {
    const out = [];
    for (const [i, s] of seedsIn(SPACE).entries()) {
      const g = await walk(s, i === 0);
      out.push(g);
      if ('stop' in g) break;
    }
    return out;
  }

  for (const callNodes of [undefined, 40, 150]) {
    for (const rowNodes of CEILINGS) {
      it(`rows as the answer sees them: ceiling ${rowNodes}, call budget ${callNodes ?? 'default'}`, async () => {
        bounds.overrideWalkBoundsForTest({ rowNodes, ...(callNodes !== undefined ? { callNodes } : {}) });
        for (const narrowing of [NARROWINGS[0], NARROWINGS[4], NARROWINGS[6]]) {
          for (const depth of DEPTHS) {
            const opts = { memberIds: [SPACE], maxDepth: depth, narrowing, deadline: () => 60_000 };
            const reference = await rowsOf(rowsMod.rowGraphWalker(opts));
            for (const window of WINDOWS) {
              const batched = await rowsOf(rowsMod.rowGraphWalker({ ...opts, seeds: seedsIn(SPACE), window }));
              assert.deepEqual(batched, reference,
                `depth ${depth}, window ${window}, ${describeNarrowing(narrowing)}: the answer's rows differ`);
            }
            if (callNodes === 40) {
              assert.ok(reference.some(r => r.stop === 'walk_budget'), 'the call budget never stopped the answer');
            }
          }
        }
      });
    }
  }

  it('a spent deadline: the first row is named, the answer stops at the next — both ways', async () => {
    const opts = { memberIds: [SPACE], maxDepth: 2, deadline: () => 0 };
    const reference = await rowsOf(rowsMod.rowGraphWalker(opts));
    assert.deepEqual(reference, [{ incomplete: 'deadline' }, { stop: 'deadline' }]);
    for (const window of WINDOWS) {
      assert.deepEqual(await rowsOf(rowsMod.rowGraphWalker({ ...opts, seeds: seedsIn(SPACE), window })), reference);
    }
  });

  it('the window shares its reads: one edge query per hop, where each row made its own', async () => {
    // The point of the change, observed through Mongo's own traffic rather than an internal counter. No row
    // here fills its ceiling, so no read falls back to its own query.
    const depth = 2;
    const opts = { memberIds: [SPACE], maxDepth: depth, deadline: () => 60_000 };
    const edgeFinds = (ops) => ops.filter(o => o.op === 'query').length;
    const alone = await recordTraffic(mongo, `${SPACE}_edges`, () => rowsOf(rowsMod.rowGraphWalker(opts)));
    const together = await recordTraffic(mongo, `${SPACE}_edges`,
      () => rowsOf(rowsMod.rowGraphWalker({ ...opts, seeds: seedsIn(SPACE), window: 16 })));
    assert.deepEqual(together.result, alone.result);
    const windows = Math.ceil(SEEDS.length / 16);
    assert.ok(edgeFinds(alone.ops) >= SEEDS.length, `the per-seed walk made ${edgeFinds(alone.ops)} edge reads`);
    assert.ok(edgeFinds(together.ops) <= windows * depth,
      `${edgeFinds(together.ops)} edge reads for ${windows} windows at depth ${depth} — the window is not sharing them`);
  });
});

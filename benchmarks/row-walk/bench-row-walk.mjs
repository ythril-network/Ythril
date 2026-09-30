#!/usr/bin/env node
/**
 * Q-136 — what walking a page's rows in step saves, measured against walking each row alone.
 *
 * ## What it measures
 *
 * One recall page's graph expansion: `rowGraphWalker` asked for every row in order, exactly as
 * `traversedAnswer` asks, at depth 1, 2 and 5. Two arms on the SAME corpus in the same process:
 *
 * - **per-seed** — the walker without `seeds`, so each row is walked alone. The walk as it ran before Q-136.
 * - **in step** — the walker handed the page's rows, so a window of them is walked together (`walk-in-step.ts`).
 *
 * For each: the queries the database received (`find` commands, and `getMore` round trips), counted by the
 * database's own profiler on the benchmark database, and the wall time of the whole page — the MINIMUM of
 * `BENCH_REPEATS` runs, the least noisy statistic for a warm cache. The two arms must return the same rows, or
 * the run refuses to report: a faster wrong answer is not a result.
 *
 * ## The corpus
 *
 * Deterministic (every id from a counter, every choice from a seeded generator): 3 000 entities, 4 500 edges
 * between them, 2 000 facts naming two entities each (half attributed, so the default narrowing reads them),
 * and 20 seed rows. Sized so a depth-5 row stays under the row ceiling for most seeds — a corpus where every row
 * hits the ceiling would measure the ceiling.
 *
 * ## Running it
 *
 *   npm run build -w server
 *   node benchmarks/row-walk/bench-row-walk.mjs
 *
 * `BENCH_MONGO_URI` names the server (default a local mongod on 27017 with no auth). The run creates its own
 * database, `ythril_bench_rowwalk_<pid>`, and drops it at the end; it never reads or writes any other.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';

const REPEATS = Number(process.env['BENCH_REPEATS'] ?? 15);
const SERVER = process.env['BENCH_MONGO_URI'] ?? 'mongodb://127.0.0.1:27017/?directConnection=true';
const DB = `ythril_bench_rowwalk_${process.pid}`;
const SPACE = 'bench';

const N_ENTITIES = 3000;
const N_EDGES = 4500;
const N_FACTS = 2000;
const N_SEEDS = 20;
const DEPTHS = [1, 2, 5];

const uri = new URL(SERVER);
uri.pathname = `/${DB}`;
process.env['MONGO_URI'] = uri.toString();

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ythril-bench-rowwalk-'));
process.env['CONFIG_PATH'] = path.join(tmp, 'config.json');
writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: 'bench', instanceLabel: 'bench', tokens: [], networks: [],
  spaces: [{ id: SPACE, label: 'Bench', builtIn: true, folders: [], completeLinkage: true }],
}, null, 2), { mode: 0o600 });

const dist = (p) => pathToFileURL(path.join(process.cwd(), 'server', 'dist', p)).href;
const { loadConfig } = await import(dist('config/loader.js'));
const { connectMongo, closeMongo, getDb, col } = await import(dist('db/mongo.js'));
const { rowGraphWalker } = await import(dist('brain/row-graphs.js'));
const { LINK_INDEXES } = await import(dist('brain/link-adjacency.js'));

loadConfig();
await connectMongo();
const db = getDb();

function prng(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
}
const rand = prng(136);
const ENT = (i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`;
const FACT = (i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function seed() {
  await db.dropDatabase();
  // The indexes the walk reads through, as `initSpace` builds them.
  await col(`${SPACE}_edges`).createIndex({ from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 }, { unique: true });
  await col(`${SPACE}_edges`).createIndex({ to: 1 });
  for (const ix of LINK_INDEXES) await col(`${SPACE}_links`).createIndex(ix.keys, ix.unique ? { unique: true } : {});

  await col(`${SPACE}_entities`).insertMany(Array.from({ length: N_ENTITIES }, (_, i) => ({
    _id: ENT(i), spaceId: SPACE, name: `entity ${i}`, type: 'thing', tags: [], seq: i + 1,
  })));
  const edges = new Map();
  while (edges.size < N_EDGES) {
    const from = Math.floor(rand() * N_ENTITIES);
    // Mostly local, so the graph has neighbourhoods rather than being one uniform expander.
    const to = rand() < 0.8 ? (from + 1 + Math.floor(rand() * 20)) % N_ENTITIES : Math.floor(rand() * N_ENTITIES);
    const label = ['depends_on', 'part_of', 'related_to'][Math.floor(rand() * 3)];
    const key = `${from}|${to}|${label}`;
    if (from === to || edges.has(key)) continue;
    edges.set(key, { _id: `edge-${edges.size}`, spaceId: SPACE, from: ENT(from), to: ENT(to), label, tags: [], seq: edges.size + 1 });
  }
  await col(`${SPACE}_edges`).insertMany([...edges.values()]);
  await col(`${SPACE}_facts`).insertMany(Array.from({ length: N_FACTS }, (_, i) => ({
    _id: FACT(i), spaceId: SPACE, fact: `fact ${i}`, type: '', tags: [], properties: { attributed: i % 2 === 0 }, seq: i + 1,
  })));
  const links = [];
  for (let i = 0; i < N_FACTS; i++) {
    const a = Math.floor(rand() * N_ENTITIES);
    for (const e of new Set([a, (a + 1 + Math.floor(rand() * 5)) % N_ENTITIES])) {
      links.push({ _id: `link-${links.length}`, spaceId: SPACE, from: FACT(i), fromKind: 'fact', to: ENT(e), toKind: 'entity' });
    }
  }
  await col(`${SPACE}_links`).insertMany(links);
}

const SEEDS = Array.from({ length: N_SEEDS }, (_, i) => ({ _id: ENT((i * 149) % N_ENTITIES), spaceId: SPACE }));

/** One page: every row asked for in order, as `budgetedRowsEnvelope` asks, until the walker stops the answer. */
async function page(depth, inStep) {
  const walk = rowGraphWalker({
    memberIds: [SPACE], maxDepth: depth, deadline: () => 60_000, ...(inStep ? { seeds: SEEDS } : {}),
  });
  const rows = [];
  for (const [i, s] of SEEDS.entries()) {
    const g = await walk(s, i === 0);
    rows.push(g);
    if ('stop' in g) break;
  }
  return rows;
}

/** The commands `fn` sent to the benchmark database, by the database's own count. */
async function traffic(fn) {
  await db.command({ profile: 0 });
  await db.collection('system.profile').drop().catch(() => {});
  await db.createCollection('system.profile', { capped: true, size: 64 * 1024 * 1024 });
  await db.command({ profile: 2 });
  let result;
  try { result = await fn(); } finally { await db.command({ profile: 0 }); }
  const ops = await db.collection('system.profile').find({ ns: { $regex: `^${DB}\\.${SPACE}_` } }).toArray();
  return { result, finds: ops.filter(o => o.op === 'query').length, getMores: ops.filter(o => o.op === 'getmore').length };
}

async function fastest(fn) {
  let best = Infinity;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return Math.round(best * 100) / 100;
}

const describeRows = (rows) => {
  const whole = rows.filter(r => 'nodes' in r);
  return {
    rows: rows.length,
    whole: whole.length,
    incomplete: rows.filter(r => 'incomplete' in r).length,
    stopped: rows.some(r => 'stop' in r),
  };
};

try {
  await seed();
  const results = [];
  for (const depth of DEPTHS) {
    const alone = await traffic(() => page(depth, false));
    const together = await traffic(() => page(depth, true));
    if (!isDeepStrictEqual(alone.result, together.result)) {
      console.error(`REFUSING to report: depth ${depth} returned different rows in step than alone`);
      process.exitCode = 3;
      break;
    }
    // Warm both before timing either, so neither pays for the other's cache misses.
    await page(depth, false);
    await page(depth, true);
    results.push({
      depth,
      page: describeRows(alone.result),
      perSeed: { finds: alone.finds, getMores: alone.getMores, ms: await fastest(() => page(depth, false)) },
      inStep: { finds: together.finds, getMores: together.getMores, ms: await fastest(() => page(depth, true)) },
    });
  }
  const server = await db.admin().command({ buildInfo: 1 });
  console.log(JSON.stringify({
    mongo: server.version, repeats: REPEATS,
    corpus: { entities: N_ENTITIES, edges: N_EDGES, facts: N_FACTS, seeds: N_SEEDS },
    results,
  }, null, 2));
} finally {
  await db.dropDatabase().catch(() => {});
  await closeMongo();
  rmSync(tmp, { recursive: true, force: true });
}

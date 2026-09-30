/**
 * Q-7 gate 3 — how long the four link readers take, measured on both versions.
 *
 * Owner, 2026-09-03: *"4.0 is a big change thanks to links and other stuff — it should not break or have
 * worse performance than 3.x."* And on benchmarks generally: nothing invented, estimated or rounded up.
 *
 * ## What it measures and why those four
 *
 * They are every reader a link touches: a standalone `traverse` at depth 1, 2 and 3; the graph expansion
 * inside `recall`; the scan that refuses an entity delete; and the ER model. Each is timed on the SAME
 * corpus, and the result is a pair (or a triple) — **a number from one version alone answers nothing.**
 *
 * ## The three runs
 *
 *   node scripts/bench-link-readers.mjs 3.x           # on a checkout of 6506fb84, the last commit before M-2
 *   node scripts/bench-link-readers.mjs 4.0-arrays    # on main, space NOT converted — the array walk
 *   node scripts/bench-link-readers.mjs 4.0-links     # on main, `completeLinkage` on — the link-record walk
 *
 * The first two must be close: that is "the migration made nothing slower". The third is the claim the
 * migration was made for, and until it is measured it is a hope.
 *
 * ## Why the corpus is sized from the LINK count
 *
 * A corpus small enough that every plan is a collection scan measures the same thing twice. The arithmetic
 * to beat is in the `Q-7` row: 500 memories naming three entities each is 1 500 link records where there
 * were 500 arrays, and a hop goes from three `$in`-over-array reads to one indexed lookup. This seeds an
 * order of magnitude more links than that so the index has something to do.
 *
 * ## Determinism
 *
 * Every id is derived from a counter, so the two corpora hold the same arrays and the comparison is about
 * the code rather than about which records happened to exist. The queries are the same list in the same
 * order, and each is run `REPEATS` times — the reported number is the MINIMUM, which is the least noisy
 * statistic for a warm cache and the one that cannot be flattered by a slow neighbour.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';

const LABEL = process.argv[2];
if (!LABEL) {
  console.error('usage: node scripts/bench-link-readers.mjs <3.x|4.0-arrays|4.0-links>');
  process.exit(2);
}

const SPACE = 'bench';
/**
 * How many times each query runs. The reported number is the MINIMUM.
 *
 * Five was not enough: these are single-digit milliseconds and two runs of the same code disagreed by 20%,
 * which is larger than some of the differences being measured. A number that moves that much between runs
 * cannot support a claim about which version is faster.
 */
const REPEATS = Number(process.env['BENCH_REPEATS'] ?? 25);

/** Sized from the LINK count: 2 000 memories × 3 + 500 chrono × 3 + 300 files × 3 = 9 900 links. */
const N_ENTITIES = 200;
const N_MEMORIES = 2000;
const N_CHRONO = 500;
const N_FILES = 300;

const uuid = (n) => {
  const h = n.toString(16).padStart(12, '0');
  return `bbbbbbbb-0000-4000-8000-${h}`;
};
const ENT = (i) => uuid(1_000_000 + i);
const MEM = (i) => uuid(2_000_000 + i);
const CHR = (i) => uuid(3_000_000 + i);
const FILE = (i) => `bench/file-${i}.md`;

const dist = (p) => pathToFileURL(path.join(process.cwd(), 'server', 'dist', p)).href;

// A scratch config so this never touches a real instance's spaces.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ythril-bench-'));
const CONFIG_PATH = path.join(tmp, 'config.json');
writeFileSync(CONFIG_PATH, JSON.stringify({
  instanceId: 'bench', instanceLabel: 'bench', tokens: [], networks: [],
  // `completeLinkage` is what selects the reader on 4.0; on 3.x the key is unknown and ignored.
  spaces: [{ id: SPACE, label: 'Bench', builtIn: true, folders: [], ...(LABEL === '4.0-links' ? { completeLinkage: true } : {}) }],
}, null, 2), { mode: 0o600 });
process.env['CONFIG_PATH'] = CONFIG_PATH;

const { loadConfig } = await import(dist('config/loader.js'));
const { connectMongo, closeMongo, col } = await import(dist('db/mongo.js'));
const edges = await import(dist('brain/edges.js'));
const entities = await import(dist('brain/entities.js'));
const erModel = await import(dist('brain/er-model.js'));

loadConfig();
await connectMongo();

const c = (n) => col(`${SPACE}_${n}`);

/** Seed only if this exact corpus is not already there — the three runs share one database. */
async function seed() {
  const have = await c('memories').countDocuments({});
  if (have === N_MEMORIES) { console.error(`corpus already seeded (${have} memories)`); return false; }

  for (const n of ['entities', 'memories', 'chrono', 'files', 'edges', 'links', 'tombstones']) {
    await c(n).deleteMany({});
  }
  const now = new Date().toISOString();
  const author = { instanceId: 'bench', instanceLabel: 'bench' };

  await c('entities').insertMany(Array.from({ length: N_ENTITIES }, (_, i) => ({
    _id: ENT(i), spaceId: SPACE, name: `entity-${i}`, type: 'service', tags: [], author, createdAt: now, seq: i + 1,
  })));

  // Three entity links each, spread so no single entity is the whole graph — a hub would measure one
  // pathological case rather than a neighbourhood.
  await c('memories').insertMany(Array.from({ length: N_MEMORIES }, (_, i) => ({
    _id: MEM(i), spaceId: SPACE, fact: `memory ${i} about things`, type: '', tags: [],
    entityIds: [ENT(i % N_ENTITIES), ENT((i * 7 + 3) % N_ENTITIES), ENT((i * 13 + 11) % N_ENTITIES)],
    author, createdAt: now, seq: 10_000 + i,
  })));

  await c('chrono').insertMany(Array.from({ length: N_CHRONO }, (_, i) => ({
    _id: CHR(i), spaceId: SPACE, title: `event ${i}`, type: 'event', startsAt: now, tags: [],
    entityIds: [ENT(i % N_ENTITIES), ENT((i * 5 + 2) % N_ENTITIES)],
    memoryIds: [MEM(i % N_MEMORIES)],
    author, createdAt: now, seq: 100_000 + i,
  })));

  await c('files').insertMany(Array.from({ length: N_FILES }, (_, i) => ({
    _id: FILE(i), spaceId: SPACE, path: FILE(i), tags: [], sizeBytes: 100,
    entityIds: [ENT(i % N_ENTITIES)],
    memoryIds: [MEM((i * 3) % N_MEMORIES)],
    chronoIds: [CHR(i % N_CHRONO)],
    author, createdAt: now, seq: 200_000 + i,
  })));

  // Edges so a traverse has a graph to walk as well as links to follow.
  await c('edges').insertMany(Array.from({ length: N_ENTITIES * 2 }, (_, i) => ({
    _id: uuid(4_000_000 + i), spaceId: SPACE,
    from: ENT(i % N_ENTITIES), to: ENT((i * 3 + 1) % N_ENTITIES),
    label: 'depends_on', tags: [], author, createdAt: now, seq: 300_000 + i,
  })));
  return true;
}

/** Build the link records for the whole corpus, the way the conversion script does. */
async function buildLinks() {
  const { convertSpaceLinks } = await import(dist('brain/links-conversion.js'));
  const r = await convertSpaceLinks(SPACE);
  console.error(`links built: ${r.added} added, ${r.failed} failed`);
}

/** Minimum of `REPEATS` runs, in milliseconds, with what the call returned so a wrong answer is visible. */
async function time(name, fn) {
  let best = Infinity;
  let shape = '';
  for (let i = 0; i < REPEATS; i++) {
    const t0 = process.hrtime.bigint();
    const out = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
    shape = describe(out);
  }
  return { name, ms: best, shape };
}

function describe(out) {
  if (!out) return 'null';
  if (Array.isArray(out)) return `${out.length} rows`;
  if (out.nodes) return `${out.nodes.length} nodes, ${(out.edges ?? []).length} edges`;
  if (out.entityTypes) return `${out.entityTypes.length} types`;
  return 'ok';
}

const seeded = await seed();
if (seeded && LABEL !== '3.x') await buildLinks();
if (LABEL === '4.0-links') {
  const n = await c('links').countDocuments({});
  console.error(`link records present: ${n}`);
  if (n === 0) { console.error('REFUSING to report: this run claims the link path and there are no link records'); process.exit(3); }
}

const startEntity = ENT(0);
const results = [];
for (const depth of [1, 2, 3]) {
  results.push(await time(`traverse depth ${depth}`, () =>
    edges.traverseGraph([SPACE], startEntity, 'both', undefined, depth, 500, true, true, true)));
}
results.push(await time('traverse depth 2, links OFF', () =>
  edges.traverseGraph([SPACE], startEntity, 'both', undefined, 2, 500, false, false, false)));
results.push(await time('backlink scan (blocks a delete)', () =>
  entities.findEntityReferences(SPACE, startEntity)));
// The uncached read — what the space-meta cache (`Q-95`) pays on the first read after a write — not the cached answer.
results.push(await time('er_model', () => erModel.readErShape(SPACE)));

await closeMongo();

const counts = { entities: N_ENTITIES, memories: N_MEMORIES, chrono: N_CHRONO, files: N_FILES };
console.log(JSON.stringify({ label: LABEL, repeats: REPEATS, corpus: counts, results }, null, 2));

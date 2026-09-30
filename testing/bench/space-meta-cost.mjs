/**
 * What a space-meta read costs on a large space — the measurement `Q-95` is priced on.
 *
 * ## Why this exists
 *
 * A routine `GET /api/spaces/:id/meta` or MCP `space_meta` built `actualSchema` from scratch on every call:
 * an entity scan and an edge scan (each capped at 200 000), three link-class scans, two counts, and five more
 * counts for `stats` — per member space. The schema editor reads the meta on every edit, and an agent is told
 * to read it before writing to an unfamiliar space, so the cost is paid by somebody waiting.
 *
 * This seeds one space with 100 000 records (70 000 entities over 20 types, 20 000 edges, 10 000 facts each
 * linking two entities) and times the `space_meta` tool's handler — the MCP door, which since `Q-95` is the
 * same function as the REST route — cold, warm, and after one write.
 *
 * Run it against the unchanged code and against the change, and compare. It needs a Mongo:
 *
 *   YTHRIL_TEST_MONGO_PORT=27998 YTHRIL_TEST_MONGO_CREDS= node testing/bench/space-meta-cost.mjs
 *
 * (requires a prior `npm run build` in server/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo } from '../standalone/_mongo-harness.mjs';

const SPACE = 'metabench';
const ENTITIES = 70_000;
const EDGES = 20_000;
const FACTS = 10_000;
const TYPES = 20;
const READS = 5;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-meta-bench-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: 'meta-bench', instanceLabel: 'bench', tokens: [], networks: [],
  spaces: [{ id: SPACE, label: 'Meta bench', builtIn: true, folders: [], completeLinkage: true }],
}, null, 2), { mode: 0o600 });
(await import('../../server/dist/config/loader.js')).loadConfig();

const mongo = await openTestMongo('metabench');
const { LINK_INDEXES } = await import('../../server/dist/brain/link-adjacency.js');
// Loaded BEFORE any collection handle is taken, as the server's routers are at boot: a record-write listener
// observes the collections it asks for from the moment it subscribes, so a handle taken earlier would write
// past it — and a bench that did that would measure a cache that never hears the write.
const { space_metaTool } = await import('../../server/dist/mcp/tools/spaces.js');
const ents = mongo.col(`${SPACE}_entities`);
const edges = mongo.col(`${SPACE}_edges`);
const facts = mongo.col(`${SPACE}_facts`);
const links = mongo.col(`${SPACE}_links`);
await ents.createIndex({ name: 1, type: 1 });
await edges.createIndex({ from: 1, to: 1, label: 1 }, { unique: true });
for (const ix of LINK_INDEXES) await links.createIndex(ix.keys, ix.unique ? { unique: true } : {});

const t0 = Date.now();
const batch = async (coll, n, make) => {
  for (let i = 0; i < n; i += 5_000) {
    await coll.insertMany(Array.from({ length: Math.min(5_000, n - i) }, (_, j) => make(i + j)), { ordered: false });
  }
};
await batch(ents, ENTITIES, i => ({ _id: `e${i}`, spaceId: SPACE, name: `entity ${i}`, type: `type${i % TYPES}`, seq: i }));
await batch(edges, EDGES, i => ({ _id: `g${i}`, spaceId: SPACE, from: `e${i}`, to: `e${(i * 7 + 1) % ENTITIES}`, label: `rel${i % 5}`, seq: i }));
await batch(facts, FACTS, i => ({ _id: `f${i}`, spaceId: SPACE, fact: `fact ${i}`, seq: i }));
await batch(links, FACTS * 2, i => ({
  _id: `l${i}`, spaceId: SPACE, from: `f${i >> 1}`, fromKind: 'fact', to: `e${(i * 13) % ENTITIES}`, toKind: 'entity', seq: i,
}));
console.log(`seeded ${ENTITIES + EDGES + FACTS} records (+${FACTS * 2} link rows) in ${Date.now() - t0} ms`);

const ctx = { callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], args: { space: SPACE } };
const read = async () => {
  const s = performance.now();
  const r = await space_metaTool.handle(ctx);
  const ms = performance.now() - s;
  const a = r.structuredContent?.actualSchema;
  if (!a || a.totals?.entities !== undefined && a.totals.entities < ENTITIES) throw new Error('meta read did not see the seed');
  return ms;
};
const stats = xs => {
  const sorted = [...xs].sort((a, b) => a - b);
  return `median ${sorted[sorted.length >> 1].toFixed(0)} ms (min ${sorted[0].toFixed(0)}, max ${sorted.at(-1).toFixed(0)})`;
};

const first = await read();
const next = [];
for (let i = 0; i < READS; i++) next.push(await read());
await ents.insertOne({ _id: 'e-late', spaceId: SPACE, name: 'late', type: 'type0', seq: ENTITIES + 1 });
const afterWrite = await read();
const afterWriteWarm = await read();

console.log(`first read:                ${first.toFixed(0)} ms`);
console.log(`next ${READS} reads (no writes): ${stats(next)}`);
console.log(`read after one write:      ${afterWrite.toFixed(0)} ms`);
console.log(`the read after that:       ${afterWriteWarm.toFixed(0)} ms`);

await closeTestMongo();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }

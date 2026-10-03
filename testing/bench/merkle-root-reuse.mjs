/**
 * What a `computeMerkleRoot` costs on a space that did not change since the last one — the measurement behind the
 * leaf cache (`Q-107` part 4).
 *
 * The root is computed on every sync cycle for every `merkle: true` space and on every peer's `GET /api/sync/merkle`.
 * Before the cache it streamed every document of all six record collections each time; with it, a call whose
 * collections were not written and whose files did not change returns the stored root, and a call after a write
 * re-reads only the collection that was written. The file manifest still stats every file on every call — its own
 * hash cache spares the bytes, not the walk.
 *
 * Prints one JSON line: the records seeded, then the first call (cold), a second with nothing changed, and one
 * after a single fact was written — each in milliseconds.
 *
 *   node testing/bench/merkle-root-reuse.mjs            # 20 000 facts + 20 000 entities
 *   node testing/bench/merkle-root-reuse.mjs 100000     # records per collection
 *
 * (requires a prior `npm run build` in server/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo } from '../standalone/_mongo-harness.mjs';

const N = Number(process.argv[2] ?? 20_000);
const SPACE = 'merklebench';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merkle-bench-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: 'merkle-bench', instanceLabel: 'bench', tokens: [], networks: [],
  spaces: [{ id: SPACE, label: 'Merkle bench', folders: [], meta: {} }],
}, null, 2), { mode: 0o600 });

const mongo = await openTestMongo('merklebench');
try {
  (await import('../../server/dist/config/loader.js')).loadConfig();
  const { computeMerkleRoot } = await import('../../server/dist/brain/merkle.js');
  const T0 = '2026-09-01T00:00:00.000Z';
  for (const [coll, make] of [
    ['facts', (i) => ({ _id: `f-${i}`, spaceId: SPACE, fact: `fact number ${i}`, tags: ['t'], createdAt: T0, updatedAt: T0, seq: i + 1 })],
    ['entities', (i) => ({ _id: `e-${i}`, spaceId: SPACE, name: `Entity ${i}`, type: 'thing', tags: [], properties: {}, createdAt: T0, updatedAt: T0, seq: N + i + 1 })],
  ]) {
    for (let i = 0; i < N; i += 5_000) {
      await mongo.col(`${SPACE}_${coll}`).insertMany(Array.from({ length: Math.min(5_000, N - i) }, (_, k) => make(i + k)), { ordered: false });
    }
  }
  const time = async (fn) => { const t = performance.now(); const r = await fn(); return { ms: Math.round(performance.now() - t), r }; };
  const cold = await time(() => computeMerkleRoot(SPACE));
  const warm = await time(() => computeMerkleRoot(SPACE));
  await mongo.col(`${SPACE}_facts`).updateOne({ _id: 'f-0' }, { $set: { fact: 'changed', seq: 2 * N + 1 } });
  const afterWrite = await time(() => computeMerkleRoot(SPACE));
  console.log(JSON.stringify({
    bench: 'merkle-root-reuse', recordsPerCollection: N, coldMs: cold.ms, unchangedMs: warm.ms, afterOneWriteMs: afterWrite.ms,
    sameRootWhenUnchanged: cold.r.root === warm.r.root, rootMovedAfterWrite: afterWrite.r.root !== warm.r.root,
  }));
} finally {
  await closeTestMongo();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

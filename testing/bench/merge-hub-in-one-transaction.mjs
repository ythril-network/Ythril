/**
 * What a `graph_merge` of a HUB costs — the measurement `MERGE_MAX_RELINKS` is set from (`Q-107` part 3a).
 *
 * ## Why this exists
 *
 * A merge relinks every edge, link and face label of the absorbed entity inside ONE transaction, holding the sync
 * horizon for its whole length. The plan bounds the number of relinks a merge may do and refuses a larger one before
 * any write; the bound's value is not a guess, it is set here: the merge WITH every edge's vector carried (a re-key
 * re-inserts the stored document, vector included, so a measurement without vectors prices a transaction no real hub
 * has), at the smallest Mongo memory the compose and k8s defaults allow, and the bound sits at no more than half the
 * size that still completed and no more than half the hold deadline.
 *
 * It seeds one hub per size (`_merge-hub.mjs`, the fixture the door test sizes against the bound too, so the two
 * cannot count a relink differently), runs `executeMerge` — the function every merge door calls — and prints one JSON
 * line per size: the relinks, the wall time, whether it committed, and whether every record reached the survivor.
 *
 * Run it against the unchanged code and against the change, and compare. It needs a Mongo; to price the memory
 * ceiling, run it against one limited the way the deployment defaults limit it:
 *
 *   node testing/bench/merge-hub-in-one-transaction.mjs                 # sizes 1000 5000 10000 20000
 *   node testing/bench/merge-hub-in-one-transaction.mjs 2000 40000      # sizes of your own
 *   YTHRIL_BENCH_DIMS=384 node testing/bench/merge-hub-in-one-transaction.mjs
 *   YTHRIL_TEST_MONGO_PORT=27998 YTHRIL_TEST_MONGO_CREDS= node testing/bench/merge-hub-in-one-transaction.mjs
 *
 * On the unchanged code (a per-edge loop: two seq allocations, a delete, a tombstone and an insert per edge, all in
 * one transaction) the larger sizes are EXPECTED to fail — a transaction past Mongo's lifetime limit, or out of
 * memory. That failure is the measurement, printed as `committed: false` with the store's error, not a crash.
 *
 * (requires a prior `npm run build` in server/)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo } from '../standalone/_mongo-harness.mjs';
import { seedHub, relinkProblems } from '../standalone/_merge-hub.mjs';
import { readTrackedSources } from '../standalone/_sources.mjs';
import { stripComments } from '../standalone/_strip-comments.mjs';

const SIZES = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n) && n > 2);
const RUN = SIZES.length > 0 ? SIZES : [1_000, 5_000, 10_000, 20_000];
const DIMS = Number(process.env['YTHRIL_BENCH_DIMS'] ?? 768);
const SPACE = 'mergehubbench';
const INSTANCE = 'merge-hub-bench';
const AUTHOR = { instanceId: INSTANCE, instanceLabel: 'bench' };

// The survivor's re-embed must not download a model in the middle of a timing; an unavailable model is a failure
// the merge already swallows.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-hub-bench-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
  instanceId: INSTANCE, instanceLabel: 'bench', tokens: [], networks: [],
  spaces: [{ id: SPACE, label: 'Merge hub bench', folders: [], completeLinkage: true, meta: {} }],
}, null, 2), { mode: 0o600 });

/** The bound as the code states it, when it exists — printed beside each size so a run says which side it is on. */
function boundInCode() {
  const defining = readTrackedSources('server/src', { untracked: true, floor: 300 })
    .filter(({ text }) => /export\s+const\s+MERGE_MAX_RELINKS\b/.test(stripComments(text)));
  return defining.length === 1 ? defining[0].file : null;
}

const mongo = await openTestMongo('mergehubbench');
try {
  (await import('../../server/dist/config/loader.js')).loadConfig();
  await (await import('../../server/dist/spaces/lifecycle.js')).initSpace(SPACE, { waitForVectorReady: false });
  const { executeMerge } = await import('../../server/dist/brain/merge.js');
  const { bumpSeq } = await import('../../server/dist/util/seq.js');
  const boundFile = boundInCode();
  const bound = boundFile
    ? (await import(`../../${boundFile.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js')}`)).MERGE_MAX_RELINKS
    : null;
  const coll = (part) => mongo.col(`${SPACE}_${part}`);
  console.log(JSON.stringify({ bench: 'merge-hub-in-one-transaction', dims: DIMS, sizes: RUN, MERGE_MAX_RELINKS: bound }));

  let seqFrom = 1;
  for (const n of RUN) {
    for (const p of ['entities', 'edges', 'links', 'files', 'tombstones', 'embed_jobs']) await coll(p).deleteMany({});
    // One link and one face label, the rest edges: every relink class the merge has, sized to `n` in total.
    const seedStart = Date.now();
    const hub = await seedHub({ coll, space: SPACE, author: AUTHOR, edges: n - 2, links: 1, faces: 1, vectorDims: DIMS, seqFrom });
    seqFrom = hub.maxSeq + 1;
    await bumpSeq(SPACE, hub.maxSeq);
    const seededMs = Date.now() - seedStart;

    const survivor = await coll('entities').findOne({ _id: hub.survivorId });
    const absorbed = await coll('entities').findOne({ _id: hub.absorbedId });
    const rssBefore = process.memoryUsage().rss;
    const t0 = process.hrtime.bigint();
    let committed = true;
    let error;
    try {
      await executeMerge(SPACE, survivor, absorbed, {}, undefined);
    } catch (err) {
      committed = false;
      error = `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 300)}`;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const problems = committed ? await relinkProblems({ coll, hub }) : [];
    console.log(JSON.stringify({
      relinks: hub.relinks, edges: n - 2, dims: DIMS, seededMs, mergeMs: Math.round(ms), committed,
      ...(error ? { error } : {}),
      whole: committed ? problems.length === 0 : undefined,
      ...(problems.length > 0 ? { problems } : {}),
      overBound: bound === null ? undefined : hub.relinks > bound,
      processRssDeltaMb: Math.round((process.memoryUsage().rss - rssBefore) / 1e6),
    }));
    // The next hub's seqs start above everything the merge allocated.
    seqFrom = Math.max(seqFrom, ((await mongo.col('ythril_counters').findOne({ _id: SPACE }))?.seq ?? 0) + 1);
  }
} finally {
  await closeTestMongo();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

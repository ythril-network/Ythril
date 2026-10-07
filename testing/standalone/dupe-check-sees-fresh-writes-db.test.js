/**
 * The duplicate check must see a record written a moment ago.
 *
 * ## The defect
 *
 * `checkDuplicates` went through `recallByType`, which takes the ANN path when nothing is filtered — a
 * `$vectorSearch` against the vector INDEX. That index is eventually consistent, so a just-committed
 * document is not in it. The check whose entire job is to compare against the neighbourhood of a record
 * being written *now* was the one check guaranteed not to see it.
 *
 * Reported independently by two integrators, symptoms an order of magnitude apart:
 *
 *  - a 0.98-similar record missed at ~14 s and caught at ~2 min on the **same** default threshold, which
 *    is what proves elapsed time was the variable rather than `dupeThreshold`;
 *  - a record not returned by `recall` for **150 s**, while write-time duplicate detection saw new records
 *    immediately — the asymmetry that names the cause.
 *
 * It bites exactly where it hurts: an agent writing a set of related records in one turn is *when*
 * duplicates get created, and that is the window in which the check could not fire. Every warning named an
 * older record; none named anything from the same batch.
 *
 * ## What this pins
 *
 * That the check reads committed documents. The test writes a record and immediately asks — no sleep, no
 * polling, no retry — because a test that waits would pass against the bug.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/dupe-check-sees-fresh-writes-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';
const DIMS = 8;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-dupe-fresh-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
// Deliberately NOT setting DATA_ROOT. It defaults to `/data`, which a CI runner cannot create — so if this
// suite ever reaches the filesystem again it fails here, loudly, the way it did when `initSpace` pulled in
// `ensureSpaceFilesDir`. Pointing DATA_ROOT at somewhere writable would absorb exactly the regression this
// is now the only test positioned to catch.

let server, local, mongo, entities, recall, vectorIndex;

/**
 * A deterministic vector keyed by a tag in the text, so a record can be made near-identical to the query or
 * genuinely unlike it. The stub is the real `embed()` path over HTTP — see `embed-queue-drain-db.test.js`
 * for why a stubbed endpoint beats a stubbed function here.
 *
 * The two vectors are ORTHOGONAL, which is the whole point of the third case. A first version varied the
 * components by a thousandth and called one of them "unrelated": cosine 0.99999995, so the record that was
 * supposed to prove the check discriminates would have been flagged by any threshold that also passes the
 * duplicate. A fixture whose "different" is not different tests nothing.
 */
const vectorFor = (text) => {
  const axis = /NEAR/.test(text) ? 0 : 1;
  return Array.from({ length: DIMS }, (_, i) => (i === axis ? 1 : 0));
};

describe('the duplicate check sees a record written a moment ago', { skip }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: vectorFor(JSON.parse(body).input) }] }));
      });
    });
    local = await listenOnLoopback(server);
    process.env['EMBEDDING_URL'] = local.url;

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('dupefresh');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    entities = await import('../../server/dist/brain/entities.js');

    // The harness database is fresh, so nothing has created a vector index. Without one, $vectorSearch
    // matches nothing and this suite would measure "no index" while claiming to measure index LAG — it
    // would fail identically whether the fix works or not.
    //
    // Production's own `ensureVectorSearchIndex`, so a change to the real definition cannot leave a
    // hand-rolled copy here behind. The collection is created first on purpose: mongot answers
    // `NamespaceNotFound` rather than making one.
    //
    // NOT `initSpace`, which is the obvious call and fails in CI with `EACCES: mkdir '/data'` — it also
    // creates the space's FILE directory, and the runner cannot write there. Nothing in this suite touches
    // a file; reaching for the broad helper pulled in a filesystem dependency the test never needed.
    await mongo.getDb().createCollection(`${SPACE}_entities`);
    vectorIndex = await import('../../server/dist/spaces/vector-index.js');
    await vectorIndex.ensureVectorSearchIndex(SPACE, 'entities', DIMS, 'cosine');

    // And then check that it is actually usable, because `ensureVectorSearchIndex` reports failure by
    // logging and returning: a backend without search leaves this suite green-but-meaningless otherwise.
    const ready = await vectorIndex.pollVectorIndexReady(SPACE, 'entities', `${SPACE}_entities_embedding`, { vectorPath: 'embedding', dims: 768 });
    assert.ok(ready,
      `no queryable vector index on ${SPACE}_entities — this suite compares the ANN index against `
      + 'committed documents, so without one it proves nothing either way. The test stack must be '
      + 'mongodb/mongodb-atlas-local (see testing/docker-compose.test.yml).');

    // `checkDuplicates` returns [] outright unless this has been probed. Boot does it; a standalone test
    // does not boot, so without this the suite passes two of its three cases for the reason it exists to
    // catch — an empty result read as "no duplicates".
    await mongo.checkVectorSearchAvailability();

    recall = await import('../../server/dist/brain/recall.js');
  });

  after(async () => {
    await closeTestMongo();
    await local?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { await mongo.col(`${SPACE}_entities`).deleteMany({}); });

  it('flags a near-twin written seconds earlier, with no wait', async () => {
    // `waitForEmbedding` so the first record has its vector; the point under test is whether the SEARCH
    // can see it, not whether it was embedded.
    const first = await entities.upsertEntity(
      SPACE, 'node-NEAR-1', 'machine', [], {}, 'NEAR the same thing', undefined,
      { waitForEmbedding: true },
    );
    assert.ok(first.entity._id);

    // Immediately — no sleep, no polling. A test that waited would pass against the bug it exists for.
    const hits = await recall.checkDuplicates(SPACE, 'entity', vectorFor('NEAR'), 0.9, 10);

    assert.ok(hits.length >= 1,
      'the record written a moment ago was invisible to the duplicate check — this is the ANN-index lag: '
      + 'the check reads the vector index, which has not seen the write yet');
    assert.ok(hits.some(h => h._id === first.entity._id),
      'the near-twin specifically must be among the hits');
  });

  it('still excludes the record being checked', async () => {
    // The reason the vector is computed before the insert on some paths: a record must not match itself.
    const e = await entities.upsertEntity(
      SPACE, 'node-NEAR-2', 'machine', [], {}, 'NEAR the same thing', undefined,
      { waitForEmbedding: true },
    );
    const hits = await recall.checkDuplicates(SPACE, 'entity', vectorFor('NEAR'), 0.9, 10, e.entity._id);
    assert.equal(hits.some(h => h._id === e.entity._id), false,
      'excludeId must still drop the self-match now that the search can actually see it');
  });

  it('an unrelated record is not flagged', async () => {
    // Guards the obvious way to make the first test pass: return everything. Deliberately the SAME
    // threshold as the first case, so the two together say the check discriminates rather than that some
    // threshold exists which separates them.
    await entities.upsertEntity(
      SPACE, 'node-far', 'machine', [], {}, 'entirely unrelated', undefined,
      { waitForEmbedding: true },
    );
    const hits = await recall.checkDuplicates(SPACE, 'entity', vectorFor('NEAR'), 0.9, 10);
    assert.deepEqual(hits, [], 'an orthogonal record must not be flagged as a near-duplicate');
  });
});

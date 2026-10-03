/**
 * A read inside a held transaction comes back whole, however many rows it is (bundle-30, found while batching the
 * merge, `Q-107` part 3a).
 *
 * ## The defect
 *
 * `inHeldTransaction` (`brain/held-transaction.ts`) starts its session with `defaultTimeoutMS`, so the transaction's
 * retry loop ends at the hold's deadline. With that set, the driver (7.1) sends `maxTimeMS` on a cursor's `getMore`,
 * and the server refuses it for a non-awaitData cursor: "cannot set maxTimeMS on getMore command for a non-awaitData
 * cursor". Any read inside the transaction that needed a second batch — more than 101 rows, the default first batch
 * — failed the whole transaction. A merge of an entity with a few hundred edges could not run at all.
 *
 * ## The rule
 *
 * A cursor opened inside a timed transaction is asked for all of its rows in its FIRST batch (`db/write-bound.ts`),
 * so a read of up to the server's 16 MB per batch needs no `getMore`. A caller's own `batchSize` is kept. Asserted
 * for `find` and `aggregate` — the two cursor methods the bound table carries.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-held-transaction-reads-past-one-batch-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-held-batch-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'heldbatch';
/** Comfortably past the default first batch (101), far below 16 MB. */
const ROWS = 1_200;

let mongo, held;

describe('a held transaction reads past one batch', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('heldbatch');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'held-batch-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Held batch', folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    held = await import('../../server/dist/brain/held-transaction.js');
    await mongo.col(`${S}_facts`).insertMany(Array.from({ length: ROWS }, (_, i) => ({
      _id: `f-${String(i).padStart(5, '0')}`, spaceId: S, fact: `fact ${i}`, seq: i + 1,
    })));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('a find of more rows than one default batch completes inside the transaction', async () => {
    const ids = await held.inHeldTransaction(S, 'test.held-batch',
      async (session) => (await mongo.col(`${S}_facts`).find({ spaceId: S }, { session, projection: { _id: 1 } }).toArray()).map(d => d._id));
    assert.equal(ids.length, ROWS, `the transaction read ${ids.length} of ${ROWS} rows`);
  });

  it('an aggregate of more rows than one default batch completes inside the transaction', async () => {
    const n = await held.inHeldTransaction(S, 'test.held-batch',
      async (session) => (await mongo.col(`${S}_facts`).aggregate([{ $match: { spaceId: S } }, { $project: { _id: 1 } }], { session }).toArray()).length);
    assert.equal(n, ROWS, `the transaction aggregated ${n} of ${ROWS} rows`);
  });

  it('a caller\'s own batchSize is kept', async () => {
    // Asked for small batches on purpose, the read needs a getMore — and is refused, which is the driver behaviour
    // the guard exists for. Kept rather than overridden: a caller that names a batch size has a reason.
    await assert.rejects(held.inHeldTransaction(S, 'test.held-batch',
      async (session) => mongo.col(`${S}_facts`).find({ spaceId: S }, { session, batchSize: 50 }).toArray()),
    /getMore/, 'a batchSize the caller gave was replaced');
  });
});

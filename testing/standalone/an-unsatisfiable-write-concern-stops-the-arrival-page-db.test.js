/**
 * An arrival page whose write concern can never be met FAILS WHOLE — it is never read as one document's refusal
 * (bundle-53 G1, INT-2; Q-343).
 *
 * ## The defect it prevents
 *
 * The arrival writer (`sync/arrivals.ts`) refuses ONE document for good when the store's code names the document:
 * `DOCUMENT_REFUSAL_CODES` (`db/write-errors.ts`) lists code 2, `BadValue`. The same code is what a standalone mongod
 * answers a `w > 1` with — "cannot use 'w' > 1 when a host is not replicated" — so on a standalone deployment a write
 * concern the instance can never meet was read as the DOCUMENT's fault, and the document was refused by id: dropped
 * from its sync page, the sender told it was handled, the data gone for good, over a configuration mistake. And a
 * bulk write that failed with no per-operation shape was retried document by document, which on a deployment whose
 * write concern is the fault only repeats it N times.
 *
 * A write concern the deployment cannot meet is the DEPLOYMENT's. The page must fail whole (`ArrivalWriteError`), so
 * the sender offers it again once the configuration is fixed, and `out.refused` stays empty.
 *
 * ## What it holds, through `writeArrivals` with the real driver's errors
 *
 * The writer asks "is this one document's?" on three paths — the bulk write's own catch, the per-operation list of a
 * bulk error, and the document-by-document fallback — so each is handed the unsatisfiable error where it reads it:
 *
 * - the real `w: 5` bulk error (code 100, on the RESULT) from `driverWriteFailures`, with the fallback write healthy:
 *   before the fix the page fell back to one write per document and every document landed behind a failed concern;
 * - the real `w: 5` single error in the document-by-document fallback;
 * - a hand-built code-2 error with the standalone text (the test store is a replica set and cannot produce it, so it is
 *   the one built error here): at the bulk level, in a bulk error's per-operation list, and in the fallback;
 * - and the contract this must not break: a code-2 refusal with ANY OTHER text still refuses the document.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-unsatisfiable-write-concern-stops-the-arrival-page-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'wcarrival';
const STANDALONE_TEXT = "cannot use 'w' > 1 when a host is not replicated";

let door, faults, writeArrivals, ArrivalWriteError, F, MongoServerError, MongoBulkWriteError;

/** One fact arriving through the one writer: its outcome, or the error the page failed with. */
async function arrive(id) {
  try {
    return { out: await writeArrivals(S, 'facts', 'fact', [build.fact(S, id, 5)], { from: 'peer-1' }), err: null };
  } catch (err) { return { out: null, err }; }
}
/** A bulk write that failed with NO per-operation shape — "ask each document", the writer's fallback. */
const ambiguousBulk = () => new MongoServerError({ message: 'ambiguous bulk failure', code: 999 });
const standaloneRefusal = () => new MongoServerError({ errmsg: STANDALONE_TEXT, code: 2, codeName: 'BadValue' });
const NO_WC = { getWriteConcernError: () => undefined };

describe('an unsatisfiable write concern stops the arrival page', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'wcarrival', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    ({ writeArrivals, ArrivalWriteError } = await import('../../server/dist/sync/arrivals.js'));
    ({ MongoServerError, MongoBulkWriteError } = await import('mongodb'));
    F = await driverWriteFailures('ythril_harness_wcarrival');
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), ['bulkWrite', 'updateOne']);
  });
  after(async () => { faults?.restore(); await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });
  afterEach(() => { faults.clear(); });

  it('the fixtures are real: both w:5 errors carry code 100, and the writer\'s failure is an ArrivalWriteError', () => {
    assert.equal(F.writeConcern.single.code, 100);
    assert.equal(F.writeConcern.bulk.result.getWriteConcernError()?.code, 100);
    assert.equal(typeof ArrivalWriteError, 'function');
  });

  /** Each case arms the writes it names, runs one document through the writer, and states what the page must do. */
  const FAILS_WHOLE = [
    ['the real w:5 BULK error, the fallback write healthy (it must not be asked document by document)',
      () => faults.fail('bulkWrite', `${S}_facts`, F.writeConcern.bulk, { times: 5 })],
    ['the real w:5 SINGLE error in the document-by-document fallback',
      () => { faults.fail('bulkWrite', `${S}_facts`, ambiguousBulk(), { times: 5 }); faults.fail('updateOne', `${S}_facts`, F.writeConcern.single, { times: 5 }); }],
    ['code 2 with the standalone text as the bulk error itself, the fallback write healthy',
      () => faults.fail('bulkWrite', `${S}_facts`, new MongoBulkWriteError({ message: STANDALONE_TEXT, code: 2, writeErrors: [] }, NO_WC), { times: 5 })],
    ['code 2 with the standalone text in a bulk error\'s per-operation list (the failedAt branch)',
      () => faults.fail('bulkWrite', `${S}_facts`,
        new MongoBulkWriteError({ message: 'bulk', writeErrors: [{ index: 0, code: 2, errmsg: STANDALONE_TEXT }] }, NO_WC), { times: 5 })],
    ['code 2 with the standalone text in the document-by-document fallback',
      () => { faults.fail('bulkWrite', `${S}_facts`, ambiguousBulk(), { times: 5 }); faults.fail('updateOne', `${S}_facts`, standaloneRefusal(), { times: 5 }); }],
  ];

  for (const [label, arm] of FAILS_WHOLE) {
    it(`fails the page whole and refuses no document: ${label}`, async () => {
      arm();
      const { out, err } = await arrive(`wc-${label.length}`);
      assert.ok(err, `the page did not fail (it ${JSON.stringify(out?.refused?.length ? { refused: out.refused } : { inserted: out?.inserted })}): an unsatisfiable write concern was read as something it is not`);
      assert.ok(err instanceof ArrivalWriteError, `the page failed with ${err.name}, not the writer's own error`);
      assert.deepEqual(err.partial?.refused ?? [], [], 'a document was refused for good over the deployment\'s write concern');
    });
  }

  it('the contract this must not break: a code-2 refusal with any OTHER text still refuses the document', async () => {
    faults.fail('bulkWrite', `${S}_facts`, ambiguousBulk(), { times: 1 });
    faults.fail('updateOne', `${S}_facts`,
      new MongoServerError({ errmsg: 'a field of this document holds a bad value', code: 2, codeName: 'BadValue' }), { times: 5 });
    const { out, err } = await arrive('bad-value');
    assert.equal(err, null, `the page failed (${err?.name}: ${err?.message}) over one document's own bad value`);
    assert.deepEqual(out.refused.map(r => r._id), ['bad-value'], 'a document the store refused for its own content was not refused');
  });

  it('and with nothing armed the same document lands: the cases above fail by the fault, not by the fixture', async () => {
    const { out, err } = await arrive('healthy');
    assert.equal(err, null);
    assert.deepEqual(out.inserted.map(d => d._id ?? d), ['healthy']);
  });
});

/**
 * A transaction's writes are reported through ONE `'ended'` listener on its session, however many there are
 * (`Q-311`).
 *
 * ## The defect
 *
 * `db/record-write-observer.ts` reports a write made inside a transaction only once the session ENDS (a reader
 * outside the transaction does not see it before the commit). It did so by adding `session.once('ended', …)` per
 * WRITE. A merge of a hub entity writes thousands of times in one session, so the session collected thousands of
 * listeners: Node prints `MaxListenersExceededWarning` past ten, and each listener holds its closure until the
 * session ends.
 *
 * ## The rule this file holds
 *
 * **A session carries one `'ended'` listener whatever the number of writes inside it, and every write is still
 * reported exactly once, after the session ends** — the reports are unchanged, only how they wait.
 *
 * Run: node --test testing/standalone/a-transaction-holds-one-write-listener-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const WRITES = 1000;
const COLL = 'onelistener_facts';

describe('a transaction holds one write listener', { skip }, () => {
  let mongo;
  const heard = [];
  const warnings = [];
  const onWarning = (w) => { warnings.push(w); };
  /** The session's `'ended'` listeners before the first write — the driver keeps one of its own. */
  let ownListeners = -1;
  let peakListeners = 0;
  let reportedBeforeEnd = -1;

  before(async () => {
    mongo = await openTestMongo('onelistener');
    mongo.onRecordCollectionWrite(name => name === COLL, (name, effect) => heard.push([name, effect]));
    await mongo.getDb().createCollection(COLL);
    process.on('warning', onWarning);
    const session = mongo.getMongo().startSession();
    try {
      await session.withTransaction(async () => {
        const coll = mongo.col(COLL);
        if (ownListeners < 0) ownListeners = session.listenerCount('ended');
        for (let i = 0; i < WRITES; i++) {
          await coll.insertOne({ _id: `w${i}` }, { session });
          peakListeners = Math.max(peakListeners, session.listenerCount('ended'));
        }
      });
      reportedBeforeEnd = heard.length;
    } finally {
      await session.endSession();
    }
    // A warning is emitted on the next tick.
    await new Promise(r => setImmediate(r));
  });
  after(async () => {
    process.off('warning', onWarning);
    await closeTestMongo();
  });

  it(`${WRITES} writes in one transaction leave one 'ended' listener on the session`, () => {
    assert.equal(peakListeners - ownListeners, 1,
      `the writes added ${peakListeners - ownListeners} 'ended' listeners to the session (beside the driver's own `
      + `${ownListeners}) for ${WRITES} writes — one per write`);
    const leak = warnings.filter(w => w.name === 'MaxListenersExceededWarning');
    assert.deepEqual(leak.map(w => w.message), [], 'the transaction tripped the listener-leak warning');
  });

  it('every write is reported once, and only after the session ended', () => {
    assert.equal(reportedBeforeEnd, 0, `${reportedBeforeEnd} write(s) were reported before the session ended`);
    assert.equal(heard.length, WRITES, `${heard.length} reports for ${WRITES} writes`);
    assert.ok(heard.every(([n, e]) => n === COLL && e.write === true), 'a report named another collection or effect');
  });
});

/**
 * `_active-operations.mjs` answers "has a write STARTED" as well as "has it ended" — the start half, against a stand-in
 * for the server's `currentOp`.
 *
 * ## What this pins
 *
 * The -db tests that stall a write behind a lock call `waitForLiveWrite` to prove the stall took hold, and
 * `a-write-the-bound-ended-never-lands-db` calls `sawLiveWrite` over a whole bound. Both need a Mongo to run against the
 * server, so on a machine without one they are skipped and their wait is not exercised at all. These rows run the two
 * against a fake `mongo` whose `currentOp` answers a script, so the logic — the namespace it asks about, the verdict at
 * the deadline, the window `sawLiveWrite` watches — is held without one.
 *
 * Run: node --test testing/standalone/active-operations-wait-for-the-start.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeOperations, waitForLiveWrite, sawLiveWrite } from './_active-operations.mjs';

/** A stand-in for the server's `db/mongo.js` whose `currentOp` answers `inprog()` and records the namespaces asked about. */
function fakeMongo(inprog) {
  const asked = [];
  return {
    asked,
    getDb: () => ({ databaseName: 'harness_db' }),
    getMongo: () => ({ db: () => ({ command: async (cmd) => { asked.push(cmd.ns); return { inprog: inprog() }; } }) }),
  };
}

const insert = { op: 'insert', ns: 'harness_db.coll', secs_running: 1 };
const cursor = { op: 'getmore', ns: 'harness_db.coll' };

describe('activeOperations', () => {
  it('asks about the collection in the connected database\'s own namespace, and keeps only writes', async () => {
    const m = fakeMongo(() => [insert, cursor, { op: 'command', command: { findAndModify: 'coll' } }, { op: 'command', command: { find: 'coll' } }]);
    const ops = await activeOperations(m, 'coll');
    assert.deepEqual(m.asked, ['harness_db.coll']);
    assert.deepEqual(ops.map((o) => o.op), ['insert', 'command']);
  });
});

describe('waitForLiveWrite', () => {
  it('answers true once a write is alive, however late it starts', async () => {
    let polls = 0;
    const m = fakeMongo(() => (++polls >= 4 ? [insert] : []));
    assert.equal(await waitForLiveWrite(m, 'coll', { startMs: 2_000 }), true);
    assert.ok(polls >= 4);
  });

  it('answers FALSE at the deadline when no write ever started — a verdict for the caller to word, not a throw', async () => {
    const m = fakeMongo(() => [cursor]);
    assert.equal(await waitForLiveWrite(m, 'coll', { startMs: 80 }), false);
  });

  it('a read-only cursor is not a write: a change stream on the collection does not count as the stall', async () => {
    const m = fakeMongo(() => [cursor, cursor]);
    assert.equal(await waitForLiveWrite(m, 'coll', { startMs: 60 }), false);
  });
});

describe('sawLiveWrite', () => {
  it('answers true when a write was alive at any moment before done() turned true', async () => {
    let polls = 0;
    const m = fakeMongo(() => (polls === 2 ? [insert] : []));
    const saw = await sawLiveWrite(m, 'coll', () => ++polls > 5);
    assert.equal(saw, true);
  });

  it('answers false when none was, and does not poll once done() is already true', async () => {
    const m = fakeMongo(() => []);
    let calls = 0;
    assert.equal(await sawLiveWrite(m, 'coll', () => ++calls > 3), false);
    const idle = fakeMongo(() => [insert]);
    assert.equal(await sawLiveWrite(idle, 'coll', () => true), false);
    assert.deepEqual(idle.asked, [], 'it asked the server after the window had closed');
  });
});

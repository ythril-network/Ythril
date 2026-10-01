/**
 * A converge that loses a race to another write is RE-PLANNED, never written over it (`Q-99` part 3).
 *
 * ## The rule
 *
 * A write that converges onto an existing record is planned against the record as it was read, and the update
 * lands only if the record still has the seq it had then (`expectSeq`, in the update's filter). When another
 * write changed it in between, the commit reports the plan stale and the door plans it again against what the
 * record now says — so the other write's change survives, merged, instead of being overwritten. Losing the race
 * a second time is a `WriteConflict` (409 on both doors): nothing is written, and resending is the remedy.
 *
 * ## How the race is made deterministic
 *
 * No sleeps. The commit's record write is parked: `Collection.prototype.bulkWrite` is wrapped so the first bulk
 * write to the facts collection after arming waits on a gate the test opens. While it is parked, a second write
 * changes the same record through the update path. Then the gate opens.
 *
 * Seen red: with the seq predicate removed from the commit's update (`opFor` in `write-plan/commit.ts`), the
 * parked converge overwrites the other write's tags and the merge assertion fails.
 *
 * Run: node --test testing/standalone/a-converge-that-loses-a-race-is-replanned-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-converge-race-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const HOLD_TIMEOUT = 30_000;

let mongo, fact, bulk, types;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

let armed = null;
let original = null;

/** Park the next `count` bulk writes to `name`; each waits for the gate. Returns when the first is reached. */
function arm(name, count = 1) {
  let reached, release;
  const reachedP = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  armed = { name, left: count, reached, gate };
  return { reached: reachedP, release };
}

describe('a converge that loses a race is re-planned', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('convergerace');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'converge-race-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    bulk = await import('../../server/dist/brain/bulk.js');
    types = await import('../../server/dist/brain/write-plan/types.js');
    const proto = Object.getPrototypeOf(mongo.col('probe'));
    original = proto.bulkWrite;
    proto.bulkWrite = async function held(...args) {
      if (armed && this.collectionName === armed.name && armed.left > 0) {
        const a = armed;
        a.left -= 1;
        if (a.left === 0) armed = null;
        a.reached();
        await a.gate;
      }
      return original.apply(this, args);
    };
  });

  after(async () => {
    if (original) Object.getPrototypeOf(mongo.col('probe')).bulkWrite = original;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    armed = null;
    for (const c of ['facts', 'links', 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
  });

  it('the other write\'s change survives, merged, and the converge still lands', { timeout: HOLD_TIMEOUT }, async () => {
    const seeded = await fact.saveFact(SPACE, 'the original text', [], ['seed']);
    const hold = arm(`${SPACE}_facts`);
    const converge = fact.saveFact(SPACE, 'the converged text', [], ['retry'], undefined, undefined, undefined,
      undefined, undefined, undefined, seeded._id);
    await hold.reached;
    try {
      // While the converge is parked at its write, another write changes the same record.
      const patched = await fact.updateFact(SPACE, seeded._id, { tags: ['seed', 'concurrent'] });
      assert.ok(patched, 'the concurrent update did not land');
    } finally {
      hold.release();
    }
    const out = await converge;
    const stored = await coll('facts').findOne({ _id: seeded._id });
    assert.equal(stored.fact, 'the converged text', 'the converge did not land');
    assert.deepEqual([...stored.tags].sort(), ['concurrent', 'retry', 'seed'],
      'the converge was written over the concurrent change instead of being re-planned against it — '
      + 'a lost update: the other write\'s tag is gone');
    assert.equal(out.seq, stored.seq, 'the door answered with a seq that is not the stored one');
  });

  it('losing the race twice is a WriteConflict, and nothing is written', { timeout: HOLD_TIMEOUT }, async () => {
    const seeded = await fact.saveFact(SPACE, 'the original text', [], ['seed']);
    const first = arm(`${SPACE}_facts`);
    const settled = fact.saveFact(SPACE, 'the converged text', [], ['retry'], undefined, undefined, undefined,
      undefined, undefined, undefined, seeded._id).then(() => null, (err) => err);
    await first.reached;
    // First loss: the record moves while the first attempt is parked.
    await fact.updateFact(SPACE, seeded._id, { tags: ['one'] });
    // A SECOND gate, armed before the first opens, so the re-plan's write parks too.
    const second = arm(`${SPACE}_facts`);
    first.release();
    await second.reached;
    // Second loss: the record moves again while the re-plan is parked.
    await fact.updateFact(SPACE, seeded._id, { tags: ['two'] });
    second.release();
    const err = await settled;
    assert.ok(err instanceof types.WriteConflict,
      `a converge that lost twice should be refused as a WriteConflict, got: ${err ? err.message : 'success'}`);
    const stored = await coll('facts').findOne({ _id: seeded._id });
    assert.equal(stored.fact, 'the original text', 'a refused converge still wrote its text');
    assert.deepEqual(stored.tags, ['two'], 'the refused converge changed the record');
  });

  it('a batch item that loses twice says so in the same words, and the rest of the batch is written',
    { timeout: HOLD_TIMEOUT }, async () => {
      /*
       * The batch had its own re-plan, and it had drifted from the single write's: a second loss reported the
       * commit's raw stale reason instead of the conflict. The write-semantics guide promises one reason on
       * both, so this asserts the batch's item error IS the conflict a single write throws.
       */
      const seeded = await fact.saveFact(SPACE, 'the original text', [], ['seed']);
      const first = arm(`${SPACE}_facts`);
      const settled = bulk.bulkWrite(SPACE, {
        facts: [{ id: seeded._id, fact: 'the converged text', tags: ['retry'] }, { fact: 'an unrelated fact' }],
      });
      await first.reached;
      await fact.updateFact(SPACE, seeded._id, { tags: ['one'] });
      const second = arm(`${SPACE}_facts`);
      first.release();
      await second.reached;
      await fact.updateFact(SPACE, seeded._id, { tags: ['two'] });
      second.release();
      const res = await settled;
      const expected = new types.WriteConflict('fact', seeded._id).message;
      assert.deepEqual(res.errors.map(e => ({ index: e.index, reason: e.reason })), [{ index: 0, reason: expected }],
        `the item that lost twice should carry the conflict a single write answers: ${JSON.stringify(res.errors)}`);
      assert.equal(res.inserted.facts, 1, 'the rest of the batch was not written');
      const stored = await coll('facts').findOne({ _id: seeded._id });
      assert.equal(stored.fact, 'the original text', 'a refused converge still wrote its text');
    });
});

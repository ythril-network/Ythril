/**
 * A restored space has its unique and keyset indexes, and a counter at or above every seq it could have handed out, BEFORE its writes
 * resume (bundle-157, Q-554; design rev 2 "The counter raise", rev 3 R3.3 steps 1-4 and R3.10).
 *
 * ## The rule this holds, and the red it is seen at
 *
 * A restore drops each collection and reloads it with `insertMany`, which builds no index but `_id`. Until something rebuilds them, two
 * edges of one identity can be stored, a functional label can be raced, and every seq-keyset page sorts in memory. And the counter:
 * the backup's `ythril_counters` can hold no doc for the space at all, or one below seqs this process already handed out, so the next
 * write takes a seq a peer has already been served. The rule: the act body, inside the hold,
 *
 * - takes the floor AFTER the drain as max(the counter doc, the highest stored seq, the in-process `maxSeen`), and writes the counter
 *   to at least that floor and the highest seq it restored;
 * - builds the edge identity and guard unique indexes and every `SEQ_KEYSET_INDEXES` entry before the completion lifts the hold.
 *
 * ## What is asserted
 *
 * - **Floor.** Space `floored` holds facts up to seq 3 and NO counter doc at the backup. After it: facts at 4 and 5, a write that
 *   takes seq 9 (so `maxSeen` is 9) and is then removed, and the counter doc set back to 7 - three sources, each different. After the
 *   restore the counter doc exists and is at least 9 and at least the highest stored seq.
 * - **Indexes before writes resume.** In the runner's `beforeComplete` hook (the act's body is done, the hold not yet lifted), the
 *   edges carry the identity index and every `EDGE_GUARD_INDEXES` entry, unique, and every restored collection named by
 *   `SEQ_KEYSET_INDEXES` carries its keyset index. The sets are read from the server's own declarations, with a floor.
 *
 * ## Seen red
 *
 * On 14005a5c the floor row fails on the counter: it is 7, the live doc the restore left standing, below the 9 this process already
 * handed out (nothing takes the in-process `maxSeen` into the floor). The index row fails because `POST /restore` answers 200 with no
 * act to complete.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/a-restored-space-has-its-indexes-before-writes-resume-db.test.js`
 * (a prior `npm run build` in server/).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { build } from './_push-door.mjs';
import { clearActEntries, resetRunnerForTest, untilRunnerIdle } from './_space-act-harness.mjs';
import { restoreModules, takeBackup, restoreToTheEnd, restoreAsActs, startRestoreActs } from './_restore-act.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const SUITE = 'restoreindexes';
const T = { timeout: 90_000 };
const IDENTITY_KEYS = { from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 };

let door, mods, writers;
const facts = (space, ns) => ns.map(n => ({ _id: `${space}-${n}`, spaceId: space, fact: `${space} ${n}`, tags: [], seq: n }));
const sameKeys = (a, b) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

async function highestStoredSeq(space) {
  const { SEQ_CARRYING } = await import('../../server/dist/util/seq.js');
  let highest = 0;
  for (const part of SEQ_CARRYING) {
    const top = await door.coll(space, part).find({ seq: { $type: 'number' } }).sort({ seq: -1 }).limit(1).toArray();
    if (top[0]) highest = Math.max(highest, top[0].seq);
  }
  return highest;
}

describe('a restored space has its indexes and its counter floor before writes resume (real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: SUITE, spaces: ['floored', 'indexed'].map(id => ({ id, label: id, folders: [] })) });
    mods = await restoreModules();
    writers = { fact: await import('../../server/dist/brain/fact.js') };
  });
  after(async () => { try { resetRunnerForTest(mods.runner); } catch { /* never loaded */ } await door?.close(); });
  beforeEach(() => { resetRunnerForTest(mods.runner); clearActEntries(mods.loader); });

  it('the counter after a restore that dropped the counter doc is at least max(counter doc, highest stored seq, maxSeen)', T, async () => {
    const S = 'floored';
    await door.coll(S, 'facts').insertMany(facts(S, [1, 2, 3]));
    await door.mongo.col('ythril_counters').deleteMany({ _id: S });
    const backup = await takeBackup(SUITE, `floor-${Date.now()}`);
    assert.ok(!backup.manifest.collections.some(c => c.name === 'ythril_counters' && c.count > 0)
      || !(await door.mongo.col('ythril_counters').findOne({ _id: S })), 'fixture: the backup holds a counter doc for the space');

    await door.coll(S, 'facts').insertMany(facts(S, [4, 5]));
    await door.setCounter(S, 8);
    const taken = await writers.fact.saveFact(S, 'takes seq 9', [], [], undefined, undefined, 'note');
    const takenId = taken?._id ?? taken?.fact?._id ?? taken?.id;
    const nine = await door.coll(S, 'facts').findOne({ seq: 9 });
    assert.ok(nine, `fixture: the write did not take seq 9 (${JSON.stringify(takenId)})`);
    await door.coll(S, 'facts').deleteOne({ _id: nine._id });
    await door.setCounter(S, 7);
    const floor = 9;

    await restoreToTheEnd(mods, { backupId: backup.id });
    const counter = (await door.mongo.col('ythril_counters').findOne({ _id: S }))?.seq;
    assert.ok(counter !== undefined, 'after the restore the space has no counter doc: the next write starts again from 1, below seqs already handed out');
    assert.ok(counter >= floor, `after the restore the counter is ${counter}, below the floor ${floor} (in-process maxSeen 9, counter doc 7): the next write reuses a seq already handed out`);
    const highest = await highestStoredSeq(S);
    assert.ok(counter >= highest, `after the restore the counter ${counter} is below the highest stored seq ${highest}`);
  });

  it('when the act completes, the edges carry their unique indexes and every restored seq collection its keyset index', T, async () => {
    const S = 'indexed';
    const { SEQ_KEYSET_INDEXES } = await import('../../server/dist/util/seq-keyset.js');
    const { EDGE_GUARD_INDEXES } = await import('../../server/dist/spaces/edge-guard-index.js');
    assert.ok(SEQ_KEYSET_INDEXES.length >= 2 && EDGE_GUARD_INDEXES.length >= 1, 'the index declarations read as empty: the derivation is broken');
    await door.coll(S, 'facts').insertMany(facts(S, [1, 2]));
    await door.coll(S, 'edges').insertOne(build.edge(S, `${S}-e1`, 3, { fromKind: 'entity', toKind: 'entity' }));
    const backup = await takeBackup(SUITE, `indexes-${Date.now()}`);

    let atCompletion;
    mods.runner.setSpaceActHooksForTest({
      beforeComplete: async (e) => {
        if (e.kind !== 'restore' || e.localId !== S) return;
        const names = (await door.mongo.getDb().listCollections().toArray()).map(c => c.name);
        const indexes = {};
        for (const n of names.filter(x => x.startsWith(`${S}_`))) indexes[n] = await door.mongo.col(n).indexes();
        atCompletion = indexes;
      },
    });
    await restoreAsActs(mods, { backupId: backup.id });
    for (const r of await Promise.all(startRestoreActs(mods.runner, mods.loader))) assert.equal(r.ok, true, `a restore act did not complete: ${JSON.stringify(r)}`);
    await untilRunnerIdle(mods.runner, mods.loader);
    assert.ok(atCompletion, 'the restore act of the space never reached its completion');

    const missing = [];
    const has = (coll, keys, unique) => (atCompletion[coll] ?? []).some(ix => sameKeys(ix.key, keys) && (!unique || ix.unique === true));
    if (!has(`${S}_edges`, IDENTITY_KEYS, true)) missing.push(`${S}_edges identity (unique)`);
    for (const g of EDGE_GUARD_INDEXES) if (!has(`${S}_edges`, g.keys, true)) missing.push(`${S}_edges guard ${JSON.stringify(g.keys)} (unique)`);
    const keysetChecked = [];
    for (const ix of SEQ_KEYSET_INDEXES) {
      const coll = `${S}_${ix.part}`;
      if (!atCompletion[coll]) continue;
      keysetChecked.push(coll);
      if (!has(coll, ix.keys, false)) missing.push(`${coll} keyset ${JSON.stringify(ix.keys)}`);
    }
    assert.ok(keysetChecked.includes(`${S}_facts`) && keysetChecked.includes(`${S}_edges`), `the keyset check reached too few collections: ${keysetChecked.join(', ')}`);
    assert.deepEqual(missing, [], `the hold was about to lift over a space without these indexes: ${missing.join('; ')}`);
  });
});

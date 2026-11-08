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
 * ## What hangs off a record that lost its race (`Q-201`)
 *
 * A batch's edge follows its record's FINAL outcome, not the first commit's: an edge whose record (or either end) was set
 * aside by a lost race waits for the re-plan. Re-planned and landed, the edge is stored and no row is reported; lost twice,
 * the edge is refused with the dependency reason carrying the record's conflict, and nothing is stored for it. Before the
 * change the batch answered an edge in the same commit as the stale record with an error row although the record then
 * landed, and stored an edge planned after a flush boundary although the record then failed. The cases below park the
 * record's write the same way and read the stored edges, the rows and `refs`.
 *
 * Seen red on the unchanged code (base a04c978e): see the log named in the Q-201 ticket's Work-Log.
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
import { parkWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-converge-race-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const WARN_SPACE = 'warnrace';
const HOLD_TIMEOUT = 30_000;
const ALICE = 'aaaaaaaa-0000-4000-8000-00000000a1ce';
const BOUNDARY = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const DEPENDENCY = 'it depends on an item of this request that was not written:';

let mongo, fact, bulk, types;
const coll = (n) => mongo.col(`${SPACE}_${n}`);

let park = null;

/** Park the next bulk write to `name` until released (`_write-faults.mjs`); `reached` resolves when it is parked. */
const arm = (name) => park.arm(name, { when: (method) => method === 'bulkWrite' });

describe('a converge that loses a race is re-planned', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('convergerace');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'converge-race-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} },
        // A space that WARNS (writes, and says what a strict one would refuse) about a fact property of the wrong type.
        {
          id: WARN_SPACE, label: 'Warn', folders: [],
          meta: {
            validationMode: 'warn', suppressEmbeddings: true,
            typeSchemas: { fact: { claim: { propertySchemas: { confidence: { type: 'number' } } } } },
          },
        },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    fact = await import('../../server/dist/brain/fact.js');
    bulk = await import('../../server/dist/brain/bulk.js');
    types = await import('../../server/dist/brain/write-plan/types.js');
  });

  after(async () => {
    park?.restore();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    // A fresh park per case, so a hold a failed case left armed cannot catch the next case's write.
    park?.restore();
    park = parkWrites(Object.getPrototypeOf(mongo.col('probe')));
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

  describe('what hangs off a record that lost its race follows the record\'s final outcome (Q-201)', () => {
    beforeEach(async () => {
      for (const s of [SPACE, WARN_SPACE]) {
        for (const c of ['facts', 'entities', 'edges', 'links', 'embed_jobs', 'tombstones']) await mongo.col(`${s}_${c}`).deleteMany({});
      }
      // The far end of every edge, and a record the boundary shapes address twice (they converge on it, so it must exist).
      for (const id of [ALICE, BOUNDARY]) {
        await coll('entities').insertOne({ _id: id, spaceId: SPACE, name: id === ALICE ? 'Alice' : 'Boundary seed', type: 'person', tags: [], seq: 1 });
      }
    });

    /** The collection of every bulk write, in arrival order — laid over the park, so a park's `restore()` removes it too. */
    function observe() {
      const proto = Object.getPrototypeOf(mongo.col('probe'));
      const inner = proto.bulkWrite;
      const log = [];
      proto.bulkWrite = function observed(...args) { log.push(this.collectionName); return inner.apply(this, args); };
      return log;
    }

    /**
     * Run `body` as a batch and make its fact writes lose their races in a script: the first commit parks, `whileParked[0]` runs
     * while it is parked, and each later step runs while the NEXT write to the facts collection (a re-plan, one per record, in
     * order) is parked. A step that does nothing lets that write land.
     */
    async function raceBatch(space, body, whileParked) {
      let gate = arm(`${space}_facts`);
      const settled = bulk.bulkWrite(space, body);
      settled.catch(() => { /* surfaced where it is awaited */ });
      await gate.reached;
      for (let k = 0; k < whileParked.length; k++) {
        await whileParked[k]();
        if (k < whileParked.length - 1) {
          const next = arm(`${space}_facts`);
          gate.release();
          await next.reached;
          gate = next;
        }
      }
      gate.release();
      return settled;
    }

    const move = (space, id, tag) => () => fact.updateFact(space, id, { tags: ['seed', tag] });
    const moveAll = (space, ids, tag) => async () => { for (const id of ids) await move(space, id, tag)(); };
    const nothing = async () => { /* let the parked re-plan land */ };
    const remove = (id) => () => fact.deleteFact(SPACE, id);
    const seedFact = (text = 'the original text') => fact.saveFact(SPACE, text, [], ['seed']);
    const edgesStored = () => coll('edges').find({}).toArray();
    const rowsOf = (res, pattern) => res.errors.filter(e => pattern.test(e.reason));

    // An inline edge, in the record's own item.
    const inline = (id) => ({ facts: [{ id, fact: 'converged', tags: ['retry'], $ref: 'k1', edges: [{ to: ALICE, label: 'mentions' }] }] });
    // A top-level `$ref` edge after a flush boundary: the second boundary item addresses an id already planned, so the batch
    // commits first (`beforeTarget`), and the edge is planned AFTER the converge's first commit.
    const afterBoundary = (id) => ({
      facts: [{ id, fact: 'converged', tags: ['retry'], $ref: 'k1' }],
      entities: [{ id: BOUNDARY, name: 'Boundary', type: 'person' }, { id: BOUNDARY, name: 'Boundary again', type: 'person' }],
      edges: [{ from: '$ref:k1', fromKind: 'fact', to: ALICE, label: 'mentions' }],
    });
    // The racing record is the edge's `to` end; the other end is an existing entity.
    const toEnd = (id) => ({
      facts: [{ id, fact: 'converged', tags: ['retry'], $ref: 'k1' }],
      edges: [{ from: ALICE, fromKind: 'entity', to: '$ref:k1', toKind: 'fact', label: 'mentioned-by' }],
    });
    // Both ends of the edge are racing records.
    const bothEnds = (one, two) => ({
      facts: [{ id: one, fact: 'one converged', tags: ['retry'], $ref: 'k1' }, { id: two, fact: 'two converged', tags: ['retry'], $ref: 'k2' }],
      edges: [{ from: '$ref:k1', fromKind: 'fact', to: '$ref:k2', toKind: 'fact', label: 'relates' }],
    });

    it('an inline edge of a converge that loses once is stored, and no error row is reported', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, inline(seeded._id), [move(SPACE, seeded._id, 'one')]);
      assert.deepEqual(res.errors, [], `the batch reported rows for a write that landed: ${JSON.stringify(res.errors)}`);
      const edges = await edgesStored();
      assert.equal(edges.length, 1, `expected the edge of the landed record to be stored, found ${edges.length}`);
      assert.equal(edges[0].from, seeded._id, 'the edge does not hang off the fact');
      assert.equal(edges[0].to, ALICE);
      assert.equal(res.connections.edges, 1, 'the landed edge was not counted');
      assert.equal((await coll('facts').findOne({ _id: seeded._id })).fact, 'converged', 'the converge did not land');
    });

    it('an inline edge of a converge that loses twice is refused with the record\'s conflict, and writes no edge', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, inline(seeded._id), [move(SPACE, seeded._id, 'one'), move(SPACE, seeded._id, 'two')]);
      const conflict = new types.WriteConflict('fact', seeded._id).message;
      assert.equal(res.errors.length, 2, `expected the fact's conflict row and one edge row: ${JSON.stringify(res.errors)}`);
      assert.ok(res.errors.some(e => e.reason === conflict), `no conflict row for the fact: ${JSON.stringify(res.errors)}`);
      const edgeRow = res.errors.find(e => e.reason !== conflict);
      assert.ok(edgeRow.reason.startsWith(DEPENDENCY), `the edge row is not the dependency refusal: ${edgeRow.reason}`);
      assert.ok(edgeRow.reason.includes(conflict), `the edge row does not carry the record's conflict: ${edgeRow.reason}`);
      // Q-170: `written` names what is stored for the item; the record did not land, so there is nothing to name.
      assert.equal(edgeRow.written, undefined, `a failed edge of a record that never landed carries 'written': ${JSON.stringify(edgeRow)}`);
      assert.equal((await edgesStored()).length, 0, 'an edge of a record that never landed was stored');
      assert.equal((await coll('facts').findOne({ _id: seeded._id })).fact, 'the original text');
    });

    it('a `$ref` edge planned after a flush boundary is stored when its record loses once and lands', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const log = observe();
      const res = await raceBatch(SPACE, afterBoundary(seeded._id), [move(SPACE, seeded._id, 'one')]);
      assert.deepEqual(res.errors, [], `the batch reported rows: ${JSON.stringify(res.errors)}`);
      // The boundary happened: the entities were written by two commits (the batch's flush, then the rest), the edge after the first.
      assert.equal(log.filter(n => n === `${SPACE}_entities`).length, 2, `no flush boundary: ${JSON.stringify(log)}`);
      assert.equal(log.filter(n => n === `${SPACE}_facts`).length, 2, `the converge was not re-planned once: ${JSON.stringify(log)}`);
      const edges = await edgesStored();
      assert.equal(edges.length, 1, `expected one stored edge, found ${edges.length}`);
      assert.equal(edges[0].from, seeded._id);
      assert.equal(res.refs.k1?.id, seeded._id, 'refs does not name the landed record');
      assert.equal((await coll('facts').findOne({ _id: seeded._id })).fact, 'converged', 'the converge did not land');
    });

    it('a `$ref` edge planned after a flush boundary is refused when its record loses twice, and refs holds no key for it', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const log = observe();
      const res = await raceBatch(SPACE, afterBoundary(seeded._id), [move(SPACE, seeded._id, 'one'), move(SPACE, seeded._id, 'two')]);
      assert.equal(log.filter(n => n === `${SPACE}_entities`).length, 2, `no flush boundary: ${JSON.stringify(log)}`);
      const edges = await edgesStored();
      assert.equal(edges.length, 0, `an edge of a record that never landed was stored: ${JSON.stringify(edges)}`);
      const conflict = new types.WriteConflict('fact', seeded._id).message;
      assert.ok(res.errors.some(e => e.type === 'fact' && e.reason === conflict), `no conflict row for the fact: ${JSON.stringify(res.errors)}`);
      const edgeRow = res.errors.find(e => e.type === 'edge');
      assert.ok(edgeRow, `no row for the refused edge: ${JSON.stringify(res.errors)}`);
      assert.ok(edgeRow.reason.includes(conflict), `the edge row does not carry the record's conflict: ${edgeRow.reason}`);
      assert.ok(!('k1' in res.refs), `refs names a record that was not written: ${JSON.stringify(res.refs)}`);
    });

    it('a converge whose record another request deletes while it is parked is re-planned as an insert, and its inline edge follows the new id', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, inline(seeded._id), [remove(seeded._id)]);
      assert.deepEqual(res.errors, [], `the batch reported rows: ${JSON.stringify(res.errors)}`);
      const facts = await coll('facts').find({}).toArray();
      assert.equal(facts.length, 1, `expected the re-planned insert only, found ${facts.length} facts`);
      assert.notEqual(facts[0]._id, seeded._id, 'the re-plan did not mint a new record');
      const edges = await edgesStored();
      assert.equal(edges.length, 1, `expected one stored edge, found ${edges.length}`);
      assert.equal(edges[0].from, facts[0]._id, 'the edge hangs off the deleted record, not the new one');
      assert.equal(res.refs.k1?.id, facts[0]._id, 'refs does not name the new record');
      assert.equal(res.inserted.facts, 1, 'the re-planned insert is not counted as inserted');
      assert.equal(res.updated.facts, 0, 'the first plan\'s converge count was kept');
    });

    it('a converge whose record is deleted while it is parked is re-planned as an insert, and a `$ref` edge after a boundary follows the new id', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, afterBoundary(seeded._id), [remove(seeded._id)]);
      assert.deepEqual(res.errors, [], `the batch reported rows: ${JSON.stringify(res.errors)}`);
      const facts = await coll('facts').find({}).toArray();
      assert.equal(facts.length, 1, `expected the re-planned insert only, found ${facts.length} facts`);
      assert.notEqual(facts[0]._id, seeded._id, 'the re-plan did not mint a new record');
      const edges = await edgesStored();
      assert.equal(edges.length, 1, `expected one stored edge, found ${edges.length}`);
      assert.equal(edges[0].from, facts[0]._id, 'the edge hangs off the deleted record, not the new one');
      assert.equal(res.refs.k1?.id, facts[0]._id, 'refs does not name the new record');
      assert.equal(res.inserted.facts, 1, 'the re-planned insert is not counted as inserted');
    });

    it('an edge whose `to` end loses once is stored on the landed record', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, toEnd(seeded._id), [move(SPACE, seeded._id, 'one')]);
      assert.deepEqual(res.errors, [], `the batch reported rows: ${JSON.stringify(res.errors)}`);
      const edges = await edgesStored();
      assert.equal(edges.length, 1, `expected one stored edge, found ${edges.length}`);
      assert.equal(edges[0].from, ALICE);
      assert.equal(edges[0].to, seeded._id);
    });

    it('an edge whose `to` end loses twice is refused with that end\'s conflict, and is not stored', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await seedFact();
      const res = await raceBatch(SPACE, toEnd(seeded._id), [move(SPACE, seeded._id, 'one'), move(SPACE, seeded._id, 'two')]);
      const conflict = new types.WriteConflict('fact', seeded._id).message;
      const edgeRow = res.errors.find(e => e.type === 'edge');
      assert.ok(edgeRow, `no row for the refused edge: ${JSON.stringify(res.errors)}`);
      assert.ok(edgeRow.reason.startsWith(DEPENDENCY) && edgeRow.reason.includes(conflict), `the edge row is not the dependency refusal carrying the conflict: ${edgeRow.reason}`);
      assert.equal((await edgesStored()).length, 0, 'an edge of a record that never landed was stored');
    });

    it('an edge between two racing records, one losing twice, is refused naming the end that failed', { timeout: HOLD_TIMEOUT }, async () => {
      const one = await seedFact('one original');
      const two = await seedFact('two original');
      // Both lose the batch's commit; the first lands on its re-plan, the second loses that too.
      const res = await raceBatch(SPACE, bothEnds(one._id, two._id), [
        moveAll(SPACE, [one._id, two._id], 'one'), nothing, move(SPACE, two._id, 'two'),
      ]);
      const conflict = new types.WriteConflict('fact', two._id).message;
      const edgeRow = res.errors.find(e => e.type === 'edge');
      assert.ok(edgeRow, `no row for the refused edge: ${JSON.stringify(res.errors)}`);
      assert.ok(edgeRow.reason.startsWith(DEPENDENCY) && edgeRow.reason.includes(conflict), `the edge row does not carry the failed end's conflict: ${edgeRow.reason}`);
      assert.equal((await edgesStored()).length, 0, 'an edge with an unwritten end was stored');
      assert.equal((await coll('facts').findOne({ _id: one._id })).fact, 'one converged', 'the end that lost once did not land');
      assert.equal((await coll('facts').findOne({ _id: two._id })).fact, 'two original', 'the end that lost twice was written');
      assert.equal(res.refs.k1?.id, one._id);
      assert.ok(!('k2' in res.refs), `refs names the end that was not written: ${JSON.stringify(res.refs)}`);
    });

    it('an edge between two records that both fail names the FIRST failed end, from before to', { timeout: HOLD_TIMEOUT }, async () => {
      const one = await seedFact('one original');
      const two = await seedFact('two original');
      const res = await raceBatch(SPACE, bothEnds(one._id, two._id), [
        moveAll(SPACE, [one._id, two._id], 'one'), move(SPACE, one._id, 'two'), move(SPACE, two._id, 'two'),
      ]);
      const first = new types.WriteConflict('fact', one._id).message;
      const edgeRow = res.errors.find(e => e.type === 'edge');
      assert.ok(edgeRow, `no row for the refused edge: ${JSON.stringify(res.errors)}`);
      assert.ok(edgeRow.reason.startsWith(DEPENDENCY) && edgeRow.reason.includes(first), `the edge row does not name the \`from\` end's failure: ${edgeRow.reason}`);
      assert.ok(!edgeRow.reason.includes(two._id), `the edge row names the \`to\` end although \`from\` failed first: ${edgeRow.reason}`);
      assert.equal((await edgesStored()).length, 0);
    });

    it('a re-plan in a warn space says each schema warning of the item once, not once per plan', { timeout: HOLD_TIMEOUT }, async () => {
      const seeded = await fact.saveFact(WARN_SPACE, 'the original text', [], ['seed']);
      const res = await raceBatch(
        WARN_SPACE,
        { facts: [{ id: seeded._id, fact: 'converged', type: 'claim', properties: { confidence: 'high' } }] },
        [move(WARN_SPACE, seeded._id, 'one')],
      );
      const stored = await mongo.col(`${WARN_SPACE}_facts`).findOne({ _id: seeded._id });
      assert.equal(stored.fact, 'converged', 'the converge did not land');
      const warnings = res.errors.filter(e => e.type === 'fact' && e.index === 0 && e.reason.startsWith('schema_warning'));
      assert.equal(warnings.length, 1, `the item's warning was said ${warnings.length} times: ${JSON.stringify(res.errors)}`);
    });
  });
});

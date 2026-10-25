/**
 * A fork edge sits BESIDE its subject, outside the one slot an edge's identity holds (Q-624, design rev 4 sections M2, 4, 5 and 6,
 * test 4 of section 16).
 *
 * ## The rule
 *
 * An edge's identity is `(from, to, label, fromKind, toKind)` and one unique index holds it. A fork of an edge carries the SAME five
 * fields as its subject (it is the other peer's version of that relationship), so the index must not count it: it is PARTIAL, over
 * rows whose `forkOf` is null or absent. What follows, each held here on the doors that reach it:
 *
 * - **the index** of a space this code creates is that partial one, and no unique five-field index without the filter stands beside it;
 * - **a fork beside its subject** is stored on both push doors: two rows, one identity, the subject the only non-fork;
 * - **a second NON-fork is still refused**, by the store itself (an insert) and by the planner (a push), fork or no fork present;
 * - **`forkOf: ''` is refused**: an empty string escapes the partial filter (`forkOf: ''` is not null), so the schema keeps `.min(1)`
 *   and a row carrying one is a schema refusal, never a stored second holder of the identity;
 * - **a presence flip is `invalidFork`, never `rejected`**: an edge arrival whose `forkOf` presence differs from the stored copy's
 *   (a subject that becomes a fork, a fork that becomes a subject) is a malformed fork, counted and answered as such
 *   (`invalidFork` in the batch stats, `400 invalid_fork` with the id on the single door), and nothing is written;
 * - **the identity readers reach the subject**: `findEdgeByTriplet` and `upsertEdge` read through the clause that names
 *   `forkOf: null`, so a fork that sorts first, or is newer, is never the edge they find or update;
 * - **a strict functional label still takes its subject's update**: the subject count ignores the fork, so a fork under a functional
 *   label is not a second edge from the subject and the subject's own update is not refused.
 *
 * ## Seen red
 *
 * On the base (b857da8f) the index is the full unique one, so a fork edge cannot be stored beside its subject (E11000) and an edge
 * never forks at an equal seq; the batch answer has no `invalidFork`; an `forkOf` is stripped by the edge schema.
 *
 * Run: node --test testing/standalone/a-fork-edge-stays-out-of-the-identity-slot-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { forkIdOf } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();

const S = 'q624t2slot';
const SUBJECT = 'e-subject';
const END = { from: 'ent-a', to: 'ent-b', label: 'knows' };
const FUNCTIONAL = 'reports_to';
const META = { validationMode: 'strict', typeSchemas: { edge: { [FUNCTIONAL]: { functional: true } } } };
const IDENTITY = ['from', 'to', 'label', 'fromKind', 'toKind'];

let door, edges;

/** An edge document of the identity under test; `description` is the body field two copies differ in. */
const edge = (id, seq, description, extra = {}) => build.edge(S, id, seq, { ...END, description, ...extra });
const stored = () => door.coll(S, 'edges').find({}).sort({ _id: 1 }).toArray();
const holders = async () => (await stored()).filter(d => d.forkOf === undefined || d.forkOf === null);

/** Seed a fork row directly. A store whose identity index counts forks says so here, as the reason, instead of as an E11000 nobody explains. */
async function seedFork(row) {
  try { await door.coll(S, 'edges').insertOne(row); } catch (err) {
    if (err?.code === 11000) assert.fail(`a fork edge cannot be stored beside its subject: the identity index counts it (${err.message}). It must be partial over { forkOf: null } (design M2)`);
    throw err;
  }
}

describe('a fork edge stays out of the identity slot (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'q624t2_slot', spaces: [{ id: S, label: 'Slot', folders: [], meta: META }] });
    edges = await import('../../server/dist/brain/edges.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  const single = (doc) => door.push('/edges', doc, { spaceId: S });
  const batch = (...docs) => door.push('/batch-upsert', { edges: docs }, { spaceId: S });

  it('the identity index a space is created with is the partial one, and no unique five-field index stands without the filter', async () => {
    const indexes = await door.coll(S, 'edges').indexes();
    const fiveKey = indexes.filter(ix => IDENTITY.every(k => k in ix.key) && Object.keys(ix.key).length === IDENTITY.length);
    const partial = fiveKey.filter(ix => ix.unique && JSON.stringify(ix.partialFilterExpression) === JSON.stringify({ forkOf: null }));
    const bare = fiveKey.filter(ix => ix.unique && ix.partialFilterExpression === undefined);
    assert.equal(partial.length, 1, `expected one unique five-field index with partialFilterExpression { forkOf: null }: ${JSON.stringify(fiveKey)}`);
    assert.deepEqual(bare, [], 'a unique five-field index without partialFilterExpression stands: it counts fork rows');
  });

  for (const [via, send] of [['single', single], ['batch', batch]]) {
    it(`${via}: an equal-seq divergent copy is stored as a fork BESIDE its subject, with the subject's five identity fields`, async () => {
      await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
      await send(edge(SUBJECT, 5, 'theirs'));
      const rows = await stored();
      const forks = rows.filter(d => d.forkOf === SUBJECT);
      assert.equal(forks.length, 1, `rows after the push: ${JSON.stringify(rows.map(d => [d._id, d.forkOf, d.description]))}`);
      assert.deepEqual(IDENTITY.map(k => forks[0][k]), IDENTITY.map(k => rows.find(d => d._id === SUBJECT)[k]), 'the fork does not carry its subject\'s identity');
      assert.equal(forks[0].description, 'theirs');
      assert.deepEqual((await holders()).map(d => d._id), [SUBJECT], 'the subject is not the one holder of the identity');
      assert.equal((await door.coll(S, 'edges').findOne({ _id: SUBJECT })).description, 'mine');
    });
  }

  it('a second NON-fork holder of the identity is refused by the store, with a fork standing beside the subject', async () => {
    await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
    await seedFork({ ...edge(await forkIdOf('edges', SUBJECT, 5, edge(SUBJECT, 5, 'theirs')), 5, 'theirs'), forkOf: SUBJECT });
    await assert.rejects(door.coll(S, 'edges').insertOne(edge('e-second', 6, 'another holder')),
      (err) => err?.code === 11000, 'a second row holding the identity was stored: the index does not hold it while a fork exists');
  });

  it('batch: a second NON-fork under another id is a duplicate triplet and is not stored, with a fork beside the subject', async () => {
    await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
    await seedFork({ ...edge(await forkIdOf('edges', SUBJECT, 5, edge(SUBJECT, 5, 'theirs')), 5, 'theirs'), forkOf: SUBJECT });
    const r = await batch(edge('e-second', 6, 'another holder'));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.edges.duplicateTriplets, 1, JSON.stringify(r.body.edges));
    assert.deepEqual((await holders()).map(d => d._id), [SUBJECT]);
  });

  it('a row with forkOf "" is a schema refusal, never a stored second holder of the identity', async () => {
    await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
    const r = await batch(edge('e-empty', 6, 'x', { forkOf: '' }));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.edges.rejected, 1, `forkOf '' must be refused by the schema (.min(1)): ${JSON.stringify(r.body.edges)}`);
    assert.equal(r.body.edges.duplicateTriplets, 0, 'the empty-forkOf row reached the identity check: it is not a schema refusal');
    assert.equal(await door.coll(S, 'edges').countDocuments({ _id: 'e-empty' }), 0);
    const one = await single(edge('e-empty', 6, 'x', { forkOf: '' }));
    assert.equal(one.code, 400, JSON.stringify(one.body));
  });

  describe('a presence flip of forkOf is invalidFork, never rejected', () => {
    it('batch: a stored subject that arrives as a fork', async () => {
      await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
      const r = await batch(edge(SUBJECT, 6, 'mine', { forkOf: 'someone-else' }));
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(r.body.edges.invalidFork, 1, JSON.stringify(r.body.edges));
      assert.equal(r.body.edges.rejected, 0, `a malformed fork is counted as invalidFork, not folded into rejected: ${JSON.stringify(r.body.edges)}`);
      assert.deepEqual([(await door.coll(S, 'edges').findOne({ _id: SUBJECT })).seq, (await stored()).length], [5, 1], 'something was written');
    });

    it('batch: a stored fork that arrives as a subject', async () => {
      await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
      const forkId = await forkIdOf('edges', SUBJECT, 5, edge(SUBJECT, 5, 'theirs'));
      await seedFork({ ...edge(forkId, 5, 'theirs'), forkOf: SUBJECT });
      const r = await batch(edge(forkId, 6, 'theirs'));
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(r.body.edges.invalidFork, 1, JSON.stringify(r.body.edges));
      assert.equal(r.body.edges.rejected, 0, JSON.stringify(r.body.edges));
      assert.equal((await door.coll(S, 'edges').findOne({ _id: forkId })).forkOf, SUBJECT, 'the stored fork lost its forkOf');
    });

    it('single: the same two flips answer 400 invalid_fork, naming the id', async () => {
      await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
      const asFork = await single(edge(SUBJECT, 6, 'mine', { forkOf: 'someone-else' }));
      assert.deepEqual([asFork.code, asFork.body?.code, asFork.body?.id], [400, 'invalid_fork', SUBJECT], JSON.stringify(asFork.body));
      const forkId = await forkIdOf('edges', SUBJECT, 5, edge(SUBJECT, 5, 'theirs'));
      await seedFork({ ...edge(forkId, 5, 'theirs'), forkOf: SUBJECT });
      const asSubject = await single(edge(forkId, 6, 'theirs'));
      assert.deepEqual([asSubject.code, asSubject.body?.code, asSubject.body?.id], [400, 'invalid_fork', forkId], JSON.stringify(asSubject.body));
    });
  });

  describe('the identity readers reach the subject, never a fork that sorts first or is newer', () => {
    /**
     * A fork whose id sorts BEFORE the subject's, whose seq is above it, and which is STORED first: the row a reader with no clause
     * finds first by every order it could use (natural, id, version). The subject goes in after it.
     */
    const seedEarlyNewFork = async () => {
      await seedFork({ ...edge('0-early-fork', 9, 'theirs'), forkOf: SUBJECT });
      await door.coll(S, 'edges').insertOne(edge(SUBJECT, 5, 'mine'));
    };

    it('findEdgeByTriplet answers the subject', async () => {
      await seedEarlyNewFork();
      const found = await edges.findEdgeByTriplet(S, END.from, END.to, END.label);
      assert.equal(found?._id, SUBJECT, `found ${JSON.stringify(found && [found._id, found.forkOf])}`);
    });

    it('upsertEdge updates the subject: no new row, the fork untouched', async () => {
      await seedEarlyNewFork();
      await edges.upsertEdge(S, END.from, END.to, END.label, undefined, undefined, 'edited');
      const rows = await stored();
      assert.equal(rows.length, 2, `rows: ${JSON.stringify(rows.map(d => [d._id, d.forkOf, d.description]))}`);
      assert.equal(rows.find(d => d._id === SUBJECT).description, 'edited');
      assert.equal(rows.find(d => d._id === '0-early-fork').description, 'theirs');
    });
  });

  describe('a strict functional label still takes its subject\'s update', () => {
    it('a fork under the label is not a second edge from the subject', async () => {
      // Strict validation refuses a far end that names nothing, so the three endpoints exist as entities.
      await door.coll(S, 'entities').insertMany(['employee', 'manager-1', 'manager-2'].map(id => build.entity(S, id, 3)));
      // The fork is stored FIRST, so a count or a lookup with no clause meets it before the subject. The subject's id is the derived one.
      const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
      const subjectId = edgeIdFor('employee', 'manager-1', FUNCTIONAL, undefined, undefined);
      await seedFork({ ...build.edge(S, '0-functional-fork', 3, { from: 'employee', to: 'manager-1', label: FUNCTIONAL, description: 'a peer\'s version' }), forkOf: subjectId });
      const first = await edges.upsertEdge(S, 'employee', 'manager-1', FUNCTIONAL, undefined, undefined, 'v1');
      assert.equal(first._id, subjectId, 'fixture check: the subject was written under another id than the derived one');
      const again = await edges.upsertEdge(S, 'employee', 'manager-1', FUNCTIONAL, undefined, undefined, 'v2');
      assert.equal(again._id, first._id, 'the update of the subject went to another row');
      const rows = await stored();
      assert.deepEqual(rows.map(d => [d._id, d.description]).sort(), [[first._id, 'v2'], ['0-functional-fork', 'a peer\'s version']].sort());
      await assert.rejects(edges.upsertEdge(S, 'employee', 'manager-2', FUNCTIONAL),
        /reports_to|functional|already/i, 'a different target under a functional label was not refused: the control is broken');
    });
  });
});

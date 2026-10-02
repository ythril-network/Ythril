/**
 * When a pushed document's WRITE fails, the push door keeps what it must: the deletion it has not yet
 * superseded, the rest of the page, and a 500 only for a fault that may be transient (`Q-107` part 1 §1, §2).
 *
 * Every fault here is REAL — a `$jsonSchema` validator on the collection, a view where the collection should
 * be, the space's own unique indexes — never a hand-built error object, because a hand-built error has whatever
 * shape its author believed the driver produces, and the classification of that shape is what is under test.
 *
 * ## The four rules
 *
 * 1. **A stale tombstone is deleted only when its record LANDS.** The base deletes it first and then writes;
 *    a write that fails leaves the deletion gone and the record absent — and the next push of an older copy of
 *    the record, which the tombstone would have refused, is accepted.
 * 2. **A deterministic per-document fault does not cost the rest of the page, and the door answers as 5.6.1 did.**
 *    On 5.6.1 a page is applied in order, so one document the store rejects (here: a validator) stopped the page
 *    there: the records after it were never written, and the page answered 500. Main counts that document in
 *    `rejected` and answers 200 (and a 400 on the single routes); 5.6.x does NOT (cut `C3` of the 5.6.2 plan —
 *    a new `rejected` cause and a new status are contract changes a 5.6.1 peer and integrator never agreed to).
 *    So on 5.6.x: the REST of the page is written, the door still answers 500, and a re-send of the same page is
 *    idempotent (same stored set, same answer). The single routes answer 5.6.1's status for the same fault,
 *    which is the route's 500 `Internal error`, read from 5.6.1 and pinned here.
 * 3. **A fault with no per-document shape still answers 500.** A command-level failure (here: the collection is
 *    a view) may be transient, and a 500 is what keeps the sender's watermark so the page is offered again.
 * 4. **A unique-index duplicate is an outcome, not a fault.** An edge UPDATE that would move onto a triplet that
 *    already exists is `duplicateTriplets` (or `duplicate` on the single route); a link arriving under another id
 *    for endpoints already linked is the same link — `skipped`, never a 500. The link case is batch-only because
 *    links have no single-record route: they arrive only through `batch-upsert`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-write-failure-keeps-what-it-must-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

/** Records here refuse the text 'POISON' through a real validator, one per family a single route stores. */
const GUARDED = 'pushfault';
/** The collection of each single push route, and the field its validator refuses 'POISON' in. */
const POISONED_FIELD = { facts: 'fact', entities: 'name', edges: 'label', chrono: 'title' };
/** Each single route, the document builder it takes, and the collection it stores into. */
const SINGLE = [
  { route: '/facts', kind: 'fact', part: 'facts' },
  { route: '/entities', kind: 'entity', part: 'entities' },
  { route: '/edges', kind: 'edge', part: 'edges' },
  { route: '/chrono', kind: 'chrono', part: 'chrono' },
];
/** Facts here are a VIEW: every write fails at the command level, with no per-document shape. */
const VIEWED = 'pushview';
const PLAIN = 'pushdup';

let door;

describe('a push write failure keeps what it must', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushfault', spaces: [GUARDED, VIEWED, PLAIN].map(id => ({ id, label: id, folders: [], meta: {} })) });
    const db = door.mongo.getDb();
    // One validator per family a SINGLE route stores, each refusing the text 'POISON' in a field it requires.
    for (const [part, field] of Object.entries(POISONED_FIELD)) {
      await db.command({
        collMod: `${GUARDED}_${part}`,
        validator: { $jsonSchema: { properties: { [field]: { not: { enum: ['POISON'] } } } } },
        validationLevel: 'strict', validationAction: 'error',
      });
    }
    await db.collection(`${VIEWED}_facts`).drop();
    await db.createCollection(`${VIEWED}_facts`, { viewOn: `${VIEWED}_entities`, pipeline: [] });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { for (const s of [GUARDED, PLAIN]) await door.wipe(s); });

  it('the faults are real: the validator refuses POISON and the view refuses every write', async () => {
    await assert.rejects(door.coll(GUARDED, 'facts').insertOne(build.fact(GUARDED, 'probe', 1, { fact: 'POISON' })), /validation/i);
    await assert.rejects(door.coll(VIEWED, 'facts').insertOne(build.fact(VIEWED, 'probe', 1)), /view/i);
  });

  describe('1. a stale tombstone survives a failed record write', () => {
    for (const [label, send] of [
      ['single /facts', () => door.push('/facts', build.fact(GUARDED, 'f', 7, { fact: 'POISON' }), { spaceId: GUARDED })],
      ['batch-upsert', () => door.push('/batch-upsert', { facts: [build.fact(GUARDED, 'f', 7, { fact: 'POISON' })] }, { spaceId: GUARDED })],
    ]) {
      it(label, async () => {
        await door.coll(GUARDED, 'tombstones').insertOne(build.tombstone(GUARDED, 'f', 'fact', 3));
        await send();
        assert.equal(await door.coll(GUARDED, 'facts').countDocuments({ _id: 'f' }), 0, 'the poison record was stored');
        assert.equal(await door.coll(GUARDED, 'tombstones').countDocuments({ _id: 'f' }), 1,
          `${label}: the tombstone was deleted before a record write that then failed. The record is absent AND its `
          + 'deletion is gone, so an older copy of the record arriving next is accepted instead of refused');
      });
    }
  });

  describe('2. a deterministic per-document fault: the rest of the page lands, the door answers as 5.6.1 (C3)', () => {
    it('batch-upsert: [good, POISON, good] answers 500 (C3: as 5.6.1, no rejected count) with BOTH good facts written', async () => {
      const r = await door.push('/batch-upsert', { facts: [
        build.fact(GUARDED, 'good-1', 4), build.fact(GUARDED, 'bad', 5, { fact: 'POISON' }), build.fact(GUARDED, 'good-2', 6),
      ] }, { spaceId: GUARDED });
      assert.deepEqual([r.code, r.body], [500, { error: 'Internal error' }],
        `a page holding a document the store refuses answered ${r.code} ${JSON.stringify(r.body)}; 5.6.1 answers 500 `
        + 'Internal error and 5.6.x keeps that answer (C3: main\'s 200 with the poison counted in `rejected` is cut)');
      assert.deepEqual((await door.coll(GUARDED, 'facts').find({}).toArray()).map(d => d._id).sort(), ['good-1', 'good-2'],
        'the records AFTER the poison document were never written: one refused document cost the rest of its page, '
        + 'and the sender re-sends that page every cycle with the same result');
    });

    /*
     * The single-route half, pinned to 5.6.1's answer. A store refusal on a single route reached the route's catch
     * on 5.6.1 and answered 500 `Internal error`; main answers a 400 naming the refusal. That new status is cut from
     * 5.6.x (C3), so each route is asked and must answer as 5.6.1 did, storing nothing.
     */
    for (const { route, kind, part } of SINGLE) {
      it(`single ${route}: a POISON document answers 5.6.1's 500, not main's 400, and stores nothing (C3)`, async () => {
        const doc = build[kind](GUARDED, `poison-${kind}`, 5, { [POISONED_FIELD[part]]: 'POISON' });
        const r = await door.push(route, doc, { spaceId: GUARDED });
        assert.deepEqual([r.code, r.body], [500, { error: 'Internal error' }],
          `a document the store refuses answered ${r.code} ${JSON.stringify(r.body)} on POST ${route}; 5.6.1 answers `
          + '500 Internal error, and the 5.6.x patch keeps every door\'s answer (C3)');
        assert.equal(await door.coll(GUARDED, part).countDocuments({ _id: doc._id }), 0, `POST ${route} stored the poison`);
      });
    }

    it('the same page re-sent answers the same and stores the same: a re-send is idempotent', async () => {
      const page = { facts: [build.fact(GUARDED, 'good-1', 4), build.fact(GUARDED, 'bad', 5, { fact: 'POISON' }),
        build.fact(GUARDED, 'good-2', 6)] };
      const a = await door.push('/batch-upsert', page, { spaceId: GUARDED });
      const first = (await door.coll(GUARDED, 'facts').find({}).toArray()).map(d => `${d._id}@${d.seq}`).sort();
      const b = await door.push('/batch-upsert', page, { spaceId: GUARDED });
      const second = (await door.coll(GUARDED, 'facts').find({}).toArray()).map(d => `${d._id}@${d.seq}`).sort();
      assert.deepEqual([a.code, b.code], [500, 500], `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`);
      assert.deepEqual(second, first, 'a re-sent page changed what is stored');
      assert.deepEqual(second, ['good-1@4', 'good-2@6'], 'the re-send did not leave the rest of the page written');
    });
  });

  describe('3. a fault with no per-document shape answers 500', () => {
    it('single /facts into a view answers 500', async () => {
      const r = await door.push('/facts', build.fact(VIEWED, 'f', 3), { spaceId: VIEWED });
      assert.equal(r.code, 500, JSON.stringify(r.body));
    });
    it('batch-upsert into a view answers 500, so the sender keeps its watermark', async () => {
      const r = await door.push('/batch-upsert', { facts: [build.fact(VIEWED, 'f', 3), build.fact(VIEWED, 'g', 4)] }, { spaceId: VIEWED });
      assert.equal(r.code, 500, JSON.stringify(r.body));
    });
  });

  describe('4. a unique-index duplicate is an outcome, never a 500', () => {
    async function twoEdges() {
      await door.coll(PLAIN, 'edges').insertMany([
        build.edge(PLAIN, 'g1', 5, { from: 'A', to: 'B', label: 'knows' }),
        build.edge(PLAIN, 'g2', 5, { from: 'A', to: 'B', label: 'likes' }),
      ]);
    }
    it('single /edges: an UPDATE moving onto an existing triplet answers duplicate and keeps both local copies', async () => {
      await twoEdges();
      const r = await door.push('/edges', build.edge(PLAIN, 'g2', 6, { from: 'A', to: 'B', label: 'knows' }), { spaceId: PLAIN });
      assert.deepEqual([r.code, r.body.status], [200, 'duplicate'], JSON.stringify(r.body));
      assert.equal((await door.coll(PLAIN, 'edges').findOne({ _id: 'g2' })).label, 'likes');
    });
    it('batch-upsert: the same update counts duplicateTriplets, not upserted or skipped', async () => {
      await twoEdges();
      const r = await door.push('/batch-upsert', { edges: [build.edge(PLAIN, 'g2', 6, { from: 'A', to: 'B', label: 'knows' })] }, { spaceId: PLAIN });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.edges.duplicateTriplets, r.body.edges.upserted, r.body.edges.skipped], [1, 0, 0], JSON.stringify(r.body.edges));
      assert.equal((await door.coll(PLAIN, 'edges').findOne({ _id: 'g2' })).label, 'likes');
    });
    it('batch-upsert: a link under another id for endpoints already linked is skipped, never a 500', async () => {
      const ends = { from: 'X', fromKind: 'fact', to: 'Y', toKind: 'entity' };
      await door.coll(PLAIN, 'links').insertOne(build.link(PLAIN, 'l1', 5, ends));
      const r = await door.push('/batch-upsert', { links: [build.link(PLAIN, 'l2', 6, ends)] }, { spaceId: PLAIN });
      assert.equal(r.code, 200,
        `a duplicate link answered ${r.code} (${JSON.stringify(r.body)}): the sender re-sends that page for ever and the `
        + 'links channel to this instance never advances again');
      assert.deepEqual([r.body.links.skipped, r.body.links.upserted], [1, 0], JSON.stringify(r.body.links));
      assert.equal(await door.coll(PLAIN, 'links').countDocuments({}), 1);
    });
  });
});

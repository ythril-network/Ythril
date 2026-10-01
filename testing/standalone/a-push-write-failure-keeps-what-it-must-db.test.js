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
 * 2. **A deterministic per-document fault refuses that document, not the page.** One document the store rejects
 *    (here: a validator) answered 500 for the whole page, so the sender held its watermark and re-sent the same
 *    page for ever — every other record in it stuck behind one. It is counted in `rejected` instead.
 * 3. **A fault with no per-document shape still answers 500.** A command-level failure (here: the collection is
 *    a view) may be transient, and a 500 is what keeps the sender's watermark so the page is offered again.
 * 4. **A unique-index duplicate is an outcome, not a fault.** An edge UPDATE that would move onto a triplet that
 *    already exists is `duplicateTriplets` (or `duplicate` on the single route); a link arriving under another id
 *    for endpoints already linked is the same link — `skipped`, never a 500.
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

/** Facts here refuse the text 'POISON' through a real validator. */
const GUARDED = 'pushfault';
/** Facts here are a VIEW: every write fails at the command level, with no per-document shape. */
const VIEWED = 'pushview';
const PLAIN = 'pushdup';

let door;

describe('a push write failure keeps what it must', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushfault', spaces: [GUARDED, VIEWED, PLAIN].map(id => ({ id, label: id, folders: [], meta: {} })) });
    const db = door.mongo.getDb();
    await db.command({
      collMod: `${GUARDED}_facts`,
      validator: { $jsonSchema: { properties: { fact: { not: { enum: ['POISON'] } } } } },
      validationLevel: 'strict', validationAction: 'error',
    });
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

  describe('2. a deterministic per-document fault refuses that document, not the page', () => {
    it('batch-upsert: [good, POISON, good] stores both good facts, answers 200 and counts the poison rejected', async () => {
      const r = await door.push('/batch-upsert', { facts: [
        build.fact(GUARDED, 'good-1', 4), build.fact(GUARDED, 'bad', 5, { fact: 'POISON' }), build.fact(GUARDED, 'good-2', 6),
      ] }, { spaceId: GUARDED });
      assert.equal(r.code, 200,
        `one document the store refuses answered ${r.code} for the whole page (${JSON.stringify(r.body)}). The sender `
        + 'holds its watermark and re-sends the identical page every cycle, so every record in it waits for ever behind one');
      assert.deepEqual([r.body.facts.inserted, r.body.facts.rejected], [2, 1], JSON.stringify(r.body.facts));
      assert.deepEqual((await door.coll(GUARDED, 'facts').find({}).toArray()).map(d => d._id).sort(), ['good-1', 'good-2']);
    });

    it('the same page re-sent answers the same: the refusal is deterministic, not a retry', async () => {
      const page = { facts: [build.fact(GUARDED, 'good-1', 4), build.fact(GUARDED, 'bad', 5, { fact: 'POISON' })] };
      const a = await door.push('/batch-upsert', page, { spaceId: GUARDED });
      const b = await door.push('/batch-upsert', page, { spaceId: GUARDED });
      assert.deepEqual([a.code, b.code], [200, 200], `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`);
      assert.equal(b.body.facts.rejected, 1);
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

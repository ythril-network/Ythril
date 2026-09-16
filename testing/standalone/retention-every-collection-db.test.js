/**
 * Database-level test: a schema retention window reaches entities, memories and edges — not only chrono.
 *
 * This is the assertion that would have FAILED before the fix, and the reason the existing 30 unit cases plus
 * 11 DB cases all passed while the feature did nothing outside chrono: they all supply `collection` themselves.
 * Nothing exercised the three collections whose callers never supplied it.
 *
 * Covers what only the driver can settle:
 *
 *  - the backfill query matches on the right FIELD per collection — `label` for edges, `type` for the rest.
 *    A `type` filter on an edge matches nothing and the pass would report a clean zero;
 *  - each collection's records are stamped from their own `createdAt`, in their own collection name
 *    (`<space>_entities`, not `<space>_entity`);
 *  - `contentDays` is not stamped outside chrono even when a type declares it, because no sweep implements it
 *    there and a `_contentExpireAt` nothing reads is a lie in the data;
 *  - files are untouched: no type, so no schema window.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/retention-every-collection-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
/*
 * The knowledge types and their collections come from the source that DEFINES them.
 *
 * This file's title says every typed collection, and three of its cases read a list written here -- which is
 * how a fourth collection can be added and reported on by nothing. The case below that leaves an unpoliced
 * type alone read entity, memory and edge, and never chrono.
 */
import { KNOWLEDGE_TYPES, RECORD_COLLECTION } from '../../server/dist/config/types-knowledge.js';

const skip = await mongoSkipReason();

const SPACE = 'mixed';
const DAY = 86_400_000;

let mongo, backfillTypedExpiry, policedTypes;

/**
 * A window on one type in each typed collection — the canary's actual shape: a space holds ticket entities that
 * must outlive their status-change chronos.
 *
 * `edge.depends-on` is keyed by LABEL, which is the trap: an edge document has both `label` and `type`.
 */
const POLICY = {
  meta: {
    typeSchemas: {
      entity: { ticket: { retention: { days: 365 } } },
      fact: { note: { retention: { days: 30 } } },
      edge:   { 'depends-on': { retention: { days: 60 } } },
      chrono: { event: { retention: { days: 90, contentDays: 14 } } },
    },
  },
};

/** A window with `contentDays` on a NON-chrono type — accepted by the API, implemented by no sweep. */
const CONTENT_OUTSIDE_CHRONO = {
  meta: { typeSchemas: { entity: { ticket: { retention: { days: 365, contentDays: 30 } } } } },
};

const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

const base = (id, createdAt) => ({
  _id: id, spaceId: SPACE, createdAt, updatedAt: createdAt, seq: 1, author: { instanceId: 'self' },
});

const docs = {
  entities: (id, type, createdAt) => ({ ...base(id, createdAt), name: id, type, tags: [] }),
  facts: (id, type, createdAt) => ({ ...base(id, createdAt), fact: `fact ${id}`, type, tags: [], entityIds: [] }),
  // `label` is the schema key; `type` is set to something DIFFERENT on purpose, so a resolver reading the wrong
  // field cannot accidentally pass.
  edges:    (id, label, createdAt) => ({ ...base(id, createdAt), from: 'a', to: 'b', label, type: 'unrelated', tags: [] }),
  chrono:   (id, type, createdAt) => ({ ...base(id, createdAt), type, title: id, startsAt: createdAt, status: 'done', tags: [], entityIds: [], memoryIds: [] }),
};

const load = (coll, id) => mongo.col(`${SPACE}_${coll}`).findOne({ _id: id });

describe('schema retention reaches every typed collection (real MongoDB)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('retentionevery');
    ({ backfillTypedExpiry, policedTypes } = await import('../../server/dist/brain/chrono-redaction.js'));
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => {
    for (const c of Object.values(RECORD_COLLECTION)) {
      await mongo.col(`${SPACE}_${c}`).deleteMany({});
    }
  });

  it('finds the policed types in each collection', () => {
    assert.deepEqual(policedTypes(POLICY, 'entity'), ['ticket']);
    assert.deepEqual(policedTypes(POLICY, 'fact'), ['note']);
    assert.deepEqual(policedTypes(POLICY, 'edge'), ['depends-on']);
    assert.deepEqual(policedTypes(POLICY, 'chrono'), ['event']);
  });

  it('stamps an ENTITY from its own createdAt — the documented example that did nothing', async () => {
    const created = ago(100);
    await mongo.col(`${SPACE}_entities`).insertOne(docs.entities('t-1', 'ticket', created));

    assert.equal(await backfillTypedExpiry(SPACE, POLICY, 'entity'), 1);
    const doc = await load('entities', 't-1');
    assert.equal(doc._expireAt.getTime(), Date.parse(created) + 365 * DAY);
  });

  it('stamps a MEMORY', async () => {
    const created = ago(10);
    await mongo.col(`${SPACE}_facts`).insertOne(docs.facts('m-1', 'note', created));

    assert.equal(await backfillTypedExpiry(SPACE, POLICY, 'fact'), 1);
    assert.equal((await load('facts', 'm-1'))._expireAt.getTime(), Date.parse(created) + 30 * DAY);
  });

  it('stamps an EDGE by its label, not its type', async () => {
    const created = ago(5);
    await mongo.col(`${SPACE}_edges`).insertOne(docs.edges('e-1', 'depends-on', created));

    assert.equal(await backfillTypedExpiry(SPACE, POLICY, 'edge'), 1,
      'the backfill found no edge — it is almost certainly querying `type` instead of `label`');
    assert.equal((await load('edges', 'e-1'))._expireAt.getTime(), Date.parse(created) + 60 * DAY);
  });

  it('leaves a type with no window alone, in every collection', async () => {
    const created = ago(400);
    /*
     * A type name the policy does NOT police, per knowledge type -- values, so they are written here, but the
     * SET is derived. Asserted to cover every type first: an unnamed one would insert a record with an
     * undefined type, which no window matches either, so the case would pass while testing nothing.
     */
    const unpoliced = { entity: 'person', fact: 'idea', edge: 'mentions', chrono: 'meeting' };
    for (const t of KNOWLEDGE_TYPES) {
      assert.ok(unpoliced[t], `no unpoliced ${t} type is named, so this case would assert nothing about it`);
      await mongo.col(`${SPACE}_${RECORD_COLLECTION[t]}`)
        .insertOne(docs[RECORD_COLLECTION[t]](`u-${t}`, unpoliced[t], created));
    }

    for (const t of KNOWLEDGE_TYPES) {
      assert.equal(await backfillTypedExpiry(SPACE, POLICY, t), 0, t);
      assert.equal((await load(RECORD_COLLECTION[t], `u-${t}`))._expireAt, undefined,
        `an unpoliced ${t} was stamped with an expiry, so the policy reaches a type it does not name`);
    }
  });

  it('never re-slides an expiry that is already there', async () => {
    // A record carrying a deliberate per-record ttlDays must not have it quietly overwritten by the policy.
    const created = ago(100);
    const own = new Date(Date.now() + 3 * DAY);
    await mongo.col(`${SPACE}_entities`).insertOne({ ...docs.entities('t-2', 'ticket', created), _expireAt: own });

    assert.equal(await backfillTypedExpiry(SPACE, POLICY, 'entity'), 0);
    assert.equal((await load('entities', 't-2'))._expireAt.getTime(), own.getTime());
  });

  it('does NOT stamp a content window outside chrono', async () => {
    // The API accepts `contentDays` on any collection; only chrono's sweep implements it. Writing
    // `_contentExpireAt` where nothing reads it would put a policy in the data that never fires.
    const created = ago(100);
    await mongo.col(`${SPACE}_entities`).insertOne(docs.entities('t-3', 'ticket', created));

    assert.equal(await backfillTypedExpiry(SPACE, CONTENT_OUTSIDE_CHRONO, 'entity'), 1);
    const doc = await load('entities', 't-3');
    assert.equal(doc._expireAt.getTime(), Date.parse(created) + 365 * DAY);
    assert.equal(doc._contentExpireAt, undefined,
      '_contentExpireAt was stamped on an entity, where no sweep will ever read it');
  });

  it('skips a record whose createdAt cannot be parsed rather than expiring it now', async () => {
    await mongo.col(`${SPACE}_entities`).insertOne(docs.entities('t-4', 'ticket', 'not-a-date'));
    assert.equal(await backfillTypedExpiry(SPACE, POLICY, 'entity'), 0);
    assert.equal((await load('entities', 't-4'))._expireAt, undefined);
  });

  it('a space with no schema windows costs nothing', async () => {
    await mongo.col(`${SPACE}_entities`).insertOne(docs.entities('t-5', 'ticket', ago(100)));
    for (const t of KNOWLEDGE_TYPES) {
      assert.equal(await backfillTypedExpiry(SPACE, { recordTtlDays: 90 }, t), 0, t);
    }
    // The SPACE tier deliberately does not backfill: widening it would start deleting historic records on every
    // space that ever set one.
    assert.equal((await load('entities', 't-5'))._expireAt, undefined);
  });
});

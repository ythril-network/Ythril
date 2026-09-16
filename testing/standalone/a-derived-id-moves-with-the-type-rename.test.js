/**
 * An edge, a link, a tombstone and an embed job all carry the knowledge type in an identifier, and 5.0 moves
 * every one of them.
 *
 * ## Why this is a separate danger from the collection rename
 *
 * Renaming `<space>_memories` to `<space>_facts` fixes WHERE a fact is stored. It does nothing about the
 * word `memory` stored INSIDE a row — and four identifiers are computed from that word:
 *
 * | what | the identifier | what breaks without the migration |
 * |---|---|---|
 * | edge | `_id` = hash of `(from, to, label, fromKind, toKind)` | a peer deriving the new id hits the unique index |
 * | link | `_id` = the same hash, over a derived label | every "what points at this?" query matches nothing |
 * | tombstone | `type` keys the map that SERVES it | the peer is never told about the deletion |
 * | embed job | `_id` = `<recordType>:<recordId>` | the record never enters meaning-ranked search |
 *
 * **None of the four fails loudly.** A link query returns `[]`, which is what a record with no connections
 * returns. A tombstone that is not served produces a 200 with a well-formed body. A pending embed job stays
 * pending. So the only way to know is to assert it, which is what this file is.
 *
 * ## Why against a real MongoDB
 *
 * The migration is a `find`, an `insertOne` and a `deleteOne` per row, and `_id` is immutable — a mock would
 * assert that the code calls the functions it obviously calls, and would not catch the one thing that can
 * actually go wrong, which is a re-key landing on an id another row already holds.
 *
 * **The fixtures here spell the OLD word on purpose.** A migration fed the new spelling has nothing to do
 * and passes vacuously, so a bulk rename sweeping this file would turn every case green and blind.
 *
 * Run: node --test testing/standalone/a-derived-id-moves-with-the-type-rename.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

let rekeyMemoryKindToFact;
let getDb;
let edgeIdFor;
let linkIdFor;

const SPACE = 'rk1';
const MEM = '11111111-0000-4000-8000-000000000001';
const ENT = '22222222-0000-4000-8000-000000000002';

before(async () => {
  if (skip) return;
  await openTestMongo('rekey-memory-kind-to-fact');
  ({ rekeyMemoryKindToFact } = await import('../../server/dist/db/rekey-memory-kind-to-fact.js'));
  ({ getDb } = await import('../../server/dist/db/mongo.js'));
  ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
  ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
});

const wipe = async () => {
  const db = getDb();
  for (const s of ['_edges', '_links', '_tombstones', '_embed_jobs']) {
    await db.collection(`${SPACE}${s}`).deleteMany({});
  }
};

describe('a link row follows the kind it was keyed on', { skip }, () => {
  it('moves onto the id the new kind derives, keeping every other field', async () => {
    const db = getDb();
    await wipe();
    const oldId = edgeIdFor(MEM, ENT, 'memory.entityIds', 'memory', 'entity');
    await db.collection(`${SPACE}_links`).insertOne({
      _id: oldId, spaceId: SPACE, from: MEM, fromKind: 'memory', to: ENT, toKind: 'entity',
      author: { instanceId: 'i1' }, createdAt: '2026-01-01T00:00:00.000Z', seq: 7,
    });

    await rekeyMemoryKindToFact();

    const wanted = linkIdFor(MEM, 'fact', ENT, 'entity');
    const moved = await db.collection(`${SPACE}_links`).findOne({ _id: wanted });
    assert.ok(moved, `the link did not move onto ${wanted} — a fact's connections answer no query`);
    assert.equal(moved.fromKind, 'fact');
    assert.equal(moved.seq, 7, 'the content did not change, so the seq must not move either');
    assert.equal(await db.collection(`${SPACE}_links`).countDocuments({ _id: oldId }), 0,
      'the old row must be gone, not duplicated — two rows for one connection is worse than a stale one');
  });

  it('is idempotent — a second boot finds nothing left to move', async () => {
    const out = await rekeyMemoryKindToFact();
    assert.deepEqual(out.moved, {}, 'a second run must move nothing');
  });

  it('leaves a row whose kinds never said memory completely alone', async () => {
    const db = getDb();
    await wipe();
    const id = edgeIdFor('e1', 'e2', 'knows');
    await db.collection(`${SPACE}_edges`).insertOne({
      _id: id, spaceId: SPACE, from: 'e1', to: 'e2', label: 'knows', fromKind: 'entity', toKind: 'entity',
    });
    await rekeyMemoryKindToFact();
    assert.ok(await db.collection(`${SPACE}_edges`).findOne({ _id: id }),
      'an entity-to-entity edge derives the same id as it always did and must not be touched');
  });
});

describe('an edge endpoint kind moves too', { skip }, () => {
  it('re-keys an edge whose TO end was a memory', async () => {
    const db = getDb();
    await wipe();
    const oldId = edgeIdFor(ENT, MEM, 'mentions', 'entity', 'memory');
    await db.collection(`${SPACE}_edges`).insertOne({
      _id: oldId, spaceId: SPACE, from: ENT, to: MEM, label: 'mentions',
      fromKind: 'entity', toKind: 'memory',
    });

    await rekeyMemoryKindToFact();

    const wanted = edgeIdFor(ENT, MEM, 'mentions', 'entity', 'fact');
    const moved = await db.collection(`${SPACE}_edges`).findOne({ _id: wanted });
    assert.ok(moved, 'the edge kept an id nothing re-derives — the next peer to create it hits the '
      + 'unique index on (from, to, label)');
    assert.equal(moved.toKind, 'fact');
  });

  it('refuses to merge when the target id is already taken', async () => {
    const db = getDb();
    await wipe();
    const oldId = edgeIdFor(ENT, MEM, 'mentions', 'entity', 'memory');
    const newId = edgeIdFor(ENT, MEM, 'mentions', 'entity', 'fact');
    await db.collection(`${SPACE}_edges`).insertMany([
      { _id: oldId, spaceId: SPACE, from: ENT, to: MEM, label: 'mentions', fromKind: 'entity', toKind: 'memory', note: 'old' },
      { _id: newId, spaceId: SPACE, from: ENT, to: MEM, label: 'mentions', fromKind: 'entity', toKind: 'fact', note: 'new' },
    ]);

    const out = await rekeyMemoryKindToFact();

    assert.ok(out.collisions.some(c => c.endsWith(oldId)),
      'a taken target must be reported — which row wins is a decision this code cannot make');
    assert.equal(await db.collection(`${SPACE}_edges`).countDocuments(), 2, 'and neither side was touched');
  });
});

describe('the identifiers that are not re-keyed but still carry the word', { skip }, () => {
  it('rewrites a tombstone type, so the deletion is served to peers again', async () => {
    const db = getDb();
    await wipe();
    await db.collection(`${SPACE}_tombstones`).insertMany([
      { _id: MEM, type: 'memory', spaceId: SPACE, deletedAt: '2026-01-01T00:00:00.000Z' },
      { _id: ENT, type: 'entity', spaceId: SPACE, deletedAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const out = await rekeyMemoryKindToFact();

    assert.equal(out.tombstones, 1);
    assert.equal((await db.collection(`${SPACE}_tombstones`).findOne({ _id: MEM })).type, 'fact',
      'a tombstone naming a type the serve map has no key for is never handed to a peer, and the record '
      + 'it deleted lives on there for ever');
    assert.equal((await db.collection(`${SPACE}_tombstones`).findOne({ _id: ENT })).type, 'entity');
    // The tombstone's own id is the deleted document's id, which did not change.
    assert.ok(await db.collection(`${SPACE}_tombstones`).findOne({ _id: MEM }),
      'the tombstone must keep its id — it names the document, not the type');
  });

  it('re-keys a queued embed job rather than dropping it', async () => {
    const db = getDb();
    await wipe();
    await db.collection(`${SPACE}_embed_jobs`).insertOne({
      _id: `memory:${MEM}`, spaceId: SPACE, recordType: 'memory', recordId: MEM,
      status: 'pending', attempts: 0,
    });

    const out = await rekeyMemoryKindToFact();

    assert.equal(out.embedJobs, 1);
    const job = await db.collection(`${SPACE}_embed_jobs`).findOne({ _id: `fact:${MEM}` });
    assert.ok(job, 'a job naming a type the worker cannot resolve stays pending for ever, and the record '
      + 'never enters meaning-ranked search');
    assert.equal(job.recordType, 'fact');
    assert.equal(job.status, 'pending', 'the work itself is unchanged — only the name of the type');
    assert.equal(await db.collection(`${SPACE}_embed_jobs`).countDocuments(), 1,
      'the queue de-duplicates by id, so the old key must be gone rather than left as a second job');
  });

  it('drops the stale job when one already exists under the new key', async () => {
    const db = getDb();
    await wipe();
    await db.collection(`${SPACE}_embed_jobs`).insertMany([
      { _id: `memory:${MEM}`, spaceId: SPACE, recordType: 'memory', recordId: MEM, status: 'pending' },
      { _id: `fact:${MEM}`, spaceId: SPACE, recordType: 'fact', recordId: MEM, status: 'pending' },
    ]);
    await rekeyMemoryKindToFact();
    assert.equal(await db.collection(`${SPACE}_embed_jobs`).countDocuments(), 1,
      'two jobs for one record are one piece of work — the queue de-duplicates by id and so does this');
  });
});

describe('the migrations are the one place the old word survives', { skip: false }, () => {
  /*
   * WRITTEN BECAUSE A SWEEP BROKE THIS THREE TIMES IN ONE DAY, each time silently:
   *
   *   - `OLD_SUFFIX = '_memories'` became `'_facts'`, so the rename would have renamed `_facts` to
   *     `_facts` — a no-op, and every space then reads as empty.
   *   - the migration suites' own INPUT fixtures were rewritten to the new spelling, so the migrations were
   *     handed nothing to do and every case passed without exercising anything.
   *   - the three `await import('./db/rename-memories-to-facts.js')` paths in `index.ts` were rewritten,
   *     and the boot failed to resolve the module.
   *
   * None of the three produces an error a reader would connect to a rename. So the rule is asserted rather
   * than remembered: a migration reads the OLD word by definition, and a build where it does not is a build
   * whose migrations cannot fire.
   */
  // COMMENTS STRIPPED. Every one of these files explains the old word at length in its docblock, so a
  // gate reading the raw text passes on the explanation of the constant it is checking.
  const src = (f) => stripComments(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'));

  it('each migration still contains the word it exists to find', () => {
    for (const f of [
      'server/src/db/rename-memories-to-facts.ts',
      'server/src/config/migrate-memory-to-fact.ts',
      'server/src/db/rekey-memory-kind-to-fact.ts',
    ]) {
      assert.match(src(f), /'_?memor(y|ies)'/,
        f + ' no longer names the old spelling, so it can only migrate a value nothing stores. A sweep '
        + 'reached it — restore the constant by hand, never from the sweep.');
    }
  });

  it('and the boot still imports them by the paths they are actually at', () => {
    const index = src('server/src/index.ts');
    for (const mod of ['./db/rename-memories-to-facts.js', './config/migrate-memory-to-fact.js',
      './db/rekey-memory-kind-to-fact.js']) {
      assert.ok(index.includes(mod),
        'index.ts does not import ' + mod + '. Either a migration stopped running at boot, or a sweep '
        + 'rewrote the path — which fails the boot outright rather than skipping the migration.');
    }
  });
});

after(async () => {
  if (skip) return;
  const db = getDb();
  for (const s of ['_edges', '_links', '_tombstones', '_embed_jobs']) {
    await db.collection(`${SPACE}${s}`).drop().catch(() => {});
  }
  await closeTestMongo();
});

/**
 * Every removal of a record writes the removal and its tombstone as ONE transaction (Q-313).
 *
 * ## What it prevents
 *
 * `deleteFact`, `deleteChrono` and `deleteEntity` deleted the record and THEN wrote its tombstone as a second write, and the link reconcile, the file-link
 * remover and the fork remover deleted every chunk and THEN wrote the tombstones, session-less. A tombstone the store refused (a validator, a counter at its
 * ceiling, a timeout) left the record gone here and alive on every peer — the next pull brought it back — and the call had already removed what it could not
 * announce. The TTL sweep deletes through those deleters, so it repeated the defect per expired record. (The edge was fixed in `Q-107`: `removeEdges`.)
 *
 * Now `removeRecords` (`brain/record-removal.ts`) holds the stored seqs, the unresolved versions, the delete and the tombstone in one held transaction per
 * chunk, and `removeWithTombstones` opens its own when a caller gives it no session, so the three session-less callers are fixed without being touched.
 *
 * ## The cases
 *
 * One `it` per path, each with the same REAL fault (`_write-faults.mjs withValidator`: a validator on `<space>_tombstones` refusing the one id): the call
 * throws, the record or rows are still stored, and no tombstone was written. A control per path without the fault removes the record and writes exactly one
 * tombstone carrying `originalSeq`. The paths: `deleteFact`, `deleteChrono`, `deleteEntity`, the link reconcile (`updateFact` with `linkEntities: []`),
 * `removeFileLinksThisInstanceWrote`, and the TTL sweep over an expired fact.
 *
 * Run: node --test testing/standalone/a-record-delete-and-its-tombstone-land-together-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { withValidator } from './_write-faults.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-delete-atomic-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACE = 'general';
const AUTHOR = { instanceId: 'delete-atomic-test', instanceLabel: 'test' };
const FACT = 'aaaaaaaa-0000-4000-8000-0000000b0001';
const CHRONO = 'aaaaaaaa-0000-4000-8000-0000000b0002';
const ENTITY = 'aaaaaaaa-0000-4000-8000-0000000b0003';
const EXPIRED = 'aaaaaaaa-0000-4000-8000-0000000b0004';
const LINKED = 'aaaaaaaa-0000-4000-8000-0000000b0005';
const E1 = 'aaaaaaaa-0000-4000-8000-0000000b00e1';
const E2 = 'aaaaaaaa-0000-4000-8000-0000000b00e2';
const FILE = 'notes/delete-atomic.txt';
const SEQ = 7;
const T0 = '2026-01-01T00:00:00.000Z';

let mongo, mods;
const coll = (n) => mongo.col(`${SPACE}_${n}`);
const tombstonesOf = (id) => coll('tombstones').find({ _id: id }).toArray();

/** The call fails while the store refuses the tombstone of `id`, whatever it throws. */
async function failingWhileRefused(id, fn) {
  let outcome;
  await withValidator(mongo.getDb(), `${SPACE}_tombstones`, { _id: { $ne: id } }, async () => {
    outcome = await fn().then(v => ({ value: v }), e => ({ error: e }));
  });
  return outcome;
}

describe('a record is removed together with its tombstone, on every path', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('deleteatomic');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'delete-atomic-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: { strictLinkage: false, suppressEmbeddings: true } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    mods = {
      fact: await import('../../server/dist/brain/fact.js'),
      chrono: await import('../../server/dist/brain/chrono.js'),
      entities: await import('../../server/dist/brain/entities.js'),
      links: await import('../../server/dist/brain/links.js'),
      ttl: await import('../../server/dist/brain/ttl-sweep.js'),
    };
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['facts', 'chrono', 'entities', 'edges', 'links', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
    await coll('facts').insertOne({ _id: FACT, spaceId: SPACE, fact: 'a fact', tags: [], author: AUTHOR, seq: SEQ, createdAt: T0, updatedAt: T0 });
    await coll('chrono').insertOne({ _id: CHRONO, spaceId: SPACE, title: 'an event', type: 'event', startsAt: T0, status: 'upcoming', tags: [], author: AUTHOR, seq: SEQ, createdAt: T0, updatedAt: T0 });
    await coll('entities').insertMany([
      { _id: ENTITY, spaceId: SPACE, name: 'An entity', type: 'thing', tags: [], properties: {}, author: AUTHOR, seq: SEQ, createdAt: T0, updatedAt: T0 },
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], properties: {}, author: AUTHOR, seq: 1, createdAt: T0, updatedAt: T0 },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], properties: {}, author: AUTHOR, seq: 1, createdAt: T0, updatedAt: T0 },
    ]);
  });

  /** A fact that holds two entity links, written by the real writer. */
  async function linkedFact() {
    await coll('facts').deleteMany({});
    const f = await mods.fact.saveFact(SPACE, 'a linked fact', [E1, E2], []);
    assert.equal(await coll('links').countDocuments({ from: f._id }), 2, 'fixture: the fact does not hold two link rows');
    return f;
  }

  it('the fault is real: the validator refuses that one tombstone and no other', async () => {
    await withValidator(mongo.getDb(), `${SPACE}_tombstones`, { _id: { $ne: 'poisoned' } }, async () => {
      await assert.rejects(coll('tombstones').insertOne({ _id: 'poisoned', type: 'fact', seq: 1 }), /validation/i);
      await coll('tombstones').insertOne({ _id: 'free', type: 'fact', seq: 1 });
    });
  });

  const single = [
    ['deleteFact', 'facts', FACT, () => mods.fact.deleteFact(SPACE, FACT), 'fact'],
    ['deleteChrono', 'chrono', CHRONO, () => mods.chrono.deleteChrono(SPACE, CHRONO), 'chrono'],
    ['deleteEntity', 'entities', ENTITY, () => mods.entities.deleteEntity(SPACE, ENTITY), 'entity'],
  ];

  for (const [name, family, id, call, type] of single) {
    it(`${name}: a tombstone the store refuses leaves the record stored and no tombstone, and the call fails`, async () => {
      const outcome = await failingWhileRefused(id, call);
      assert.ok(outcome.error, `${name} answered ${JSON.stringify(outcome.value)} over a tombstone the store refused`);
      assert.ok(await coll(family).findOne({ _id: id }), `${name} removed the record although its tombstone was refused: the record is gone here and alive on every peer`);
      assert.deepEqual(await tombstonesOf(id), [], 'a tombstone was written for a record that is still stored');
    });

    it(`${name}, control: without the fault the record goes and exactly one tombstone carries its seq`, async () => {
      assert.equal(await call(), true);
      assert.equal(await coll(family).findOne({ _id: id }), null);
      const tombs = await tombstonesOf(id);
      assert.equal(tombs.length, 1, 'expected exactly one tombstone');
      assert.equal(tombs[0].type, type);
      assert.equal(tombs[0].originalSeq, SEQ, 'the tombstone does not carry the deleted record\'s seq');
    });
  }

  it('the link reconcile: a tombstone the store refuses leaves every link row of the chunk in place', async () => {
    const f = await linkedFact();
    const rows = await coll('links').find({ from: f._id }).toArray();
    const outcome = await failingWhileRefused(rows[0]._id, () => mods.fact.updateFact(SPACE, f._id, { linkEntities: [] }));
    assert.ok(outcome.error, `the reconcile answered ${JSON.stringify(outcome.value)} over a tombstone the store refused`);
    assert.equal(await coll('links').countDocuments({ from: f._id }), 2, 'a link row was removed although its chunk\'s tombstones were not all written');
    assert.deepEqual(await coll('tombstones').find({ type: 'link' }).toArray(), [], 'a link tombstone was written for a link row that is still stored');
  });

  it('the link reconcile, control: both rows go and each has one tombstone carrying its seq', async () => {
    const f = await linkedFact();
    const rows = await coll('links').find({ from: f._id }).toArray();
    await mods.fact.updateFact(SPACE, f._id, { linkEntities: [] });
    assert.equal(await coll('links').countDocuments({ from: f._id }), 0);
    const tombs = await coll('tombstones').find({ _id: { $in: rows.map(r => r._id) } }).toArray();
    assert.equal(tombs.length, 2, 'expected one tombstone per removed link row');
    for (const t of tombs) assert.equal(t.originalSeq, rows.find(r => r._id === t._id).seq);
  });

  /** Two link rows FROM a file, written by this instance. */
  async function fileLinks() {
    const rows = [E1, E2].map((to) => ({
      _id: mods.links.linkIdFor(FILE, 'file', to, 'entity'), spaceId: SPACE, from: FILE, fromKind: 'file', to, toKind: 'entity',
      author: { instanceId: 'delete-atomic-test', instanceLabel: 'test' }, seq: 3, createdAt: T0, updatedAt: T0,
    }));
    await coll('links').insertMany(rows);
    return rows;
  }

  it('removeFileLinksThisInstanceWrote: a tombstone the store refuses leaves the rows in place', async () => {
    const rows = await fileLinks();
    const outcome = await failingWhileRefused(rows[1]._id, () => mods.links.removeFileLinksThisInstanceWrote(SPACE, [FILE]));
    assert.ok(outcome.error, `the remover answered ${JSON.stringify(outcome.value)} over a tombstone the store refused`);
    assert.equal(await coll('links').countDocuments({ from: FILE }), 2, 'a file link row was removed although its tombstones were not all written');
    assert.deepEqual(await coll('tombstones').find({ type: 'link' }).toArray(), []);
  });

  it('removeFileLinksThisInstanceWrote, control: the rows go with one tombstone each', async () => {
    const rows = await fileLinks();
    assert.equal(await mods.links.removeFileLinksThisInstanceWrote(SPACE, [FILE]), 2);
    assert.equal(await coll('links').countDocuments({ from: FILE }), 0);
    assert.equal(await coll('tombstones').countDocuments({ _id: { $in: rows.map(r => r._id) } }), 2);
  });

  const expire = () => coll('facts').insertOne({
    _id: EXPIRED, spaceId: SPACE, fact: 'an expired fact', tags: [], author: AUTHOR, seq: SEQ, createdAt: T0, updatedAt: T0, _expireAt: new Date('2020-01-01T00:00:00Z'),
  });

  it('the TTL sweep: an expired fact whose tombstone the store refuses stays stored and untombstoned', async () => {
    await expire();
    await failingWhileRefused(EXPIRED, () => mods.ttl.sweepExpired(new Date()));
    assert.ok(await coll('facts').findOne({ _id: EXPIRED }), 'the sweep removed an expired fact although its tombstone was refused');
    assert.deepEqual(await tombstonesOf(EXPIRED), []);
  });

  it('a cascade that fails after the commit still announces the removal: the deleted event goes out and the call still fails', async () => {
    const removal = await import('../../server/dist/brain/record-removal.js');
    const bus = await import('../../server/dist/brain/brain-events.js');
    const original = removal.AFTER_REMOVAL.fact;
    removal.AFTER_REMOVAL.fact = async () => { throw new Error('the links-from removal failed'); };
    const seen = [];
    const off = bus.subscribeBrainChanges(SPACE, ev => seen.push(ev));
    try {
      await assert.rejects(() => removal.removeRecords(SPACE, 'fact', [FACT], {}), /the links-from removal failed/, 'a failed cascade did not fail the call');
      await elapse(100, 'absence window: the deleted event is mirrored onto the bus after the call settles, and the list is read once it has had that long');
    } finally { off(); removal.AFTER_REMOVAL.fact = original; }
    assert.equal(await coll('facts').findOne({ _id: FACT }), null, 'the fixture: the removal itself stood');
    assert.deepEqual(seen.map(e => [e.event, e.entry?._id]), [['fact.deleted', FACT]], 'the removal stood and its deleted event was lost with the cascade');
  });

  it('removing ids that are not stored opens no transaction (a 404 delete, a TTL race): one read and nothing else', async () => {
    const removal = await import('../../server/dist/brain/record-removal.js');
    // A transaction is `ClientSession.withTransaction` (the driver also starts implicit sessions for plain reads, which are not what this asks about).
    const probe = mongo.getMongo().startSession();
    const proto = Object.getPrototypeOf(probe);
    await probe.endSession();
    const original = proto.withTransaction;
    let sessions = 0;
    proto.withTransaction = function counting(...args) { sessions++; return original.apply(this, args); };
    try {
      assert.equal((await removal.removeRecords(SPACE, 'fact', ['aaaaaaaa-0000-4000-8000-00000000dead'])).size, 0);
      assert.equal(sessions, 0, 'a removal of an id that is not stored opened a held transaction to read nothing');
      assert.equal((await removal.removeRecords(SPACE, 'fact', [FACT])).size, 1, 'control: a stored fact is removed');
      assert.ok(sessions >= 1, 'control: the removal of a stored record runs in a transaction');
    } finally { proto.withTransaction = original; }
  });

  it('the TTL sweep, control: an expired fact is removed with one tombstone carrying its seq', async () => {
    await expire();
    await mods.ttl.sweepExpired(new Date());
    assert.equal(await coll('facts').findOne({ _id: EXPIRED }), null);
    const tombs = await tombstonesOf(EXPIRED);
    assert.equal(tombs.length, 1);
    assert.equal(tombs[0].originalSeq, SEQ);
  });
});

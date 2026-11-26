/**
 * A write group's ceilings count every write the group makes: its records, the link rows a delete removes or a converge drops, the forks a
 * delete settles, and each removal's tombstone (`Q-760`, review A1 and A9; contract-760).
 *
 * ## The rule
 *
 * `GROUP_MAX_RECORDS` counts plans (a delete is a record). `GROUP_MAX_OPERATIONS` counts one write per insert and converge, one per link row
 * added, and TWO (the removal and its tombstone) per record deleted, per fork settled and per link row removed. `GROUP_MAX_BYTES` counts the
 * documents, the `$set`/`$unset` of a converge, each added link row and every tombstone. The link rows a removal takes are counted BEFORE the
 * session opens (one count per delete kind; the stored rows a converge drops), so a group over a ceiling is refused `413` and opens no
 * transaction. If the session reads more rows than were counted, a row written between the count and the read, the group aborts `too_large`
 * and writes nothing.
 *
 * ## Why every expectation is computed here
 *
 * Each expected size below is arithmetic on the fixture (rows seeded times two, plus the records), compared with the `size` the refusal
 * reports, and a tombstone's bytes come from a hand-written document. None goes through `writeGroupSize`: a test that sized its fixture with
 * the function under test passes when the function drops a term. A size is asserted exactly, not only "over": a ceiling that counted a row
 * once instead of twice would still refuse the large group and be caught here by its number.
 *
 * ## The trigger that bought it
 *
 * 13 fact deletes, each holding the 4 000 link rows a record may hold (1 000 per class, four classes), remove 52 000 rows: 104 000 writes
 * in one transaction, from a group the ceilings counted as 26.
 *
 * ## Seen red
 *
 * On 96be09a1c a delete counts two writes whatever its link rows, and a converge counts its own write alone: the over-the-ceiling cases land
 * (or report 26 or 2 writes), the in-session case lands the extra row. Mutation: the link-row term removed from the byte count (the bytes case).
 *
 * Run: node --test testing/standalone/a-write-group-counts-every-write-it-makes-in-its-ceilings-db.test.js (a Mongo the harness accepts; `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import {
  SPACE, AUTHOR, openWriteGroupFixture, factId, entityId, factDoc, insertFact, convergeFact, deleteRecord, settle, countTransactions, abortsOf, seedLinkRows,
} from './_write-group.mjs';

const skip = await mongoSkipReason();
const SLOW = 280_000;
const RECORDS = 5_000;
const BYTES = 32 * 1024 * 1024;
const MOST = Number.MAX_SAFE_INTEGER;

let fx;
let operationBytes;
let linkIdFor;
const facts = (n, from = 1) => Array.from({ length: n }, (_, i) => insertFact(factId(from + i), `fact ${from + i}`));
const storeFact = (n, seq = 1) => fx.coll('facts').insertOne({ ...factDoc(factId(n), `stored ${n}`), seq });

/** A tombstone as the group writes one, its stamp at the widest, measured as the store measures a write. Written out here, not read from the code. */
const tombstoneBytes = (id, type) => operationBytes({
  _id: id, type, spaceId: SPACE, deletedAt: '2026-11-25T00:00:00.000Z', instanceId: AUTHOR.instanceId, issuedHere: true,
  seq: MOST, pos: MOST, posAtSeq: MOST, originalSeq: MOST,
});

/**
 * Refused before a transaction opened, as `write_group_too_large` naming `ceiling` at `size`; the group's metric moved; `still()` checks nothing
 * of it was written.
 */
async function assertRefused(plans, ceiling, size, still) {
  const txns = countTransactions(fx.mongo);
  const before = await abortsOf('too_large');
  let out;
  try { out = await settle(fx.commitGroup(plans)); } finally { txns.restore(); }
  assert.ok(out.error, `a group over its ${ceiling} ceiling was answered as written`);
  assert.equal(out.error.code, 'write_group_too_large', `the refusal is not write_group_too_large: ${out.error.name}: ${out.error.message}`);
  assert.equal(out.error.ceiling, ceiling, `the refusal names the ${out.error.ceiling} ceiling, not ${ceiling}`);
  if (size !== undefined) assert.equal(out.error.size, size, `the group counts ${out.error.size} ${ceiling}, not the ${size} its plans make`);
  assert.equal(txns.started(), 0, 'a transaction was opened for a group over its ceiling');
  assert.equal(await abortsOf('too_large'), before + 1, 'the refusal did not count one write_group_aborts_total{reason="too_large"}');
  await still();
}

describe('a write group counts every write it makes in its ceilings', { skip }, () => {
  before(async () => {
    fx = await openWriteGroupFixture('writegroupcounts');
    ({ operationBytes } = await import('../../server/dist/db/one-command.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
  });
  after(async () => { await fx?.cleanup(); });
  beforeEach(async () => { await fx.clear(); });

  it('records: a delete is a record. 4 999 inserts and a delete land; 5 000 inserts and a delete are 5 001 records, refused before a session', { timeout: SLOW }, async () => {
    await storeFact(9_000);
    const over = [...facts(RECORDS), deleteRecord('fact', factId(9_000), 1)];
    await assertRefused(over, 'records', RECORDS + 1, async () => {
      assert.equal(await fx.coll('facts').countDocuments({ _id: factId(9_000) }), 1, 'the delete of a refused group removed its record');
    });
    const out = await settle(fx.commitGroup([...facts(RECORDS - 1), deleteRecord('fact', factId(9_000), 1)]));
    assert.equal(out.error, undefined, `a group of exactly ${RECORDS} records, one of them a delete, failed: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({ _id: factId(9_000) }), 0, 'the delete did not land');
  });

  it('operations: records and the link rows they add. 100 facts with 500 links each are 100 + 50 000 writes, refused', { timeout: SLOW }, async () => {
    const links = Array.from({ length: 500 }, (_, i) => entityId(i + 1));
    const group = Array.from({ length: 100 }, (_, i) => insertFact(factId(i + 1), `linked ${i}`, { links }));
    await assertRefused(group, 'operations', 100 + 100 * 500, async () => {
      assert.equal(await fx.coll('facts').countDocuments({}), 0, 'a record of a refused group landed');
    });
  });

  it('operations: the link rows a delete removes. 13 fact deletes of 4 000 rows each are 13 x 2 + 52 000 x 2 writes, refused; one delete of 1 000 rows lands, rows and tombstones', { timeout: SLOW }, async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => factId(i + 1));
    await fx.coll('facts').insertMany(thirteen.map(id => ({ ...factDoc(id, 'with many links'), seq: 1 })));
    for (const [i, id] of thirteen.entries()) await seedLinkRows(fx.coll, id, 4_000, { first: i * 4_000 });
    await assertRefused(thirteen.map(id => deleteRecord('fact', id, 1)), 'operations', 13 * 2 + 52_000 * 2, async () => {
      assert.equal(await fx.coll('facts').countDocuments({}), 13, 'a fact of a refused group was removed');
      assert.equal(await fx.coll('links').countDocuments({}), 52_000, 'a link row of a refused group was removed');
    });

    await fx.clear();
    await storeFact(1);
    await seedLinkRows(fx.coll, factId(1), 1_000);
    const out = await settle(fx.commitGroup([deleteRecord('fact', factId(1), 1)]));
    assert.equal(out.error, undefined, `a delete of a fact with 1 000 link rows failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('links').countDocuments({}), 0, 'the fact\'s link rows were not all removed');
    assert.equal(await fx.coll('tombstones').countDocuments({ type: 'link' }), 1_000, 'a removed link row has no tombstone');
  });

  it('operations: a chrono entry\'s link rows count like a fact\'s. One delete of 25 000 rows is 2 + 50 000 writes, refused',{ timeout: SLOW }, async () => {
    const id = 'cccccccc-0000-4000-8000-000000000001';
    await fx.coll('chrono').insertOne({ _id: id, spaceId: SPACE, title: 't', type: 'event', startsAt: '2026-11-25T00:00:00.000Z', status: 'upcoming', tags: [], author: AUTHOR, seq: 1 });
    await seedLinkRows(fx.coll, id, 25_000, { fromKind: 'chrono' });
    await assertRefused([deleteRecord('chrono', id, 1)], 'operations', 2 + 25_000 * 2, async () => {
      assert.equal(await fx.coll('chrono').countDocuments({}), 1, 'the chrono entry of a refused group was removed');
    });
  });

  it('operations: the stored rows a converge drops. One converge (1) and one insert (1) that drop 25 000 rows are 2 + 50 000 writes, refused; dropping 500 lands', { timeout: SLOW }, async () => {
    await storeFact(1, 3);
    await seedLinkRows(fx.coll, factId(1), 25_000);
    const drop = { ...convergeFact(factId(1), 'with no links', 3), links: { fromKind: 'fact', desired: { entity: [] }, author: AUTHOR } };
    await assertRefused([drop, insertFact(factId(2), 'beside it')], 'operations', 1 + 1 + 25_000 * 2, async () => {
      assert.equal(await fx.coll('links').countDocuments({}), 25_000, 'a row was dropped by a refused group');
    });

    await fx.clear();
    await storeFact(1, 3);
    await seedLinkRows(fx.coll, factId(1), 500);
    const out = await settle(fx.commitGroup([drop, insertFact(factId(2), 'beside it')]));
    assert.equal(out.error, undefined, `a converge dropping 500 rows failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('links').countDocuments({}), 0, 'the dropped rows were not removed');
    assert.equal(await fx.coll('tombstones').countDocuments({ type: 'link' }), 500, 'a dropped link row has no tombstone');
  });

  it('operations: each fork a delete settles is two writes. One delete with 25 000 forks is 2 + 50 000 writes, refused', { timeout: SLOW }, async () => {
    const subject = factId(1);
    await storeFact(1);
    await fx.coll('facts').insertMany(Array.from({ length: 25_000 }, (_, i) => ({ ...factDoc(factId(i + 1_000), 'a version'), forkOf: subject, seq: 2 + i })));
    await assertRefused([deleteRecord('fact', subject, 1)], 'operations', 2 + 25_000 * 2, async () => {
      assert.equal(await fx.coll('facts').countDocuments({ _id: subject }), 1, 'the fact of a refused group was removed');
    });
  });

  it('bytes: a delete\'s tombstone, its forks\' and its link rows\' count. A group of exactly 32 MiB lands; one byte more is refused before a session', { timeout: SLOW }, async () => {
    const subject = factId(1);
    const fork = factId(2);
    const build = (extra) => {
      const rows = [linkIdFor(subject, 'fact', entityId(1), 'entity'), linkIdFor(subject, 'fact', entityId(2), 'entity')];
      const fixed = tombstoneBytes(subject, 'fact') + tombstoneBytes(fork, 'fact') + rows.reduce((sum, id) => sum + tombstoneBytes(id, 'link'), 0);
      const bare = [3, 4, 5].map(n => insertFact(factId(n), `padded ${n}`, { pad: '' }));
      const room = BYTES - fixed - bare.reduce((sum, p) => sum + operationBytes(p.doc), 0) + extra;
      const each = Math.floor(room / 3);
      return [deleteRecord('fact', subject, 1),
        ...[3, 4, 5].map((n, i) => insertFact(factId(n), `padded ${n}`, { pad: 'x'.repeat(i === 2 ? room - 2 * each : each) }))];
    };
    const seed = async () => {
      await fx.clear();
      await storeFact(1);
      await fx.coll('facts').insertOne({ ...factDoc(fork, 'a version'), forkOf: subject, seq: 2 });
      await seedLinkRows(fx.coll, subject, 2);
    };
    await seed();
    await assertRefused(build(1), 'bytes', BYTES + 1, async () => {
      assert.equal(await fx.coll('facts').countDocuments({}), 2, 'a record of a refused group changed');
    });
    const out = await settle(fx.commitGroup(build(0)));
    assert.equal(out.error, undefined, `a group of exactly 32 MiB (tombstones counted) failed: ${out.error?.name}: ${out.error?.message}`);
    assert.equal(await fx.coll('facts').countDocuments({ _id: { $in: [subject, fork] } }), 0, 'the delete and its fork did not land');
  });

  it('a row written between the count and the read aborts the group too_large, and nothing is removed', { timeout: SLOW }, async () => {
    const subject = factId(1);
    await storeFact(1);
    await seedLinkRows(fx.coll, subject, 2);
    const extra = linkIdFor(subject, 'fact', entityId(3), 'entity');
    // Another writer's row lands right after the group counted the rows its delete removes, and before its transaction reads them.
    const collProto = Object.getPrototypeOf(fx.coll('links'));
    const countOriginal = collProto.countDocuments;
    let planted = false;
    collProto.countDocuments = async function plantAfterTheCount(...args) {
      const counted = await countOriginal.apply(this, args);
      if (!planted && this.collectionName === `${SPACE}_links`) {
        planted = true;
        await this.insertOne({ _id: extra, spaceId: SPACE, from: subject, fromKind: 'fact', to: entityId(3), toKind: 'entity', author: AUTHOR, seq: 5 });
      }
      return counted;
    };
    const before = await abortsOf('too_large');
    let out;
    try { out = await settle(fx.commitGroup([deleteRecord('fact', subject, 1)])); } finally { collProto.countDocuments = countOriginal; }
    assert.ok(planted, 'fixture: the extra row was not written');
    assert.ok(out.error, 'a group that read more rows than it counted was answered as written');
    assert.equal(out.error.name, 'GroupAborted', `the failure is not the group's abort: ${out.error.name}: ${out.error.message}`);
    assert.equal(out.error.reason, 'too_large');
    assert.equal(await fx.coll('facts').countDocuments({ _id: subject }), 1, 'the fact of an aborted group was removed');
    assert.equal(await fx.coll('links').countDocuments({}), 3, 'a link row of an aborted group was removed');
    assert.equal(await abortsOf('too_large'), before + 1, 'the abort did not count one write_group_aborts_total{reason="too_large"}');
  });
});

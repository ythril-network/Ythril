/**
 * A record written between the run's read and its write is not overwritten by the conversion (Q-746, bundle-284 design r5 section 5.3 steps 3
 * and 4, finding S13).
 *
 * ## The rule
 *
 * `convertOneRecord(spaceId, run, kind, record)` takes the record AS READ. When the stored version is no longer the one read (another write
 * landed meanwhile), neither the rewrite (through the update function at `ifMatchSeq = record.seq`) nor the quiet stamp (filtered by the
 * version and the stamp as read) matches: the answer is `moved`, and the other write is kept whole. A later run passes the record again.
 *
 * ## Why a stale read handed in
 *
 * A race between a background run and a write cannot be won on purpose; a read whose version the test bumped after reading is the same
 * window, every time (S13: a test that cannot fail when the guard is gone proves nothing).
 *
 * Seen red on 14af4644: the converter is not built.
 *
 * Run: node --test testing/standalone/a-moved-record-is-not-overwritten-by-a-conversion-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const S = 'moved';
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };
AFTER.typeSchemas.fact.claim.propertySchemas = { certainty: { type: 'number' } };
const RENAME_NICK = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const RENAME_CONF = { op: 'renameProperty', kind: 'fact', type: 'claim', from: 'confidence', to: 'certainty' };

describe('a moved record is not overwritten by a conversion (real MongoDB)', { skip }, () => {
  let door, convert, toFp;
  const runOf = (steps) => ({ toFp, steps, stepsRefused: [], splitDeclared: {} });
  /** Another writer lands on `id` after the run read it: a new version and a new body. */
  const otherWrite = (part, id, set) => door.coll(S, part).findOneAndUpdate({ _id: id }, { $set: set, $inc: { seq: 500 } }, { returnDocument: 'after' });

  before(async () => {
    door = await openConvertDoor({ name: 'b284moved', spaces: [S] });
    convert = await door.recordModule();
    door.setMeta(S, AFTER);
    toFp = door.fp(S);
  });
  after(async () => { await door?.close(); });

  it('a rewrite of an entity read before another write: moved, the other write kept', async () => {
    const [read] = await door.seed(S, 'entities', [{ _id: 'e-1', name: 'E', type: 'person', properties: { nick: 'mine' } }]);
    const theirs = await otherWrite('entities', 'e-1', { 'properties.nick': 'theirs', updatedAt: 'their-time' });
    const out = await convert.convertOneRecord(S, runOf([RENAME_NICK]), 'entity', read);
    assert.equal(out.outcome, 'moved', JSON.stringify(out));
    assert.deepEqual(await door.coll(S, 'entities').findOne({ _id: 'e-1' }), theirs, 'the other write was overwritten');
  });

  it('a rewrite of a fact read before another write: moved, the other write kept', async () => {
    const [read] = await door.seed(S, 'facts', [{ _id: 'f-1', fact: 'F', type: 'claim', entityIds: [], properties: { confidence: 1 } }]);
    const theirs = await otherWrite('facts', 'f-1', { 'properties.confidence': 2, updatedAt: 'their-time' });
    const out = await convert.convertOneRecord(S, runOf([RENAME_CONF]), 'fact', read);
    assert.equal(out.outcome, 'moved', JSON.stringify(out));
    assert.deepEqual(await door.coll(S, 'facts').findOne({ _id: 'f-1' }), theirs);
  });

  it('a quiet stamp of a record read before another write: moved, nothing stamped', async () => {
    const [read] = await door.seed(S, 'entities', [{ _id: 'e-2', name: 'E2', type: 'person', properties: { age: 2 } }]);
    const theirs = await otherWrite('entities', 'e-2', { 'properties.age': 3, updatedAt: 'their-time' });
    const out = await convert.convertOneRecord(S, runOf([]), 'entity', read);
    assert.equal(out.outcome, 'moved', JSON.stringify(out));
    const stored = await door.coll(S, 'entities').findOne({ _id: 'e-2' });
    assert.equal(stored.schemaFingerprint, undefined, 'a stamp landed on a version the run never classified');
    assert.deepEqual(stored, theirs);
  });

  it('the same reads, not moved: rewritten and stamped (the cases above fail for the move, not for the fixture)', async () => {
    const [e] = await door.seed(S, 'entities', [{ _id: 'e-3', name: 'E3', type: 'person', properties: { nick: 'n' } }]);
    assert.equal((await convert.convertOneRecord(S, runOf([RENAME_NICK]), 'entity', e)).outcome, 'rewritten');
    const [q] = await door.seed(S, 'entities', [{ _id: 'e-4', name: 'E4', type: 'person', properties: { age: 4 } }]);
    assert.equal((await convert.convertOneRecord(S, runOf([]), 'entity', q)).outcome, 'stamped');
    assert.equal((await door.coll(S, 'entities').findOne({ _id: 'e-4' })).schemaFingerprint, toFp);
  });
});

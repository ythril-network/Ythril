/**
 * A schema conversion of a record with no numeric `seq` that loses its race keeps its earlier outcome, `moved`, and never fails the page
 * (bundle-378, Q-976 S2, adversarial review R6).
 *
 * ## The defect this holds
 *
 * The converter rewrites through the kind's update function at `ifMatchSeq = record.seq`, which is `undefined` for a record whose `seq` is not a
 * number. Such an edit retries by `writeAtReadVersion`, and its last miss on a record that is still there now throws `RecordWriteRaceLost`
 * (it answered `null`, which the converter read as `moved`). The throw is none of the record's own refusals and no page failure, so it landed
 * in the converter's last branch: the page failed, the run retried it, and after the stated number of passes the record became a
 * `conversion_failed` item for what was only a lost race.
 *
 * ## The rule
 *
 * A rewrite that loses its race is `moved` whether the record had a version to name or not: nothing was written, and a later run passes the
 * record again. The row is as it was.
 *
 * ## The case
 *
 * A row whose `seq` is stored as text: not a number, and no version filter matches it, so every attempt misses while the row is there.
 *
 * ## Seen red
 *
 * On f91569511 `convertOneRecord` throws `RecordConversionFailed` (the first pass of a record's failures).
 *
 * Run: node --test testing/standalone/a-conversion-of-a-record-with-no-version-that-loses-its-race-is-moved-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor, CONVERT_META } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const S = 'b378cvrace';
const AFTER = structuredClone(CONVERT_META);
AFTER.typeSchemas.entity.person.propertySchemas = { age: { type: 'number' }, alias: { type: 'string' } };
AFTER.typeSchemas.fact.claim.propertySchemas = { certainty: { type: 'number' } };
const RENAME_NICK = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'nick', to: 'alias' };
const RENAME_CONF = { op: 'renameProperty', kind: 'fact', type: 'claim', from: 'confidence', to: 'certainty' };

describe('a conversion of a record with no numeric seq that loses its race is moved (real MongoDB)', { skip }, () => {
  let door, convert, toFp;
  const runOf = (steps) => ({ toFp, steps, stepsRefused: [], splitDeclared: {} });

  before(async () => {
    door = await openConvertDoor({ name: 'b378cvrace', spaces: [S] });
    convert = await door.recordModule();
    door.setMeta(S, AFTER);
    toFp = door.fp(S);
  });
  after(async () => { await door?.close(); });

  it('an entity whose seq is text: moved, the row as it was', async () => {
    const [read] = await door.seed(S, 'entities', [{ _id: 'e-t', name: 'E', type: 'person', properties: { nick: 'mine' }, seq: '5' }]);
    const stored = await door.coll(S, 'entities').findOne({ _id: 'e-t' });
    const out = await convert.convertOneRecord(S, runOf([RENAME_NICK]), 'entity', read);
    assert.equal(out.outcome, 'moved', JSON.stringify(out));
    assert.deepEqual(await door.coll(S, 'entities').findOne({ _id: 'e-t' }), stored, 'a lost race writes nothing');
  });

  it('a fact whose seq is text: moved, the row as it was', async () => {
    const [read] = await door.seed(S, 'facts', [{ _id: 'f-t', fact: 'F', type: 'claim', entityIds: [], properties: { confidence: 1 }, seq: '5' }]);
    const stored = await door.coll(S, 'facts').findOne({ _id: 'f-t' });
    const out = await convert.convertOneRecord(S, runOf([RENAME_CONF]), 'fact', read);
    assert.equal(out.outcome, 'moved', JSON.stringify(out));
    assert.deepEqual(await door.coll(S, 'facts').findOne({ _id: 'f-t' }), stored);
  });

  it('a page of three: the record that lost its race is moved and its neighbours are rewritten', async () => {
    const rows = await door.seed(S, 'entities', [
      { _id: 'p-1', name: 'P1', type: 'person', properties: { nick: 'a' } },
      { _id: 'p-2', name: 'P2', type: 'person', properties: { nick: 'b' }, seq: '5' },
      { _id: 'p-3', name: 'P3', type: 'person', properties: { nick: 'c' } },
    ]);
    const out = await convert.convertRecordsPage(S, runOf([RENAME_NICK]), 'entity', rows);
    assert.deepEqual(out.map(o => o.outcome), ['rewritten', 'moved', 'rewritten']);
  });
});

/**
 * What the conversion steps make of one record is decided by `convertedRecord`, in a fixed order whatever the order of the steps (Q-745,
 * bundle-284 design r4 section 1.2).
 *
 * ## The defect this prevents
 *
 * The same steps read in two orders must give one record on every member, or two instances that carry one vote rewrite one record two
 * ways. So the order is fixed: the TYPE steps decide the type the record has afterwards, and only then the property steps of that type apply
 * (renames, then enum maps by the after-name). A split's conditions are evaluated on the record AS IT IS, in order, and the first true case
 * wins; a condition that reads a property the record lacks answers false (the judge the caller hands in says so), so such a record falls to
 * the next case. A record the steps cannot convert is said so, with the reason, never half-converted: no case matched, both the old and new
 * name of a renamed property set, or a condition the instance could not evaluate.
 *
 * ## What is held
 *
 * - The answer is `{ type?, set, unset }` (empty when nothing changes) or `{ notConvertible: reason }`; the record is never changed.
 * - Type steps first: a property step on the BEFORE-name of a type does not touch a record that moved; one on the after-name does.
 * - A split asks the judge case by case in order, hands it the kind, the type the split is on, the text and the record as it is, and stops
 *   at the first true. False for an absent property, `otherwise`, and no-case are the answers the judge's falses lead to.
 * - Property steps: rename moves a value, both-set is not convertible, a map changes only a value it has a key for, by the after-name.
 * - The order of the steps in the list changes nothing.
 *
 * Seen red on afb6eb8c: `schema/dist/internal.js` exports no `convertedRecord`, so every case fails on that.
 *
 * Run: node --test testing/standalone/a-converted-record-is-what-the-steps-say.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pkg from '../../schema/dist/internal.js';

const { convertedRecord } = pkg;

const NOTHING = { set: {}, unset: [] };
const deepFreeze = (o) => {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
};
const entity = (type, properties) => ({ _id: 'e1', type, title: 't', properties });

/** A judge for the cases a test needs: the text decides by what the record holds, so a wrong argument shows. Records every call. */
function judgeFor(table) {
  const calls = [];
  const judge = (kind, from, text, record) => {
    calls.push({ kind, from, text, record });
    const decide = table[text];
    assert.ok(decide, `the judge was handed a text no case has: ${text}`);
    return decide(record);
  };
  return Object.assign(judge, { calls });
}
const NEVER = judgeFor({});
const status = (record) => record.properties?.status;

const renameProperty = (extra = {}) => ({ op: 'renameProperty', kind: 'entity', type: 'person', from: 'name', to: 'fullName', ...extra });
const mapEnum = (extra = {}) => ({ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { open: 'OPEN', wip: 'WIP' }, ...extra });
const renameType = (extra = {}) => ({ op: 'renameType', kind: 'entity', from: 'person', to: 'human', ...extra });
const splitType = (cases, extra = {}) => ({ op: 'splitType', kind: 'entity', from: 'person', cases, otherwise: 'person', ...extra });

describe('a record the steps do not touch', () => {
  it('is answered as nothing, for no steps, and for steps of another type or another kind', () => {
    const rec = entity('person', { name: 'Ann', status: 'open' });
    assert.deepEqual(convertedRecord([], 'entity', rec, NEVER), NOTHING);
    assert.deepEqual(convertedRecord([renameProperty({ type: 'company' }), mapEnum({ type: 'company' }), renameType({ from: 'company', to: 'firm' })], 'entity', rec, NEVER), NOTHING);
    assert.deepEqual(convertedRecord([renameProperty(), mapEnum(), renameType(), splitType([{ when: 'w', to: 'x' }])].map(s => ({ ...s, kind: 'fact' })), 'entity', rec, NEVER), NOTHING);
    assert.equal(NEVER.calls.length, 0, 'no condition is evaluated for a record the split is not on');
  });

  it('the answer holds no `type` key unless the type changes', () => {
    const answer = convertedRecord([renameProperty()], 'entity', entity('person', { name: 'Ann' }), NEVER);
    assert.equal('type' in answer, false);
  });

  it('never changes the record it is handed', () => {
    const rec = deepFreeze(entity('person', { name: 'Ann', status: 'open' }));
    const judge = judgeFor({ w: () => true });
    assert.doesNotThrow(() => convertedRecord([renameType(), renameProperty({ type: 'human' }), mapEnum({ type: 'human' })], 'entity', rec, NEVER));
    assert.doesNotThrow(() => convertedRecord([splitType([{ when: 'w', to: 'x' }])], 'entity', rec, judge));
  });
});

describe('type steps decide the type first, property steps then follow the after-type', () => {
  const rec = () => entity('person', { name: 'Ann', status: 'open' });

  it('renameType answers the new type and changes nothing else', () => {
    assert.deepEqual(convertedRecord([renameType()], 'entity', rec(), NEVER), { type: 'human', set: {}, unset: [] });
  });

  it('a property step on the AFTER-name of a type applies to a record that moved to it', () => {
    const answer = convertedRecord([renameType(), renameProperty({ type: 'human' })], 'entity', rec(), NEVER);
    assert.deepEqual(answer, { type: 'human', set: { fullName: 'Ann' }, unset: ['name'] });
  });

  it('a property step on the BEFORE-name of a type does not apply to a record that moved away', () => {
    const answer = convertedRecord([renameType(), renameProperty({ type: 'person' }), mapEnum({ type: 'person' })], 'entity', rec(), NEVER);
    assert.deepEqual(answer, { type: 'human', set: {}, unset: [] });
  });

  it('a property step on the after-name also applies to a record that was of that type already', () => {
    const answer = convertedRecord([renameType(), renameProperty({ type: 'human' })], 'entity', entity('human', { name: 'Bo' }), NEVER);
    assert.deepEqual(answer, { set: { fullName: 'Bo' }, unset: ['name'] });
  });

  it('the order of the steps in the list changes nothing', () => {
    const steps = [renameProperty({ type: 'human' }), mapEnum({ type: 'human' }), renameType()];
    const expected = convertedRecord(steps, 'entity', rec(), NEVER);
    assert.deepEqual(expected, { type: 'human', set: { fullName: 'Ann', status: 'OPEN' }, unset: ['name'] });
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1], [0, 2, 1], [1, 0, 2]]) {
      assert.deepEqual(convertedRecord(order.map(i => steps[i]), 'entity', rec(), NEVER), expected, `order ${order}`);
    }
  });

  it('an edge is typed by its label', () => {
    const edge = { _id: 'g1', label: 'knows', properties: { since: '2020' } };
    const steps = [{ op: 'renameType', kind: 'edge', from: 'knows', to: 'knew' }, { op: 'renameProperty', kind: 'edge', type: 'knew', from: 'since', to: 'sinceYear' }];
    assert.deepEqual(convertedRecord(steps, 'edge', edge, NEVER), { type: 'knew', set: { sinceYear: '2020' }, unset: ['since'] });
    assert.deepEqual(convertedRecord([{ op: 'renameType', kind: 'edge', from: 'person', to: 'x' }], 'edge', edge, NEVER), NOTHING, 'an edge\'s `type` is not a label');
  });
});

describe('splitType: the first true case wins', () => {
  const when = { a: 'status is open', b: 'status is wip', c: 'status is open too' };
  const cases = [{ when: when.a, to: 'openPerson' }, { when: when.b, to: 'wipPerson' }, { when: when.c, to: 'lateOpenPerson' }];
  const table = {
    [when.a]: (r) => status(r) === 'open',
    [when.b]: (r) => status(r) === 'wip',
    [when.c]: (r) => status(r) === 'open',
  };

  it('answers the `to` of the first case that is true, and stops asking there', () => {
    const judge = judgeFor(table);
    const answer = convertedRecord([splitType(cases)], 'entity', entity('person', { status: 'open' }), judge);
    assert.equal(answer.type, 'openPerson', 'cases a and c are both true: the first is the answer');
    assert.deepEqual(judge.calls.map(c => c.text), [when.a], 'asked in order, and no further than the first true');
    const second = judgeFor(table);
    assert.equal(convertedRecord([splitType(cases)], 'entity', entity('person', { status: 'wip' }), second).type, 'wipPerson');
    assert.deepEqual(second.calls.map(c => c.text), [when.a, when.b]);
  });

  it('hands the judge the kind, the type the split is on, the text, and the record AS IT IS (before any property step)', () => {
    const judge = judgeFor(table);
    const rec = entity('person', { name: 'Ann', status: 'open' });
    convertedRecord([splitType(cases), renameProperty({ type: 'openPerson' })], 'entity', rec, judge);
    assert.equal(judge.calls.length, 1);
    assert.equal(judge.calls[0].kind, 'entity');
    assert.equal(judge.calls[0].from, 'person');
    assert.equal(judge.calls[0].text, when.a);
    assert.deepEqual(judge.calls[0].record, rec, 'the record the judge reads still holds `name`: no rename has run on it');
  });

  it('answers `otherwise` when no case is true, and not-convertible when there is no `otherwise`', () => {
    const rec = entity('person', { status: 'done' });
    assert.equal(convertedRecord([splitType(cases)], 'entity', rec, judgeFor(table)).type, undefined, '`otherwise` is `person`: the type does not change');
    assert.deepEqual(convertedRecord([splitType(cases, { otherwise: 'archived' })], 'entity', rec, judgeFor(table)), { type: 'archived', set: {}, unset: [] });
    assert.deepEqual(convertedRecord([splitType(cases, { otherwise: undefined })], 'entity', rec, judgeFor(table)), { notConvertible: 'no_case_matched' });
  });

  it('a condition that reads a property the record lacks answers false, so the record falls to the next case', () => {
    // The judge's own rule (design 1.4): an absent property reads false. The fake answers as the real one does; the module must go on.
    const absent = judgeFor({ [when.a]: (r) => r.properties && 'status' in r.properties ? r.properties.status === 'open' : false, [when.b]: () => false, [when.c]: () => false });
    const rec = entity('person', { name: 'Ann' });
    assert.deepEqual(convertedRecord([splitType(cases, { otherwise: 'archived' })], 'entity', rec, absent), { type: 'archived', set: {}, unset: [] });
    assert.deepEqual(absent.calls.map(c => c.text), [when.a, when.b, when.c], 'every case was asked, none of them threw');
    assert.deepEqual(convertedRecord([splitType(cases, { otherwise: undefined })], 'entity', rec, absent), { notConvertible: 'no_case_matched' });
  });

  it('a condition the judge could not evaluate makes the record not convertible, and no later case is asked', () => {
    const judge = judgeFor({ [when.a]: () => 'could_not_evaluate', [when.b]: () => true, [when.c]: () => true });
    assert.deepEqual(convertedRecord([splitType(cases)], 'entity', entity('person', { status: 'open' }), judge), { notConvertible: 'could_not_evaluate' });
    assert.deepEqual(judge.calls.map(c => c.text), [when.a]);
  });

  it('only a record of the type the split is on is asked', () => {
    const judge = judgeFor(table);
    assert.deepEqual(convertedRecord([splitType(cases)], 'entity', entity('company', { status: 'open' }), judge), NOTHING);
    assert.equal(judge.calls.length, 0);
  });

  it('a property step on the split\'s target applies to a record the split moved there', () => {
    const answer = convertedRecord([splitType(cases), renameProperty({ type: 'openPerson' })], 'entity', entity('person', { name: 'Ann', status: 'open' }), judgeFor(table));
    assert.deepEqual(answer, { type: 'openPerson', set: { fullName: 'Ann' }, unset: ['name'] });
  });

  it('a record that stays on `otherwise` is moved by the property steps of that type', () => {
    const answer = convertedRecord([splitType(cases), renameProperty({ type: 'person' })], 'entity', entity('person', { name: 'Ann', status: 'done' }), judgeFor(table));
    assert.deepEqual(answer, { set: { fullName: 'Ann' }, unset: ['name'] });
  });
});

describe('renameProperty', () => {
  it('moves the value to the new name and unsets the old', () => {
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { name: 'Ann', age: 3 }), NEVER), { set: { fullName: 'Ann' }, unset: ['name'] });
  });

  it('moves a value that is falsy or null as it moves any other', () => {
    for (const v of [0, '', false, null]) {
      assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { name: v }), NEVER), { set: { fullName: v }, unset: ['name'] }, JSON.stringify(v));
    }
  });

  it('a record without the old name is not changed by it', () => {
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { age: 3 }), NEVER), NOTHING);
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { fullName: 'Ann' }), NEVER), NOTHING);
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', { _id: 'e', type: 'person' }, NEVER), NOTHING, 'a record with no properties at all');
  });

  it('a record holding both the old and the new name is not convertible: neither value may be lost', () => {
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { name: 'Ann', fullName: 'Ann B' }), NEVER), { notConvertible: 'both_set' });
    assert.deepEqual(convertedRecord([renameProperty()], 'entity', entity('person', { name: null, fullName: 'x' }), NEVER), { notConvertible: 'both_set' }, 'a null value is still set');
  });

  it('two renames on one type both apply, and the answer is one whichever came first in the list', () => {
    const steps = [renameProperty(), renameProperty({ from: 'age', to: 'years' })];
    const expected = { set: { fullName: 'Ann', years: 3 }, unset: ['age', 'name'] };
    assert.deepEqual(convertedRecord(steps, 'entity', entity('person', { name: 'Ann', age: 3 }), NEVER), expected, '`unset` is in name order');
    assert.deepEqual(convertedRecord([...steps].reverse(), 'entity', entity('person', { name: 'Ann', age: 3 }), NEVER), expected);
  });

  it('a name an object answers to by inheritance is not a name the record holds', () => {
    assert.deepEqual(convertedRecord([renameProperty({ from: 'toString', to: 'text' })], 'entity', entity('person', { name: 'Ann' }), NEVER), NOTHING);
    assert.deepEqual(convertedRecord([renameProperty({ from: 'name', to: 'constructor' })], 'entity', entity('person', { name: 'Ann' }), NEVER), { set: { constructor: 'Ann' }, unset: ['name'] }, 'the own key is set, not the prototype\'s');
  });
});

describe('mapEnum', () => {
  it('changes a value it has a key for, and only that', () => {
    assert.deepEqual(convertedRecord([mapEnum()], 'entity', entity('person', { status: 'open' }), NEVER), { set: { status: 'OPEN' }, unset: [] });
    assert.deepEqual(convertedRecord([mapEnum()], 'entity', entity('person', { status: 'done' }), NEVER), NOTHING, 'a value with no key stays');
    assert.deepEqual(convertedRecord([mapEnum()], 'entity', entity('person', { name: 'x' }), NEVER), NOTHING, 'an absent property stays absent');
  });

  it('leaves a value that is not a string alone, and a key an object answers to by inheritance', () => {
    assert.deepEqual(convertedRecord([mapEnum({ values: { 1: 'one' } })], 'entity', entity('person', { status: 1 }), NEVER), NOTHING);
    assert.deepEqual(convertedRecord([mapEnum({ values: { open: 'OPEN' } })], 'entity', entity('person', { status: 'toString' }), NEVER), NOTHING);
  });

  it('is read by the AFTER-name: it follows a rename of the property in the same steps', () => {
    const steps = [renameProperty({ from: 'status', to: 'state' }), mapEnum({ property: 'state' })];
    assert.deepEqual(convertedRecord(steps, 'entity', entity('person', { status: 'wip' }), NEVER), { set: { state: 'WIP' }, unset: ['status'] });
    const byOldName = [renameProperty({ from: 'status', to: 'state' }), mapEnum({ property: 'status' })];
    assert.deepEqual(convertedRecord(byOldName, 'entity', entity('person', { status: 'wip' }), NEVER), { set: { state: 'wip' }, unset: ['status'] }, 'the old name no longer names the property');
  });

  it('a record already holding the new name of a renamed property, with the old absent, is mapped in place', () => {
    const steps = [renameProperty({ from: 'status', to: 'state' }), mapEnum({ property: 'state' })];
    assert.deepEqual(convertedRecord(steps, 'entity', entity('person', { state: 'open' }), NEVER), { set: { state: 'OPEN' }, unset: [] });
  });
});

/**
 * An unconverted item keeps each violation's `code` and `params` beside its `field` and `reason`, bounded as the reason is; an item stored
 * before violations had codes is read as it is, without a code and without a migration (Q-943).
 *
 * ## What it prevents
 *
 * The item store wrote `{ field, reason }` only, so the Review page's chips had prose to show and nothing to word. Writing the code is
 * half of it; the other half is the items already stored: they hold text only, and the project's rule on stored data is that a reader
 * tolerates the old shape instead of a boot rewriting it. A reader that assumed the new shape would answer `code: undefined` keys, or
 * throw on a malformed row a peer's older release left.
 *
 * ## What is asserted
 *
 *  1. `unconvertedViolationOf` (the one form an item stores): field and reason bounded at the item's reason bound, `code` and `params`
 *     kept, a list param cut as the renderer cuts it, and a row with no code stored without one.
 *  2. `listedUnconvertedViolations` (the one reading every list and dismiss answer goes through): an old item's rows come back as
 *     `{ field, reason }` with no `code` key; a new item's keep `code` and `params`; a row whose code or params are malformed or missing
 *     keeps its text and drops both (a code is worded with its params); anything that is not a list reads as none.
 *
 * Seen red on d7a18d17c: neither function exists.
 *
 * Run: node --test testing/standalone/an-unconverted-item-keeps-its-violations-codes-and-reads-old-ones-as-they-are.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const terms = await import('../../server/dist/spaces/unconverted-terms.js');
const { peerText } = await import('../../server/dist/util/log.js');
const fn = (name) => terms[name] ?? (() => { throw new Error(`${name} is not exported by spaces/unconverted-terms.ts`); });

describe('the stored form of a violation', () => {
  it('keeps the code and params beside the bounded field and reason', () => {
    const stored = fn('unconvertedViolationOf')({ field: 'properties.age', value: 'old', reason: "expected type 'number', got 'string'", code: 'type', params: { type: 'number', got: 'string' } });
    assert.deepEqual(stored, { field: 'properties.age', reason: "expected type 'number', got 'string'", code: 'type', params: { type: 'number', got: 'string' } });
  });

  it('bounds the reason as before and cuts a list param', () => {
    const many = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const reason = `must be one of: ${many.join(', ')}`.repeat(10);
    const stored = fn('unconvertedViolationOf')({ field: 'properties.rank', reason, code: 'enum', params: { allowedValues: many } });
    assert.equal(stored.reason, peerText(reason, { max: 300 }), 'the reason is not bounded as an item\'s reason always was (300, through peerText)');
    assert.equal(stored.params.allowedValues.length, 51);
    assert.equal(stored.params.allowedValues.at(-1), '…(+10 more)');
  });

  it('a row with no code is stored without one', () => {
    assert.deepEqual(fn('unconvertedViolationOf')({ field: '', reason: 'TypeError' }), { field: '', reason: 'TypeError' });
  });
});

describe('reading the stored violations', () => {
  const read = (v) => fn('listedUnconvertedViolations')(v);

  it('an item stored before codes reads as it is: no code key, no params key', () => {
    const rows = read([{ field: 'properties.age', reason: "expected type 'number', got 'string'" }]);
    assert.deepEqual(rows, [{ field: 'properties.age', reason: "expected type 'number', got 'string'" }]);
    assert.equal(Object.hasOwn(rows[0], 'code'), false);
  });

  it('an item stored with codes keeps them', () => {
    const row = { field: 'properties.rank', reason: 'must be one of: low, high', code: 'enum', params: { allowedValues: ['low', 'high'] } };
    assert.deepEqual(read([row]), [row]);
  });

  it('a malformed code or params drops both (they are worded together) and keeps the text', () => {
    assert.deepEqual(read([{ field: 'f', reason: 'r', code: 7, params: {} }]), [{ field: 'f', reason: 'r' }]);
    assert.deepEqual(read([{ field: 'f', reason: 'r', code: 'enum', params: ['x'] }]), [{ field: 'f', reason: 'r' }]);
    assert.deepEqual(read([{ field: 'f', reason: 'r', code: 'enum' }]), [{ field: 'f', reason: 'r' }]);
  });

  it('anything that is not a list reads as none, and a row that is not an object is left out', () => {
    assert.deepEqual(read(undefined), []);
    assert.deepEqual(read({ field: 'f' }), []);
    assert.deepEqual(read([null, 'x', { field: 'f', reason: 'r' }]), [{ field: 'f', reason: 'r' }]);
  });
});

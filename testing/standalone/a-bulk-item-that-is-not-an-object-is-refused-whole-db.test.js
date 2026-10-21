/**
 * A bulk item that is not a JSON object is refused as the caller's mistake, before anything is written (Q-458, design-vet S1).
 *
 * ## The defect
 *
 * `save_bulk` skips schema validation so it can report per-item errors, which left the shape of an ITEM to the batch writer. A `null`
 * item reached `prepareItems` as `item['fact']` and threw a `TypeError`. While every thrown failure was a `400` that was "the caller
 * sent something wrong" in the runtime's words; now that a `TypeError` is the server fault it is, a caller's `{"facts":[null]}` answered
 * a `500` and was logged as a fault of ours on every door. A primitive or an array as an item did not throw, and was quietly answered as
 * a batch that wrote nothing, with no error row naming it.
 *
 * ## What it asserts
 *
 * Every item of every record array is a JSON object, or the whole batch is refused `400` in our words, naming the array and index,
 * before the first write, on the tool doors (MCP and `POST /api/<tool>`) and by the one function the REST route and the writer both ask
 * (`bulkBatchRefusal`, which holds the size cap too, so neither door can drop either half).
 *
 * Run: node --test testing/standalone/a-bulk-item-that-is-not-an-object-is-refused-whole-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'bulkitemshape';
const VALID = { fact: 'a fact that is stored only if the whole batch is well formed' };

const BAD = [['null', null], ['a number', 5], ['a string', 'x'], ['an array', []]];
const ARRAYS = ['facts', 'entities', 'edges', 'chrono'];

describe('a bulk item that is not an object refuses the whole batch', { skip }, () => {
  let acts;
  before(async () => { acts = await openFileActDoors({ suite: 'bulkitemshape', space: S }); });
  after(async () => { await acts?.close(); });

  for (const array of ARRAYS) {
    for (const [what, bad] of BAD) {
      it(`${array}: ${what} at index 1 is a 400 naming ${array}[1], on both tool doors`, async () => {
        const args = { [array]: [array === 'facts' ? VALID : {}, bad] };
        const m = await acts.mcp('save_bulk', args);
        assert.equal(m.status, 400, `MCP answered ${m.status}: ${m.text}`);
        assert.ok(m.text.includes(`${array}[1]`), `MCP did not name the item: ${m.text}`);
        assert.ok(!/Internal server error|TypeError|Cannot read/.test(m.text), `MCP said the runtime's words: ${m.text}`);
        const t = await acts.tool('save_bulk', args);
        assert.equal(t.code, 400, `the tool route answered ${t.code}: ${JSON.stringify(t.body)}`);
        assert.ok(JSON.stringify(t.body).includes(`${array}[1]`), `the tool route did not name the item: ${JSON.stringify(t.body)}`);
      });
    }
  }

  it('the writer itself refuses it with our typed refusal, before it reads or writes anything', async () => {
    const { bulkWrite } = await import('../../server/dist/brain/bulk.js');
    const { RequestRefusal } = await import('../../server/dist/util/errors.js');
    await assert.rejects(bulkWrite(S, { facts: [{ fact: `${VALID.fact} ${Date.now()}` }, null] }), (err) => err instanceof RequestRefusal && /facts\[1\]/.test(err.message));
  });

  it('a batch of objects is unchanged: it is written', async () => {
    const m = await acts.mcp('save_bulk', { facts: [{ fact: `well formed ${Date.now()}` }] });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.sc.inserted?.facts, 1, m.text);
  });
});

describe('the one function both doors ask', () => {
  it('bulkBatchRefusal holds the item shape and the size cap, and the REST route and the writer both call it', async () => {
    const { bulkBatchRefusal, BULK_MAX_PER_TYPE } = await import('../../server/dist/brain/bulk.js');
    assert.match(bulkBatchRefusal({ facts: [null] }) ?? '', /facts\[0\]/);
    assert.match(bulkBatchRefusal({ chrono: [{ title: 't' }, 'x'] }) ?? '', /chrono\[1\]/);
    assert.match(bulkBatchRefusal({ facts: Array.from({ length: BULK_MAX_PER_TYPE + 1 }, () => ({})) }) ?? '', /at most/);
    assert.equal(bulkBatchRefusal({ facts: [{ fact: 'a' }], edges: [] }), null);
    assert.equal(bulkBatchRefusal({}), null);
    for (const file of ['server/src/api/brain/bulk.ts', 'server/src/brain/bulk.ts']) {
      const text = readFileSync(file, 'utf8');
      assert.ok(/bulkBatchRefusal\(/.test(text.replace(/export function bulkBatchRefusal/, '')), `${file} no longer asks bulkBatchRefusal`);
    }
  });
});

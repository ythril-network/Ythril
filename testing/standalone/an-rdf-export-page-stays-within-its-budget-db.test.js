/**
 * A page of the RDF export stays within its stated budget, ending included, and says what it sent (bundle-269 review, finding 3).
 *
 * The budget counted the start of the document and its records but not the ending (up to a hundred named values in the report node and the
 * closing comment), and MCP carried the named list three times (the document, the summary block, `structuredContent`). A space with many
 * values that no longer fit their declared type made an MCP answer several times its budget.
 *
 * ## What it holds
 *
 * - 150 left-out values, MCP `export_rdf` at its default budget: every text block plus `structuredContent` together stay within the stated
 *   ceiling (`budgetChars`), `charsReturned` is the document's length, and the summary names at most `SUMMARY_NAMED_MAX` values, counting
 *   the rest.
 * - The REST page with `maxChars` stays within it too, and its report says how many values it named.
 * - A page of two or more records never exceeds its ceiling, its ending included, however long the cursor its ending repeats (bundle-269
 *   drive, finding 8: a long record id made the ending outgrow the share kept for it). Only a page of ONE record may: a record is never cut,
 *   so the first one is sent whole with the document's start and ending (the drive's `maxChars=3000`, one record, 4830 characters).
 * - A ceiling out of range is held to the bounds every budgeted read uses (1 000 to 5 000 000 characters) and the bound used is said
 *   (`Ythril-Budget-Chars`), as `resolveBudget` holds it for `recall` and `filter`; one that is no positive whole number is
 *   `400 rdf_bad_budget`.
 *
 * Run: node --test testing/standalone/an-rdf-export-page-stays-within-its-budget-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfbudget';
/** A space whose second record has a long id: the cursor after it, which the ending states twice, is long. */
const LONG = 'rdfbudgetlong';
const LONG_ID = `b${'x'.repeat(1_199)}`;
const recordCount = (text) => Number(/ythril\/ns#recordCount> "(\d+)"/.exec(text)?.[1] ?? NaN);

describe('an RDF export page stays within its budget', { skip, timeout: 300_000 }, () => {
  let d, admin, act;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_budget', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, {
      typeSchemas: { entity: { Item: { propertySchemas: { size: { type: 'number' } } } } },
    }) }, { id: LONG, meta: rdfMeta(LONG) }] });
    await d.seed(LONG, 'entity', [
      { _id: 'a1', name: 'First', description: 'd'.repeat(500) },
      { _id: LONG_ID, name: 'Long', author: null, updatedAt: null },
      { _id: `c${'y'.repeat(1_199)}`, name: 'Third', author: null, updatedAt: null },
    ]);
    // A property retyped from text to number: 150 stored values no longer fit.
    await d.seed(SPACE, 'entity', Array.from({ length: 150 }, (_, i) => ({ _id: `item-with-a-longer-id-${String(i).padStart(4, '0')}`, name: `Item ${i}`, type: 'Item', properties: { size: `large-${i}` } })));
    admin = await d.mint('admin', {}, { admin: true });
    act = await import('../../server/dist/rdf/export-act.js');
  });
  after(async () => { await d?.close(); });

  it('MCP at the default budget: the whole answer within the ceiling, the document counted, the summary bounded', async () => {
    const m = await d.exportMcp(admin.key, { space: SPACE, format: 'nquads' });
    assert.equal(m.isError, false, m.text.slice(0, 300));
    const sent = m.blocks.reduce((n, b) => n + b.length, 0) + JSON.stringify(m.structured).length;
    assert.ok(sent <= m.structured.budgetChars, `the answer carried ${sent} characters against a budget of ${m.structured.budgetChars}`);
    assert.equal(m.structured.charsReturned, m.document.length, 'charsReturned is what the document holds');
    assert.equal(typeof act.SUMMARY_NAMED_MAX, 'number', 'export-act.ts exports SUMMARY_NAMED_MAX');
    assert.ok(m.structured.skippedValues.named.length <= act.SUMMARY_NAMED_MAX);
    assert.equal(m.structured.skippedValues.named.length + m.structured.skippedValues.unnamed, m.structured.skippedValues.count);
  });

  it('a REST page with maxChars stays within it, ending included', async () => {
    const r = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: 6000 });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(r.text.length <= 6000, `the page is ${r.text.length} characters against 6000`);
  });

  it('a page of two or more records never exceeds its ceiling, however long the cursor its ending states', async () => {
    // The ceiling that just admits the first two records beside the least share kept for the ending, measured from the whole export: the
    // ending after them states the cursor after the long id twice (`ythril:nextAfter` and the closing comment), more than that share.
    const whole = await d.exportRest(admin.key, LONG, { format: 'nquads', maxChars: 5_000_000 });
    const lines = whole.text.split('\n');
    const size = (pred) => lines.filter(pred).reduce((n, l) => n + l.length + 1, 0);
    const first = size(l => l.startsWith(`<${baseOf(LONG)}entity/a1>`) || l.startsWith(`<${baseOf(LONG)}agent/`));
    const second = size(l => l.startsWith(`<${baseOf(LONG)}entity/${LONG_ID}>`));
    const head = lines[0].length + 1;
    const ENDING_RESERVE_MIN = 3_000;
    const ceiling = head + first + second + ENDING_RESERVE_MIN;
    assert.ok(first > 0 && second > 0 && ceiling <= 4 * ENDING_RESERVE_MIN, `the fixture's sizes: ${JSON.stringify({ head, first, second, ceiling })}`);
    const r = await d.exportRest(admin.key, LONG, { format: 'nquads', maxChars: ceiling });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const n = recordCount(r.text);
    assert.ok(n === 1 || r.text.length <= ceiling, `a page of ${n} records is ${r.text.length} characters against ${ceiling}`);
    assert.match(r.headers['link'] ?? '', /rel="next"/, 'what did not fit is on the next page');
  });

  it('only a page of one record may exceed it: the drive\'s maxChars=3000 is one whole record', async () => {
    const r = await d.exportRest(admin.key, LONG, { format: 'nquads', maxChars: 3_000 });
    assert.equal(r.status, 200);
    assert.equal(recordCount(r.text), 1);
    assert.equal(r.headers['ythril-budget-chars'], '3000');
  });

  it('a ceiling out of range is held to the bounds every budgeted read uses, and the bound used is said', async () => {
    const above = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: 5_000_001 });
    assert.equal(above.status, 200);
    assert.equal(above.headers['ythril-budget-chars'], '5000000');
    const below = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: 1 });
    assert.equal(below.status, 200);
    assert.equal(below.headers['ythril-budget-chars'], '1000');
    // The same bounds as every budgeted read: `resolveBudget` (brain/result-budget.ts) holds the character ceiling to them.
    const { MIN_MAX_BYTES, MAX_MAX_BYTES } = await import('../../server/dist/brain/result-budget.js');
    assert.deepEqual([MIN_MAX_BYTES, MAX_MAX_BYTES], [1_000, 5_000_000]);
    for (const bad of [0, 1.5, 'abc']) {
      const r = await d.exportRest(admin.key, SPACE, { format: 'nquads', maxChars: bad });
      assert.equal(r.status, 400, `maxChars=${bad}`);
      assert.equal(r.body?.code, 'rdf_bad_budget');
    }
  });
});

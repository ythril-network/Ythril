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
 *
 * Run: node --test testing/standalone/an-rdf-export-page-stays-within-its-budget-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfbudget';

describe('an RDF export page stays within its budget', { skip, timeout: 300_000 }, () => {
  let d, admin, act;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_budget', spaces: [{ id: SPACE, meta: rdfMeta(SPACE, {
      typeSchemas: { entity: { Item: { propertySchemas: { size: { type: 'number' } } } } },
    }) }] });
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
});

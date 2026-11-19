/**
 * Two spaces of one instance that hold the same RDF base are refused by both exports, so no two files give one address two meanings
 * (bundle-269 drive, finding 10).
 *
 * The drive gave two spaces one base: each export was answered, and `<base>schema` then named two different ontologies (and `<base>vocab/`
 * terms with different definitions). A base is what makes a space's addresses its own; one held by two spaces of the instance makes none
 * of them settled. Both exports answer `409 rdf_base_shared` for either space, naming the other space only to a caller who may read its
 * schema (the no-trace rule: a refusal names nothing the caller could not read through the other doors).
 *
 * Run: node --test testing/standalone/two-spaces-with-one-base-are-refused-by-the-exports-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const ONE = 'rdfsharedone';
const TWO = 'rdfsharedtwo';
const ALONE = 'rdfsharedalone';

describe('two spaces with one base are refused by the exports', { skip }, () => {
  let d, admin, onlyOne;
  before(async () => {
    // The drive's setup: the second space holds the first one's base.
    const two = rdfMeta(TWO);
    two.rdf = { ...two.rdf, base: baseOf(ONE), vocab: `${baseOf(ONE)}vocab/` };
    d = await openRdfExportDoors({ suite: 'rdf_export_shared_base', spaces: [
      { id: ONE, meta: rdfMeta(ONE) }, { id: TWO, meta: two }, { id: ALONE, meta: rdfMeta(ALONE) },
    ] });
    await d.seed(ONE, 'entity', [{ _id: 'e1', name: 'One' }]);
    await d.seed(TWO, 'entity', [{ _id: 'e2', name: 'Two' }]);
    admin = await d.mint('admin', {}, { admin: true });
    onlyOne = await d.mint('onlyone', { [ONE]: d.row({ knowledge: 'read', schema: 'read' }) });
  });
  after(async () => { await d?.close(); });

  it('both exports of either space answer 409 rdf_base_shared, on both doors', async () => {
    for (const space of [ONE, TWO]) {
      for (const r of [await d.exportRest(admin.key, space, {}), await d.exportRest(admin.key, space, { limit: 5 }), await d.schemaRest(admin.key, space, {})]) {
        assert.equal(r.status, 409, `${space}: ${r.text.slice(0, 300)}`);
        assert.equal(r.body?.code, 'rdf_base_shared');
      }
      const m = await d.exportMcp(admin.key, { space });
      assert.equal(m.isError, true);
      assert.match(m.text, /rdf_base_shared/);
      const s = await d.schemaMcp(admin.key, { space });
      assert.equal(s.isError, true);
      assert.match(s.text, /rdf_base_shared/);
    }
  });

  it('the other space is named only to a caller who may read its schema', async () => {
    const told = await d.exportRest(admin.key, ONE, {});
    assert.match(told.body?.error ?? '', new RegExp(TWO));
    const untold = await d.exportRest(onlyOne.key, ONE, {});
    assert.equal(untold.status, 409);
    assert.equal(untold.body?.code, 'rdf_base_shared');
    assert.doesNotMatch(JSON.stringify(untold.body), new RegExp(TWO), 'a space the caller cannot read leaves no trace');
  });

  it('a space with a base of its own exports as before', async () => {
    const r = await d.exportRest(admin.key, ALONE, {});
    assert.equal(r.status, 200, r.text.slice(0, 200));
  });
});

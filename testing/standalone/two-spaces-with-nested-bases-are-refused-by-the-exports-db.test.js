/**
 * Two spaces of one instance whose RDF bases are nested (one starts the other) are refused by the exports, the SPARQL endpoint and the
 * Linked Data doors, as two spaces with one base are (bundle-271, Q-758 lens-2 I2).
 *
 * The save doors refuse to make such a pair (`409 rdf_base_nested`), but a pair a peer's round delivered or an older build stored exists, and
 * `/ld/` resolves an address to the space holding the longest base that starts it: the inner base shadows every address of the outer space
 * it sits in. `rdfSpaceState` (the one question every RDF door asks of a space) names the pair unsettled, `409 rdf_base_nested`, for either
 * space, the other named only to a caller who may read its schema.
 *
 * ## Seen red
 *
 * On d78b20280 both exports of either space answered 200: the nested pair was never asked about outside the save.
 *
 * Run: node --test testing/standalone/two-spaces-with-nested-bases-are-refused-by-the-exports-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, baseOf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const OUTER = 'rdfnestouter';
const INNER = 'rdfnestinner';
const ALONE = 'rdfnestalone';
const PUBLIC = 'https://rdf.example.org';

describe('two spaces with nested bases are refused by the doors', { skip }, () => {
  let d, admin, onlyOuter;
  const previousPublic = process.env['PUBLIC_BASE_URL'];
  before(async () => {
    // A pair the save doors would refuse, stored as a peer's round or an older build could leave it: the inner base starts with the outer one.
    const inner = rdfMeta(INNER);
    inner.rdf = { ...inner.rdf, base: `${baseOf(OUTER)}inner/`, vocab: `${baseOf(OUTER)}inner/vocab/` };
    d = await openRdfExportDoors({ suite: 'rdf_export_nested_base', spaces: [
      { id: OUTER, meta: rdfMeta(OUTER) }, { id: INNER, meta: inner }, { id: ALONE, meta: rdfMeta(ALONE) },
    ] });
    await d.seed(OUTER, 'entity', [{ _id: 'e1', name: 'Outer' }]);
    await d.seed(INNER, 'entity', [{ _id: 'e2', name: 'Inner' }]);
    admin = await d.mint('admin', {}, { admin: true });
    onlyOuter = await d.mint('onlyouter', { [OUTER]: d.row({ knowledge: 'read', schema: 'read' }) });
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await d?.close();
  });

  it('both exports of either space answer 409 rdf_base_nested, on both doors', async () => {
    for (const space of [OUTER, INNER]) {
      for (const r of [await d.exportRest(admin.key, space, {}), await d.exportRest(admin.key, space, { limit: 5 }), await d.schemaRest(admin.key, space, {})]) {
        assert.equal(r.status, 409, `${space}: ${r.text.slice(0, 300)}`);
        assert.equal(r.body?.code, 'rdf_base_nested');
      }
      const m = await d.exportMcp(admin.key, { space });
      assert.equal(m.isError, true);
      assert.match(m.text, /rdf_base_nested/);
      const s = await d.schemaMcp(admin.key, { space });
      assert.equal(s.isError, true);
      assert.match(s.text, /rdf_base_nested/);
    }
  });

  it('an address of the outer space answers the same 409 at /ld/, never a record of the inner space', async () => {
    const both = await d.mint('both', { [OUTER]: d.row({ knowledge: 'read' }), [INNER]: d.row({ knowledge: 'read' }) });
    // The outer space's own addresses (the inner base's addresses are deeper than the routes of /ld/ go).
    for (const path of [`/ld/${OUTER}/entity/e1`, `/ld/${OUTER}/`]) {
      const r = await d.restGet(both.key, path, { Accept: 'text/turtle' });
      assert.equal(r.status, 409, `${path}: ${r.text.slice(0, 300)}`);
      assert.equal(JSON.parse(r.text).code, 'rdf_base_nested');
    }
  });

  it('the other space is named only to a caller who may read its schema', async () => {
    const told = await d.exportRest(admin.key, OUTER, {});
    assert.match(told.body?.error ?? '', new RegExp(INNER));
    const untold = await d.exportRest(onlyOuter.key, OUTER, {});
    assert.equal(untold.status, 409);
    assert.equal(untold.body?.code, 'rdf_base_nested');
    assert.doesNotMatch(JSON.stringify(untold.body), new RegExp(INNER), 'a space the caller cannot read leaves no trace');
  });

  it('a space with a base of its own exports as before', async () => {
    const r = await d.exportRest(admin.key, ALONE, {});
    assert.equal(r.status, 200, r.text.slice(0, 200));
  });
});

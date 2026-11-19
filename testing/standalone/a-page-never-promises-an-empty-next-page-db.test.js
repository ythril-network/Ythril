/**
 * A page of the RDF export promises a next page only when a record of the export is left (bundle-269 review, finding 4). The look-ahead read
 * counted every row, fork rows and edges with no addressable end included, which the walk leaves out: a page could say `complete false`, give
 * `nextAfter` and `Link: rel="next"`, and the next page hold nothing.
 *
 * Run: node --test testing/standalone/a-page-never-promises-an-empty-next-page-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfnoemptynext';

describe('a page never promises an empty next page', { skip }, () => {
  let d, admin;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_no_empty_next', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', [
      { _id: 'e1', name: 'One' }, { _id: 'e2', name: 'Two' },
      // Behind the last exportable entity: fork rows, which the export leaves out.
      { _id: 'e3', name: 'Fork of one', forkOf: 'e1' }, { _id: 'e4', name: 'Fork of two', forkOf: 'e2' },
    ]);
    // And an edge whose end cannot be addressed, which the export leaves out too.
    await d.seed(SPACE, 'edge', [{ _id: 'k1', from: '', to: 'e1', label: 'knows' }]);
    admin = await d.mint('admin', {}, { admin: true });
  });
  after(async () => { await d?.close(); });

  it('a page ending on the last exportable record is complete, with no next page, on both doors', async () => {
    const r = await d.exportRest(admin.key, SPACE, { format: 'nquads', limit: 2 });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.headers['link'], undefined, 'no next page is promised');
    assert.match(r.text, /ythril\/ns#complete> "true"/);
    const m = await d.exportMcp(admin.key, { space: SPACE, format: 'nquads', limit: 2 });
    assert.equal(m.structured.complete, true);
    assert.equal(m.structured.nextAfter, undefined);
  });
});

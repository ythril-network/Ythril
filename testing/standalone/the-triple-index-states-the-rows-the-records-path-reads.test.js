/**
 * Two points the review of the triple index left unproven, settled by a check each (bundle-273, Q-764, review points V2 and V5).
 *
 * ## The points
 *
 * - **V2: a file row the live-file filter leaves out has no statements.** `rdfRowFilter` (the records path) leaves out a file row with
 *   `deletedAt`, `parentFileId` or `feedMarker` present, a `null` value included (`$exists: false`). The mapper the follower and a rebuild
 *   state records with must leave out the same rows, or the index states a row the records path does not read: a row a peer sent may carry
 *   a `null`.
 * - **V5: every collection the follower reads by position has a `(pos, _id)` index**, the six record collections and the tombstones, so
 *   `lagOf` (the barrier) and the follower's `changesAfter` are index-served.
 *
 * ## Seen red
 *
 * On d5192c4f6: V2 fails (the mapper answers statements for a file row with `deletedAt: null`); V5 holds.
 *
 * Run: npm run build:server, then
 *      node --test testing/standalone/the-triple-index-states-the-rows-the-records-path-reads.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rdfMeta } from './_rdf-export-doors.mjs';

describe('the triple index states the rows the records path reads', () => {
  it('V2: a file row with a null deletedAt, parentFileId or feedMarker has no statements, as the live-file filter reads it', async () => {
    const { recordTriples } = await import('../../server/dist/rdf/record-triples.js');
    const { LIVE_FILE_ROW, NOT_A_FEED_MARKER } = await import('../../server/dist/files/live-file-row.js');
    const live = { _id: 'docs/a.txt', path: 'docs/a.txt', sizeBytes: 1, sha256: 'ab'.repeat(32), createdAt: '2026-03-04T05:06:07.000Z', updatedAt: '2026-03-04T05:06:07.000Z', tags: [] };
    const meta = rdfMeta('tixp-points');
    assert.equal(recordTriples(meta, 'file', live, { edgeDetails: 'rdf12' }).leftOut, undefined, 'a live file row states its statements');
    for (const [field, filter] of [['deletedAt', LIVE_FILE_ROW.deletedAt], ['parentFileId', LIVE_FILE_ROW.parentFileId], ['feedMarker', NOT_A_FEED_MARKER.feedMarker]]) {
      assert.deepEqual({ ...filter }, { $exists: false }, `the records path leaves out a row that has ${field}, null included`);
      const form = recordTriples(meta, 'file', { ...live, [field]: null }, { edgeDetails: 'rdf12' });
      assert.equal(form.leftOut, 'not-live', `the mapper leaves out a file row whose ${field} is null, as the records path does`);
      assert.deepEqual(form.quads, [], `and states nothing for it (${field})`);
    }
  });

  it('V5: the six record collections and the tombstones each have a (pos, _id) index', async () => {
    const { SPACE_INDEXES } = await import('../../server/dist/spaces/space-indexes.js');
    const { RDF_KIND_COLLECTIONS } = await import('../../server/dist/rdf/rdf-members.js');
    const parts = [...RDF_KIND_COLLECTIONS.map(k => k.collection), 'tombstones'];
    assert.equal(new Set(parts).size, 7, `six record collections and the tombstones: ${parts.join(', ')}`);
    for (const part of parts) {
      const ix = SPACE_INDEXES.find(i => i.part === part && JSON.stringify(i.keys) === JSON.stringify({ pos: 1, _id: 1 }));
      assert.ok(ix, `${part} has a (pos, _id) index`);
      assert.equal(ix.options.partialFilterExpression, undefined, `the (pos, _id) index of ${part} is not partial: a count above a position uses it`);
    }
  });
});

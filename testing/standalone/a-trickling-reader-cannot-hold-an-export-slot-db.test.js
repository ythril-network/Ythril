/**
 * A whole export that is read too slowly is ended, truthfully, and frees its slot (bundle-269 review, finding 9). The idle bound only cuts a
 * write that does not drain at all; a reader taking a little at a time (a store page within every idle bound) held its slot for as long as it
 * liked, and two such readers held the instance's two.
 *
 * The rule: after a grace period the stream must average at least a minimum rate (`RDF_EXPORT_MIN_BYTES_PER_SECOND` after
 * `RDF_EXPORT_RATE_GRACE_MS`), set short here through the product's own setter. When it is not met the stream ends with the incomplete
 * form (written while the socket still takes it), `Ythril-Export-Complete: false`, and the slot is free.
 *
 * Run: node --test testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdftrickle';

describe('a trickling reader cannot hold an export slot', { skip, timeout: 300_000 }, () => {
  let d, act, tok;
  before(async () => {
    d = await openRdfExportDoors({ suite: 'rdf_export_trickle', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', Array.from({ length: 900 }, (_, i) => ({ _id: `t${String(i).padStart(4, '0')}`, name: `Trickle ${i}` })));
    act = await import('../../server/dist/rdf/export-act.js');
    tok = await d.mint('reader', { [SPACE]: d.row({ knowledge: 'read' }) });
  });
  after(async () => { act?.setRdfExportRateForTest?.(null); await d?.close(); });

  it('a stream slower than the minimum rate ends incomplete and frees its slot', async () => {
    assert.equal(typeof act.setRdfExportRateForTest, 'function', 'export-act.ts exports setRdfExportRateForTest');
    // A bound no reader can meet: every reader is a trickling one against it.
    act.setRdfExportRateForTest({ graceMs: 0, minBytesPerSecond: 1e12 });
    let r;
    try { r = await d.exportRest(tok.key, SPACE, { format: 'nquads' }); } finally { act.setRdfExportRateForTest(null); }
    assert.equal(r.status, 200);
    assert.equal(r.trailers['ythril-export-complete'], 'false');
    assert.match(r.text, /INCOMPLETE[^\n]*too slowly/);
    await assert.rejects(parseRdf('nquads', r.text), 'a stream cut by the rate bound is never read as whole');
    await waitFor(async () => (await d.exportRest(tok.key, SPACE, { format: 'nquads', limit: 3 })).status === 200, 15_000, 200,
      () => 'the slot of the cut stream was not freed');
  });
});

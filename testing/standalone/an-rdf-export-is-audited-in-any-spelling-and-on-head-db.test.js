/**
 * The RDF exports are audited by the product's rules for every request: in any spelling of their paths, and on a `HEAD` (bundle-269, the
 * rebase onto the rights fix).
 *
 * ## The rule
 *
 * The audit matches a request the way the server routes it (`http/path-spelling.ts`: any casing, one trailing slash) and records a `HEAD`
 * as the `GET` it mirrors (`http/governed-method.ts`), with `method: 'HEAD'`. The bundle's two export rules (`rdf.export`, written
 * whenever the answer finishes or is cut off; `schema.rdf.export`, a read) were written before those rules: keyed by the path as typed and
 * the method as sent, a copy of a space's records asked for as `/API/Brain/...` or with a trailing slash left the instance unrecorded,
 * and a `HEAD` left no row.
 *
 * ## What must hold, for each export
 *
 *  1. a `GET` in each spelling (as written, re-cased, a trailing slash) answers 200 and leaves one row of the export's operation, its
 *     `path` the one the caller sent;
 *  2. a `HEAD` answers 200 with no content and leaves one row of the same operation, `method: 'HEAD'`, that counts nothing as written
 *     and does not say the copy was cut off.
 *
 * `schema.rdf.export` is a read, so these run with `audit.logReads` on.
 *
 * Seen red on the bundle before the rebase (35fec79be): no row for a re-cased or slashed path, and none for a `HEAD`.
 *
 * Run: node --test testing/standalone/an-rdf-export-is-audited-in-any-spelling-and-on-head-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfaudited';

/** Each export: its path as the route table writes it, and the operation its rows carry. */
const EXPORTS = [
  { name: 'the records export', path: `/api/brain/spaces/${SPACE}/export/rdf`, recased: `/API/Brain/Spaces/${SPACE}/Export/RDF`, operation: 'rdf.export' },
  { name: 'the schema export', path: `/api/spaces/${SPACE}/schema-rdf`, recased: `/API/Spaces/${SPACE}/Schema-RDF`, operation: 'schema.rdf.export' },
];

/** The documents a row says were written (the numeric `to` of its changes), and whether it says the copy was cut off. */
function writtenBy(row) {
  const changes = row.changes ?? [];
  return {
    documents: changes.reduce((sum, c) => sum + (typeof c.to === 'number' ? c.to : 0), 0),
    cutOff: changes.some(c => c.field === 'complete' && c.to === false),
  };
}

describe('the RDF exports are audited in any spelling of their paths and on a HEAD (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, reader;
  /** The rows of `operation` the reader's requests left, once the writer has landed them. */
  const rowsOf = async (filter) => {
    await untilAuditWritesLanded();
    return d.col('audit_log').find({ tokenId: reader.id, ...filter }).toArray();
  };
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    d = await openRdfExportDoors({ suite: 'rdf_export_audited', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] });
    await d.seed(SPACE, 'entity', [{ _id: 'a1', name: 'Audited one' }, { _id: 'a2', name: 'Audited two' }]);
    d.loader.mutateConfig(c => { c.audit = { ...(c.audit ?? {}), logReads: true }; });
    reader = await d.mint('rdf-audited-reader', { [SPACE]: d.row({ knowledge: 'read', schema: 'read' }) });
  });
  after(async () => {
    await d?.close();
  });

  for (const exp of EXPORTS) {
    for (const [spelling, sent] of [['as written', exp.path], ['re-cased', exp.recased], ['with a trailing slash', `${exp.path}/`]]) {
      it(`${exp.name}, ${spelling}: a GET leaves one ${exp.operation} row with the path sent`, async () => {
        await d.col('audit_log').deleteMany({ tokenId: reader.id });
        const got = await d.rest(reader.key, 'GET', sent);
        assert.equal(got.status, 200, `GET ${sent} (${got.status} ${got.text.slice(0, 200)})`);
        const rows = await rowsOf({ method: 'GET', operation: exp.operation });
        assert.deepEqual(rows.map(r => r.path), [sent], `GET ${sent} must leave one ${exp.operation} row, its path as sent`);
      });
    }

    it(`${exp.name}: a HEAD answers no content and leaves one ${exp.operation} row that counts nothing as written`, async () => {
      await d.col('audit_log').deleteMany({ tokenId: reader.id });
      const got = await d.rest(reader.key, 'HEAD', exp.path);
      assert.equal(got.status, 200, `HEAD ${exp.path} (${got.status})`);
      assert.equal(got.text, '', 'a HEAD has no content');
      const rows = await rowsOf({ method: 'HEAD', operation: exp.operation });
      assert.equal(rows.length, 1, `a HEAD left ${rows.length} ${exp.operation} rows`);
      const written = writtenBy(rows[0]);
      assert.equal(written.documents, 0, 'the HEAD row counts documents as written that were never sent');
      assert.equal(written.cutOff, false, 'the HEAD row says the copy was cut off');
    });
  }
});

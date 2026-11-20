/**
 * The records export of a space called like a record kind leaves its audit row, with `audit.logReads` off (bundle-269, review finding 3).
 *
 * ## The rule
 *
 * `rdf.export` is written whenever the answer finishes or is cut off, whichever way the operator set `audit.logReads`, under the space the
 * request names. The route rules once read `GET /api/brain/spaces/files/export/rdf` as the file-list read (a read, dropped when logReads is
 * off) of a space called `spaces`, so an export of a space called `files` (or `facts`, `entities`, `edges`, `chrono`) left no row. The rule
 * table's own half is `an-audit-rule-answers-for-its-own-route-whatever-a-space-is-called.test.js`; this drives the real routes.
 *
 * Run: node --test testing/standalone/an-rdf-export-of-a-space-named-like-a-record-kind-is-audited-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';

const skip = await mongoSkipReason();
const WORDS = ['facts', 'entities', 'edges', 'chrono', 'files'];

describe('an RDF export of a space named like a record kind is audited with logReads off (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, reader;
  before(async () => {
    process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    d = await openRdfExportDoors({ suite: 'rdf_export_kind_named', spaces: WORDS.map(id => ({ id, meta: rdfMeta(id) })) });
    // logReads stays at its default (off): the export is no read, and its row must not depend on the setting.
    assert.notEqual(d.loader.getConfig().audit?.logReads, true);
    reader = await d.mint('rdf-kind-named-reader', Object.fromEntries(WORDS.map(id => [id, d.row({ knowledge: 'read' })])));
  });
  after(async () => { await d?.close(); });

  for (const word of WORDS) {
    it(`GET /api/brain/spaces/${word}/export/rdf leaves one rdf.export row of the space '${word}'`, async () => {
      await d.col('audit_log').deleteMany({ tokenId: reader.id });
      const sent = `/api/brain/spaces/${word}/export/rdf`;
      const got = await d.rest(reader.key, 'GET', sent);
      assert.equal(got.status, 200, `GET ${sent} (${got.status} ${got.text.slice(0, 200)})`);
      await untilAuditWritesLanded();
      const rows = await d.col('audit_log').find({ tokenId: reader.id }).toArray();
      assert.deepEqual(rows.map(r => [r.operation, r.spaceId]), [['rdf.export', word]], `the rows GET ${sent} left: ${JSON.stringify(rows.map(r => [r.operation, r.spaceId]))}`);
    });
  }
});

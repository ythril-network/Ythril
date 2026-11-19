/**
 * A record address under `/ld/` answers 404 with a problem body, never the app shell (Q-750, design r4 §5.4 [N9]; standards review row 12).
 *
 * ## The defect it prevents
 *
 * Every address an RDF export writes starts with `<public url>/ld/<space>/`. Without a route of its own such an address fell through to the
 * single-page app and answered `200` with `index.html`: a tool dereferencing a record's name got a web page and took it for the record. The
 * addresses are names for now (RFC 9110: `501` would mean the method is unknown); `404` with an RFC 9457 problem body says so and says where
 * the export is, so a later resolvable address can answer `200` or `303` without breaking a client.
 *
 * Run: node --test testing/standalone/a-linked-data-path-is-not-the-app-shell-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfld';

describe('a linked data path is not the app shell', { skip }, () => {
  let d;
  before(async () => { d = await openRdfExportDoors({ suite: 'rdf_ld_path', spaces: [{ id: SPACE, meta: rdfMeta(SPACE) }] }); });
  after(async () => { await d?.close(); });

  for (const path of [`/ld/${SPACE}/entity/e1`, `/ld/${SPACE}/vocab/entity/Person`, `/ld/${SPACE}/schema`, '/ld/']) {
    it(`${path} is 404 with a problem body naming the export`, async () => {
      for (const accept of ['text/html', 'text/turtle', '*/*']) {
        const r = await fetch(`${d.server.url}${path}`, { headers: { Accept: accept } });
        const text = await r.text();
        assert.equal(r.status, 404, `${accept}: ${text.slice(0, 200)}`);
        assert.match(String(r.headers.get('content-type')), /^application\/problem\+json/);
        assert.doesNotMatch(text, /<html|<!doctype/i, 'never the app shell');
        const body = JSON.parse(text);
        assert.equal(body.status, 404);
        assert.equal(typeof body.title, 'string');
        assert.match(body.detail, /name/i, 'it says the addresses are names for now');
        assert.match(body.detail, /\/api\/brain\/spaces\/[^ ]*\/export\/rdf/, 'it says where the export is');
      }
    });
  }
});

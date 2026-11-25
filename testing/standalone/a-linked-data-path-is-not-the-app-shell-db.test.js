/**
 * No path under `/ld/` answers the app shell: an address answers its statements, a browser is sent to the app, and anything else is a 404
 * problem body (Q-750, design r4 §5.4 [N9]; bundle-271, Q-758, design §3, r2 R1.5).
 *
 * ## The defect it prevents
 *
 * Every address an RDF export writes starts with `<public url>/ld/<space>/`. Without a route of its own such an address fell through to the
 * single-page app and answered `200` with `index.html`: a tool dereferencing a record's name got a web page and took it for the record.
 * Since Q-758 a record address resolves; a path under `/ld/` that is no address (no space, the ontology alone, a kind no record has, a part
 * after the id) answers `404` with an RFC 9457 problem body that says where the export is, for every `Accept`, a browser's included.
 *
 * ## Seen red
 *
 * On c647bd24f the record address answers the placeholder's 404 to a browser (no 303) and to a token-less machine read (no 401).
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

  for (const path of [`/ld/${SPACE}/vocab`, `/ld/${SPACE}/schema`, `/ld/${SPACE}/link/l1`, `/ld/${SPACE}/entity/e1/part`, '/ld/']) {
    it(`${path} is 404 with a problem body naming the export`, async () => {
      for (const accept of ['text/html', 'text/turtle', '*/*']) {
        const r = await fetch(`${d.server.url}${path}`, { headers: { Accept: accept }, redirect: 'manual' });
        const text = await r.text();
        assert.equal(r.status, 404, `${accept}: ${text.slice(0, 200)}`);
        assert.match(String(r.headers.get('content-type')), /^application\/problem\+json/);
        assert.doesNotMatch(text, /<html|<!doctype/i, 'never the app shell');
        const body = JSON.parse(text);
        assert.equal(body.status, 404);
        assert.equal(body.code, 'ld_not_found');
        assert.equal(typeof body.title, 'string');
        assert.match(body.detail, /\/api\/brain\/spaces\/[^ ]*\/export\/rdf/, 'it says where the export is');
      }
    });
  }

  it(`/ld/${SPACE}/entity/e1 sends a browser to the app and asks a machine for a token, never the app shell`, async () => {
    const page = await fetch(`${d.server.url}/ld/${SPACE}/entity/e1`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), `/brain?space=${SPACE}&tab=entities`);
    for (const accept of ['text/turtle', '*/*']) {
      const r = await fetch(`${d.server.url}/ld/${SPACE}/entity/e1`, { headers: { Accept: accept }, redirect: 'manual' });
      const text = await r.text();
      assert.equal(r.status, 401, `${accept}: ${text.slice(0, 200)}`);
      assert.doesNotMatch(text, /<html|<!doctype/i, 'never the app shell');
    }
  });
});

/**
 * The schema-from-RDF door reads its document within its bounds (bundle-270, Q-754, design revision 3, the lens sweep's performance gaps and
 * the challenge's F5 and F8): `POST /api/spaces/:id/schema-rdf` and MCP `import_schema_rdf`.
 *
 * ## What it holds
 *
 * - A body over the door's own byte bound is 413 `rdf_bound_exceeded` naming it (`schemaRdfBodyMaxBytes`), on both doors.
 * - An upload that sends nothing for the idle bound is 400 `rdf_import_upload_stalled`, and the door's slot is free again after it.
 * - While one build reads its upload, a second is 409 `schema_rdf_busy` (one slot per instance).
 * - A gzip body that inflates past the reader's ratio is 413 `rdf_bound_exceeded`.
 * - A file over the quad bound is 413 `rdf_bound_exceeded` naming it (`schemaRdfMaxQuads`), before the mapping runs, on both doors.
 * - The answer names at most the door's entries bound of taken and not-taken statements, and counts them all.
 * - The changes list is capped alike; a refusal names at most the reasons bound, each text at 300 characters, and counts every reason.
 * - A body sent as form data (what curl sends by default) is read as the document.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-reads-within-its-bounds-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, knobs, actModule, MEDIA } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdfboundsrc';
const TARGET = 'srdfboundtarget';
const SOURCE_TYPES = {
  entity: { person: { propertySchemas: { age: { type: 'number' }, name: { type: 'string' } } }, place: { propertySchemas: { city: { type: 'string' } } } },
};

describe('the schema-from-RDF door reads within its bounds (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, file;
  before(async () => {
    d = await openSchemaRdfImportDoors({ suite: 'schema_rdf_bounds', spaces: [spaceWith(SRC, SOURCE_TYPES), spaceWith(TARGET, undefined)] });
    admin = await d.mint('schema-rdf-bounds-admin', {}, { admin: true });
    file = await d.exportTurtle(admin.key, SRC);
  });
  after(async () => { actModule.setSchemaRdfImportKnobsForTest?.(null); await d?.close(); });

  const params = (over = {}) => ({ mode: 'generate', sourceBase: baseOf(SRC), dryRun: true, ...over });
  const query = (p) => `?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)])).toString()}`;

  /** A REST upload that sends `head`, then nothing, holding its end open until `release()`. Resolves the answer when one comes. */
  function stallingUpload(head) {
    let req;
    const answered = new Promise((resolve, reject) => {
      req = http.request(`${d.server.url}/api/spaces/${TARGET}/schema-rdf${query(params({ format: 'turtle' }))}`, {
        method: 'POST', headers: { Authorization: `Bearer ${admin.key}`, 'Content-Type': MEDIA.turtle, 'Transfer-Encoding': 'chunked' },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, body, text, code: body?.code ?? null });
        });
      });
      req.on('error', reject);
      req.write(head);
    });
    return { answered, release: () => { try { req.destroy(); } catch { /* gone */ } } };
  }

  it('a body over the byte bound is 413 rdf_bound_exceeded naming schemaRdfBodyMaxBytes, on both doors', async () => {
    knobs({ bodyMaxBytes: 256 });
    try {
      const { rest, mcp } = await d.both(admin.key, TARGET, file, params());
      assert.equal(rest.status, 413, rest.text.slice(0, 300));
      assert.equal(rest.code, 'rdf_bound_exceeded');
      assert.equal(rest.body.bound, 'schemaRdfBodyMaxBytes', rest.text.slice(0, 300));
      assert.equal(mcp.code, 'rdf_bound_exceeded', mcp.text.slice(0, 300));
    } finally { knobs(null); }
  });

  it('an upload that stalls is 400 rdf_import_upload_stalled, and the slot is free after it', async () => {
    knobs({ uploadIdleMs: 1_000 });
    try {
      const up = stallingUpload(file.slice(0, 40));
      const answer = await up.answered;
      up.release();
      assert.equal(answer.status, 400, answer.text.slice(0, 300));
      assert.equal(answer.code, 'rdf_import_upload_stalled');
    } finally { knobs(null); }
    const after = await d.buildRest(admin.key, TARGET, file, { params: params() });
    assert.equal(after.status, 200, `the slot was not freed: ${after.text.slice(0, 300)}`);
  });

  it('while one build reads its upload, a second is 409 schema_rdf_busy', async () => {
    knobs({ uploadIdleMs: 5_000 });
    const up = stallingUpload(file.slice(0, 40));
    try {
      // The first request holds the slot from its first byte: the second waits until the server has it.
      const second = await waitForValue(async () => {
        const r = await d.buildRest(admin.key, TARGET, file, { params: params() });
        return r.status === 409 ? r : null;
      }, 4_000, 50, undefined, { what: 'the second build to meet the held slot' });
      assert.equal(second.code, 'schema_rdf_busy');
    } finally {
      up.release();
      await up.answered.catch(() => undefined);
      knobs(null);
    }
  });

  it('a gzip body that inflates past the reader\'s ratio is 413 rdf_bound_exceeded', async () => {
    const bomb = Buffer.from('#\n'.repeat(3 * 1024 * 1024), 'utf8');
    const answer = await d.buildRest(admin.key, TARGET, bomb, { params: params({ format: 'turtle' }), gzip: true });
    assert.equal(answer.status, 413, answer.text.slice(0, 300));
    assert.equal(answer.code, 'rdf_bound_exceeded');
  });

  it('a file over the quad bound is 413 naming schemaRdfMaxQuads, before the mapping runs, on both doors', async () => {
    let mapped = 0;
    knobs({ maxQuads: 5, hooks: { beforeMapping: () => { mapped += 1; } } });
    try {
      const { rest, mcp } = await d.both(admin.key, TARGET, file, params());
      assert.equal(rest.status, 413, rest.text.slice(0, 300));
      assert.equal(rest.code, 'rdf_bound_exceeded');
      assert.equal(rest.body.bound, 'schemaRdfMaxQuads');
      assert.equal(mcp.code, 'rdf_bound_exceeded', mcp.text.slice(0, 300));
      assert.equal(mapped, 0, 'the mapping ran on a file over the bound');
    } finally { knobs(null); }
  });

  it('the answer names at most the entries bound and counts every entry, on both doors', async () => {
    knobs({ entriesNamedMax: 2 });
    try {
      const { rest, mcp } = await d.both(admin.key, TARGET, file, params());
      for (const [door, a] of [['rest', rest], ['mcp', mcp]]) {
        assert.ok(a.body, `${door}: ${a.text.slice(0, 300)}`);
        assert.ok(a.body.taken.length <= 2, `${door}: ${a.body.taken.length} taken entries named`);
        assert.ok(a.body.notTaken.length <= 2, `${door}: ${a.body.notTaken.length} not-taken entries named`);
        assert.ok(a.body.counts.taken > 2, `${door}: the count is of every entry (${a.body.counts.taken})`);
        // The changes list is capped the same way and counted whole (P2 of the pre-ship sweep).
        assert.ok(a.body.changes.length <= 2, `${door}: ${a.body.changes.length} changes named`);
        assert.ok(a.body.counts.changes > 2, `${door}: the changes count is of every change (${a.body.counts.changes})`);
      }
    } finally { knobs(null); }
  });

  it('a refusal names at most the reasons bound, each text at 300 characters, and counts every reason, on both doors', async () => {
    // Two addresses that give one name are a name collision whose message carries both addresses: long ones put the sentence past its cap.
    // More pairs than the reasons bound put the list past it.
    const PAIRS = 105;
    const pad = 'x'.repeat(200);
    const lines = ['@prefix owl: <http://www.w3.org/2002/07/owl#> .'];
    for (let i = 0; i < PAIRS; i++) {
      lines.push(`<http://a.example/${pad}/Thing${i}> a owl:Class .`);
      lines.push(`<http://b.example/${pad}/Thing${i}> a owl:Class .`);
    }
    const { rest, mcp } = await d.both(admin.key, TARGET, lines.join('\n'), params({ sourceBase: undefined, dryRun: false }));
    assert.equal(rest.status, 422, rest.text.slice(0, 300));
    assert.equal(rest.code, 'schema_rdf_refused', rest.text.slice(0, 300));
    for (const [door, a] of [['rest', rest], ['mcp', mcp]]) {
      assert.ok(a.body, `${door}: ${a.text.slice(0, 300)}`);
      assert.equal(a.body.reasons.length, 100, `${door}: the reasons named`);
      assert.equal(a.body.reasonCount, PAIRS, `${door}: the count is of every reason`);
      // A sentence over its cap is cut at 300 characters and says how many it left out; every sentence of the fixture is over it.
      for (const r of a.body.reasons) {
        const cut = /^([\s\S]*)…\(\+\d+ chars\)$/.exec(r.message);
        assert.ok(cut, `${door}: a reason text of ${r.message.length} characters was not cut: ${r.message.slice(0, 80)}`);
        assert.equal(cut[1].length, 300, `${door}: a reason text is cut at its cap`);
      }
    }
  });

  it('a body sent as form data is read as the document', async () => {
    const asForm = await d.buildRest(admin.key, TARGET, file, { params: params({ format: 'turtle' }), contentType: 'application/x-www-form-urlencoded' });
    const asTurtle = await d.buildRest(admin.key, TARGET, file, { params: params({ format: 'turtle' }) });
    assert.equal(asForm.status, 200, asForm.text.slice(0, 300));
    assert.deepEqual(asForm.body.counts, asTurtle.body.counts, 'the form body was not read as the document');
    assert.ok(asForm.body.counts.statements > 0);
  });
});

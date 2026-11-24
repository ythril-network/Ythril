/**
 * The schema-from-RDF door's refusal reaches a client that keeps sending at full speed, never reset (bundle-270, Q-953; the Full run
 * 45431865235, attempt 2: a refused sender failed with `write EPIPE` before it read its answer, at the admin import).
 *
 * ## What it holds
 *
 * The same rule as the admin import's (`an-admin-import-reads-out-the-body-it-refused-at-full-speed-db.test.js`) at the schema-from-RDF door,
 * which answers through `sendRdfRefusal`: a refused caller's next upload within the window is `429 rdf_import_upload_cooldown`, answered before a
 * byte of the body is read; a sender that writes its whole body at full speed and reads nothing until the body has ended reads it whole, with
 * `Connection: close`, and is never reset.
 *
 * Run: node --test testing/standalone/a-schema-rdf-import-reads-out-the-body-it-refused-at-full-speed-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, MEDIA } from './_schema-rdf-import-doors.mjs';
import { pacedSender, floodedSender, setPace, resetPace, resetLingerBounds, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdffloodsrc';
const TARGET = 'srdffloodtarget';
const SOURCE_TYPES = { entity: { person: { propertySchemas: { name: { type: 'string' } } } } };
const MIB = 1024 * 1024;

describe('the schema-from-RDF door reads out a body it refused, at full speed (real route, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, admin;
  before(async () => {
    d = await openSchemaRdfImportDoors({ suite: 'schema_rdf_flood', spaces: [spaceWith(SRC, SOURCE_TYPES), spaceWith(TARGET, undefined)] });
    admin = await d.mint('schema-rdf-flood-admin', {}, { admin: true });
  });
  after(async () => { resetPace(); resetLingerBounds(); await d?.close(); });
  afterEach(() => { resetPace(); resetLingerBounds(); });

  const url = () => `${d.server.url}/api/spaces/${TARGET}/schema-rdf?${new URLSearchParams({ mode: 'generate', sourceBase: baseOf(SRC), dryRun: 'true', format: 'turtle' })}`;
  const headers = () => ({ Authorization: `Bearer ${admin.key}`, 'Content-Type': MEDIA.turtle });

  it('a cooled-down caller sending 2 MiB at full speed reads the 429 whole, with Connection: close, and is not reset', async () => {
    setPace({ idleMs: 300, windowMs: 20_000, minBytesPerSecond: 1 });
    const stalled = pacedSender(url(), { headers: headers(), first: '# a schema that stops\n', everyMs: null });
    assert.equal((await answeredWithin(stalled, 15_000, 'the stalled upload to be answered')).status, 408);
    stalled.stop();
    const flood = floodedSender(url(), { headers: headers(), first: '# a schema sent at full speed\n', totalBytes: 2 * MIB });
    const answer = await answeredWithin(flood, 30_000, 'the flooding upload of a cooled-down caller to be answered');
    flood.stop();
    assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
    assert.equal(answer.status, 429, `${answer.status} ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, 'rdf_import_upload_cooldown');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
    assert.equal(answer.wroteAll, true, 'the sender could not write its whole body');
  });
});

/**
 * A schema-from-RDF upload (`POST /api/spaces/:id/schema-rdf`) that trickles under the rate is refused and frees the door's slot, answered so
 * a client still sending reads the code, and the refused caller is cooled down for one window (bundle-270, Q-953; tests 4, 9, 13, 16, and F5).
 *
 * ## What it holds
 *
 * The door reads one schema file at a time per instance. It passed its own idle bound to the reader, so the pace knob never reached it (the
 * challenge's F5), and it had no rate. Now:
 *
 * - an upload under the rate is `408 rdf_import_upload_too_slow` with `Connection: close`, read whole by the sender still sending, and the next
 *   build is taken (tests 4, 9, 16);
 * - the pace knob's idle bound reaches the door: an upload silent for it is `408 rdf_import_upload_stalled` (F5);
 * - the refused caller's next build within one window is `429 rdf_import_upload_cooldown` with `Retry-After`; another caller's is taken (test 13).
 *
 * Run: node --test testing/standalone/a-schema-rdf-upload-that-trickles-is-refused-and-frees-the-slot-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSchemaRdfImportDoors, spaceWith, baseOf, actModule, MEDIA } from './_schema-rdf-import-doors.mjs';
import { pacedSender, setPace, resetPace, retryAfterOf, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SRC = 'srdfpacesrc';
const TARGET = 'srdfpacetarget';
const SOURCE_TYPES = { entity: { person: { propertySchemas: { name: { type: 'string' } } } } };

describe('a schema-from-RDF upload that trickles is refused and frees the slot (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, admin, other, file;
  before(async () => {
    d = await openSchemaRdfImportDoors({ suite: 'schema_rdf_pace', spaces: [spaceWith(SRC, SOURCE_TYPES), spaceWith(TARGET, undefined)] });
    admin = await d.mint('schema-rdf-pace-admin', {}, { admin: true });
    other = await d.mint('schema-rdf-pace-other', {}, { admin: true });
    file = await d.exportTurtle(admin.key, SRC);
  });
  after(async () => { resetPace(); actModule.setSchemaRdfImportKnobsForTest?.(null); await d?.close(); });
  afterEach(() => resetPace());

  const params = { mode: 'generate', sourceBase: baseOf(SRC), dryRun: 'true', format: 'turtle' };
  const url = `?${new URLSearchParams(params).toString()}`;
  /** An upload by `key`: a comment line, then another every `everyMs` (null: nothing more). */
  const upload = (key, everyMs = null) => pacedSender(`${d.server.url}/api/spaces/${TARGET}/schema-rdf${url}`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': MEDIA.turtle }, first: '# a schema sent slowly\n', piece: '#xxxxxx\n', everyMs,
  });

  it('a trickle is 408 rdf_import_upload_too_slow with Connection: close, read whole; the next build is taken (tests 4, 9, 16)', async () => {
    setPace({ idleMs: 10_000, windowMs: 1_000, minBytesPerSecond: 4_096 });
    const up = upload(admin.key, 40);
    const answer = await answeredWithin(up, 15_000, 'the trickling upload to be answered (the window is 1 000 ms here)');
    up.stop();
    assert.equal(answer.reset, false, `the trickling sender never read the answer: ${answer.error}`);
    assert.equal(answer.status, 408, `a trickling upload answered ${answer.status}: ${answer.text.slice(0, 300)}`);
    assert.equal(answer.json?.code, 'rdf_import_upload_too_slow');
    assert.ok(actModule.SCHEMA_RDF_IMPORT_REFUSAL_CODES.includes(answer.json.code), 'the slow code is not in the door\'s refusal list');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
    const next = await d.buildRest(other.key, TARGET, file, { params: { mode: 'generate', sourceBase: baseOf(SRC), dryRun: true } });
    assert.equal(next.status, 200, `the slot was not freed: ${next.text.slice(0, 300)}`);
  });

  it('the pace knob\'s idle bound reaches the door: a silent upload is 408 rdf_import_upload_stalled (F5)', async () => {
    setPace({ idleMs: 500, windowMs: 10_000, minBytesPerSecond: 1 });
    const up = upload(admin.key);
    const answer = await answeredWithin(up, 15_000, 'the stalled upload to be answered (the knob\'s idle bound is 500 ms here)');
    up.stop();
    assert.equal(answer.status, 408, `a stalled upload answered ${answer.status}: ${answer.text.slice(0, 300)}`);
    assert.equal(answer.json?.code, 'rdf_import_upload_stalled');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
  });

  it('the refused caller is 429 rdf_import_upload_cooldown with Retry-After for one window; another caller is taken (test 13)', async () => {
    setPace({ idleMs: 500, windowMs: 20_000, minBytesPerSecond: 1 });
    const up = upload(admin.key);
    assert.equal((await answeredWithin(up, 15_000, 'the stalled upload to be answered')).status, 408);
    up.stop();
    const again = upload(admin.key);
    const cooled = await answeredWithin(again, 15_000, 'the refused caller\'s next build to be answered');
    again.stop();
    assert.equal(cooled.status, 429, `the refused caller's next build within the window: ${cooled.status} ${cooled.text.slice(0, 300)}`);
    assert.equal(cooled.json?.code, 'rdf_import_upload_cooldown');
    const seconds = retryAfterOf(cooled);
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 20, `Retry-After: ${cooled.headers['retry-after']}`);
    const another = await d.buildRest(other.key, TARGET, file, { params: { mode: 'generate', sourceBase: baseOf(SRC), dryRun: true } });
    assert.equal(another.status, 200, `another caller was cooled down too: ${another.text.slice(0, 300)}`);
  });
});

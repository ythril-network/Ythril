/**
 * An RDF import upload that trickles under the rate is refused and frees the import door, answered so a client still sending reads the code,
 * and the refused caller is cooled down for one window (bundle-270, Q-953; tests 3, 9, 10, 13, 16).
 *
 * ## What it holds
 *
 * The door reads one file at a time, instance-wide, and its upload had an idle bound but no rate: a sender of a byte now and then never met the
 * idle bound and held the door for every other import (each answered `409 rdf_import_busy`) until Node's request timeout. Now:
 *
 * - an upload under the rate over a window of the reader's waiting is `408 rdf_import_upload_too_slow`, a code of the import's list, with
 *   `Connection: close`, read whole by the sender still sending (tests 3, 9, 16); a second import meanwhile was busy, and one right after,
 *   by another caller, lands;
 * - the refused upload leaves no folder under the import's data (test 10);
 * - the refused caller's next import within one window is `429 rdf_import_upload_cooldown` with `Retry-After`; another caller's is taken
 *   (test 13).
 *
 * The stalled upload's own case (`408 rdf_import_upload_stalled`) is `an-rdf-import-upload-that-stalls-is-refused-and-frees-the-door-db.test.js`.
 * The MCP tool takes its document inline, one chunk, and has no upload to pace.
 *
 * Run: node --test testing/standalone/an-rdf-import-upload-that-trickles-is-refused-and-frees-the-door-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';
import { pacedSender, setPace, resetPace, retryAfterOf, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfimptrickle';

describe('an RDF import upload that trickles is refused and frees the door (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, writer, other, act;

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_trickle', spaces: [{ id: SPACE, meta: personMeta(SPACE, 'warn') }] });
    writer = await d.mint('rdf-import-trickle-writer', { [SPACE]: d.row({ knowledge: 'write', schema: 'admin' }) });
    other = await d.mint('rdf-import-trickle-other', { [SPACE]: d.row({ knowledge: 'write', schema: 'admin' }) });
    act = await import('../../server/dist/spaces/rdf-import-act.js');
  });
  after(async () => { resetPace(); act?.setRdfImportKnobsForTest?.(null); await d?.close(); });
  afterEach(() => { resetPace(); act.setRdfImportKnobsForTest(null); });

  /** The folders an import keeps under the data root while it reads or runs. */
  const importFolders = () => {
    try { return fs.readdirSync(path.join(process.env['DATA_ROOT'], 'rdf-import')); } catch (err) { if (err?.code === 'ENOENT') return []; throw err; }
  };

  /** An upload by `key`: a comment line, then another every `everyMs` (null: nothing more). */
  const upload = (key, everyMs = null) => pacedSender(`${d.server.url}/api/brain/spaces/${SPACE}/import/rdf`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/turtle' }, first: '# a file sent slowly\n', piece: '#xxxxxx\n', everyMs,
  });

  it('a trickle is 408 rdf_import_upload_too_slow with Connection: close, read whole; the door was busy and is free after (tests 3, 9, 10, 16)', async () => {
    let held = false;
    act.setRdfImportKnobsForTest({ hooks: { afterDoorTaken: () => { held = true; } } });
    setPace({ idleMs: 10_000, windowMs: 1_500, minBytesPerSecond: 4_096 });
    const up = upload(writer.key, 40);
    try {
      await waitFor(() => held, 10_000, 10, undefined, { what: 'the trickling upload to take the import door' });
      const busy = await d.importRest(other.key, SPACE, goodTurtle(SPACE), { params: { dryRun: true } });
      assert.equal(busy.status, 409, `a second import while the upload trickles: ${busy.status} ${busy.text.slice(0, 200)}`);
      assert.equal(busy.body.code, 'rdf_import_busy');
      const answer = await answeredWithin(up, 15_000, 'the trickling upload to be answered (the window is 1 500 ms here)');
      assert.equal(answer.reset, false, `the trickling sender never read the answer: ${answer.error}`);
      assert.equal(answer.status, 408, `a trickling upload answered ${answer.status}: ${answer.text.slice(0, 300)}`);
      assert.equal(answer.json?.code, 'rdf_import_upload_too_slow');
      assert.ok(act.RDF_IMPORT_REFUSAL_CODES.includes(answer.json.code), 'the slow code is not in the import\'s refusal list');
      assert.match(String(answer.headers.connection ?? ''), /close/i, 'the trickling sender keeps its connection');
    } finally { up.stop(); }
    await waitFor(() => importFolders().length === 0, 10_000, 25, undefined, { what: 'the refused upload\'s folder to be removed' });
    assert.deepEqual(await d.records(SPACE, 'entities'), [], 'the refused upload wrote something');
    const next = await d.importRest(other.key, SPACE, goodTurtle(SPACE));
    assert.equal(next.status, 200, `the door is still held after the trickle was refused: ${next.status} ${next.text.slice(0, 200)}`);
  });

  it('the refused caller is 429 rdf_import_upload_cooldown with Retry-After for one window; another caller is taken (test 13)', async () => {
    setPace({ idleMs: 500, windowMs: 20_000, minBytesPerSecond: 1 });
    const up = upload(writer.key);
    const refused = await answeredWithin(up, 15_000, 'the stalled upload to be answered');
    up.stop();
    assert.equal(refused.status, 408, refused.text.slice(0, 300));
    const again = upload(writer.key);
    const cooled = await answeredWithin(again, 15_000, 'the refused caller\'s next import to be answered');
    again.stop();
    assert.equal(cooled.status, 429, `the refused caller's next import within the window: ${cooled.status} ${cooled.text.slice(0, 300)}`);
    assert.equal(cooled.json?.code, 'rdf_import_upload_cooldown');
    assert.ok(act.RDF_IMPORT_REFUSAL_CODES.includes(cooled.json.code), 'the cooldown code is not in the import\'s refusal list');
    const seconds = retryAfterOf(cooled);
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 20, `Retry-After: ${cooled.headers['retry-after']}`);
    const another = await d.importRest(other.key, SPACE, goodTurtle(SPACE), { params: { dryRun: true } });
    assert.equal(another.status, 200, `another caller was cooled down too: ${another.status} ${another.text.slice(0, 200)}`);
  });
});

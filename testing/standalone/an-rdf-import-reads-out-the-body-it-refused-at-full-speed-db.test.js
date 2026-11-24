/**
 * The RDF import's refusal reaches a client that keeps sending at full speed, never reset (bundle-270, Q-953; the Full run 45431865235,
 * attempt 2: a refused sender failed with `write EPIPE` before it read its answer, at the admin import).
 *
 * ## What it holds
 *
 * The same rule as the admin import's (`an-admin-import-reads-out-the-body-it-refused-at-full-speed-db.test.js`) at the RDF import door, which
 * answers through `sendRdfRefusal`: a refused sender that writes its whole body at full speed and reads nothing until the body has ended reads the
 * refusal whole, with `Connection: close`, and is never reset:
 *
 * - a refused caller's next upload within the window is `429 rdf_import_upload_cooldown`, answered before a byte of the body is read;
 * - a body over the import's byte bound is `413`, answered while the rest of the body is still arriving.
 *
 * Run: node --test testing/standalone/an-rdf-import-reads-out-the-body-it-refused-at-full-speed-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfImportDoors, personMeta } from './_rdf-import-doors.mjs';
import { pacedSender, floodedSender, setPace, resetPace, resetLingerBounds, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfimpflood';
const MIB = 1024 * 1024;

describe('the RDF import reads out a body it refused, at full speed (real route, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, writer;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_flood', spaces: [{ id: SPACE, meta: personMeta(SPACE, 'warn') }] });
    writer = await d.mint('rdf-import-flood-writer', { [SPACE]: d.row({ knowledge: 'write', schema: 'admin' }) });
  });
  after(async () => { resetPace(); resetLingerBounds(); await d?.close(); });
  afterEach(() => { resetPace(); resetLingerBounds(); });

  const url = () => `${d.server.url}/api/brain/spaces/${SPACE}/import/rdf`;
  const headers = () => ({ Authorization: `Bearer ${writer.key}`, 'Content-Type': 'text/turtle' });

  it('a cooled-down caller sending 2 MiB at full speed reads the 429 whole, with Connection: close, and is not reset', async () => {
    setPace({ idleMs: 300, windowMs: 20_000, minBytesPerSecond: 1 });
    const stalled = pacedSender(url(), { headers: headers(), first: '# a file that stops\n', everyMs: null });
    assert.equal((await answeredWithin(stalled, 15_000, 'the stalled upload to be answered')).status, 408);
    stalled.stop();
    const flood = floodedSender(url(), { headers: headers(), first: '# a file sent at full speed\n', totalBytes: 2 * MIB });
    const answer = await answeredWithin(flood, 30_000, 'the flooding upload of a cooled-down caller to be answered');
    flood.stop();
    assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
    assert.equal(answer.status, 429, `${answer.status} ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, 'rdf_import_upload_cooldown');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
    assert.equal(answer.wroteAll, true, 'the sender could not write its whole body');
  });

  it('a body over the import\'s byte bound sent at full speed reads the 413 whole, with Connection: close, and is not reset', async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    const cfg = d.loader.getConfig();
    const before = cfg.importBodyMaxBytes;
    cfg.importBodyMaxBytes = 64 * 1024;
    try {
      const flood = floodedSender(url(), { headers: headers(), first: '# a file over the bound\n', totalBytes: 2 * MIB });
      const answer = await answeredWithin(flood, 30_000, 'the flooding upload over the bound to be answered');
      flood.stop();
      assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
      assert.equal(answer.status, 413, `${answer.status} ${answer.text.slice(0, 200)}`);
      assert.match(String(answer.headers.connection ?? ''), /close/i);
      assert.equal(answer.wroteAll, true, 'the sender could not write its whole body');
    } finally {
      if (before === undefined) delete cfg.importBodyMaxBytes; else cfg.importBodyMaxBytes = before;
    }
  });
});

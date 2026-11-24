/**
 * An upload that sends its first bytes and then nothing is refused after the import's idle bound, and the import door is free again
 * (bundle-270, lens finding L7).
 *
 * ## What it holds
 *
 * The door reads one file at a time, instance-wide (`doorHeld`), from before the first byte until its act is registered or it answered, and the body
 * was counted but never timed: a slow authenticated upload held it for every other caller (each answered 409 `rdf_import_busy`) until Node's own
 * request timeout, five minutes. The body now has an idle bound (`uploadPace().idleMs`, lowered here through the act's `uploadIdleMs` knob, never
 * waited for at its default): a body that gives nothing for that long is refused `rdf_import_upload_stalled`, a code of the import's list, and the connection
 * is closed after the answer so the stalled sender does not keep the socket. The status is 408 (Q-953: the owner chose the standard's answer to a
 * body that does not arrive in time, RFC 9110 section 15.5.9; it was 400).
 *
 * - while the upload stalls, a second import is refused as busy (the premise: the door is held);
 * - the stalled upload is answered with the stalled code, listed, with `Connection: close`, and nothing was written;
 * - a second import started right after is taken and lands.
 *
 * The MCP tool takes its document inline (`import_rdf { document }`, one chunk) and has no upload to stall, so it has no idle bound to answer
 * alike: both doors answer the same refusal through the act, and the tool's side of it is that nothing can reach it.
 *
 * Run: node --test testing/standalone/an-rdf-import-upload-that-stalls-is-refused-and-frees-the-door-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle } from './_rdf-import-doors.mjs';
import { resetPace } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'rdfimpstall';
const IDLE_MS = 2000;

describe('an upload that stalls is refused and frees the import door (real routes, real MongoDB)', { skip, timeout: 120_000 }, () => {
  let d, writer, act;

  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_stall', spaces: [{ id: SPACE, meta: personMeta(SPACE, 'warn') }] });
    writer = await d.mint('rdf-import-stall-writer', { [SPACE]: d.row({ knowledge: 'write', schema: 'admin' }) });
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    act.setRdfImportKnobsForTest({ uploadIdleMs: IDLE_MS });
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); await d?.close(); });

  /** An upload that writes `first` and then neither writes nor ends; resolves with the answer once the server gives one. */
  function stalledUpload(first) {
    const url = new URL(`${d.server.url}/api/brain/spaces/${SPACE}/import/rdf`);
    let request;
    const answer = new Promise((resolve, reject) => {
      request = http.request(url, { method: 'POST', headers: { Authorization: `Bearer ${writer.key}`, 'Content-Type': 'text/turtle' } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      request.on('error', reject);
      request.write(first);
    });
    return { answer, abort: () => request.destroy() };
  }

  it('refuses the stalled upload by a listed code, frees the door, and takes the next import', async () => {
    // The second import is started only once the stalled upload has the door (a seam in the door): started earlier it could take the door first.
    let held = false;
    act.setRdfImportKnobsForTest({ uploadIdleMs: IDLE_MS, hooks: { afterDoorTaken: () => { held = true; } } });
    const stalled = stalledUpload('<http://people.example/alice> a ');
    try {
      await waitFor(() => held, 10_000, 10, undefined, { what: 'the stalled upload to take the import door' });
      const busy = await d.importRest(writer.key, SPACE, goodTurtle(SPACE), { params: { dryRun: true } });
      assert.equal(busy.status, 409, `a second import while the upload stalls: ${busy.status} ${busy.text.slice(0, 200)}`);
      assert.equal(busy.body.code, 'rdf_import_busy');
      let answered;
      void stalled.answer.then(a => { answered = a; }, () => undefined);
      await waitFor(() => answered !== undefined, 10_000, 25, undefined, { what: `the stalled upload to be answered (the idle bound is ${IDLE_MS} ms here)` });
      assert.equal(answered.status, 408, answered.text.slice(0, 300));
      const body = JSON.parse(answered.text);
      assert.equal(body.code, 'rdf_import_upload_stalled');
      assert.ok(act.RDF_IMPORT_REFUSAL_CODES.includes(body.code), 'the stalled code is not in the import\'s refusal list');
      assert.match(String(answered.headers.connection ?? ''), /close/i, 'the stalled sender keeps its connection');
    } finally {
      stalled.abort();
      act.setRdfImportKnobsForTest({ uploadIdleMs: IDLE_MS });
      // The refused caller is cooled down for a window (Q-953, its own case in the trickle file); this case is about the door being free.
      resetPace();
    }
    assert.deepEqual(await d.records(SPACE, 'entities'), [], 'the stalled upload wrote something');
    const next = await d.importRest(writer.key, SPACE, goodTurtle(SPACE));
    assert.equal(next.status, 200, `the door is still held after the stalled upload was refused: ${next.status} ${next.text.slice(0, 200)}`);
    assert.deepEqual((await d.records(SPACE, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob']);
  });

  // Found beside it: the body bound's refusal went through the reader's source catch like any source failure and was worded as one.
  it('a body over the import body bound is still answered 413 naming the bound, not as a failed upload', async () => {
    const cfg = d.loader.getConfig();
    const before = cfg.importBodyMaxBytes;
    cfg.importBodyMaxBytes = 64;
    try {
      const r = await d.importRest(writer.key, SPACE, goodTurtle(SPACE));
      assert.equal(r.status, 413, r.text.slice(0, 300));
      assert.equal(r.body.bound, 'importBodyMaxBytes');
    } finally {
      if (before === undefined) delete cfg.importBodyMaxBytes; else cfg.importBodyMaxBytes = before;
    }
  });
});

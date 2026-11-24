/**
 * The admin import's refusal reaches a client that keeps sending at full speed, never reset, and the lingering close that guarantees it is bounded
 * (bundle-270, Q-953; the Full run 45431865235, attempt 2: "a body over the inflated ceiling ... write EPIPE").
 *
 * ## What it holds
 *
 * An answer that says `Connection: close` ended the connection as soon as it was flushed (Node's `destroySoon`). A client still sending had its
 * unread bytes met by a reset: its next write failed (`EPIPE`) or the answer it had been sent was lost. The door now half-closes after the answer
 * and reads and discards what the client still sends (`closeUnreadBody`, one lingering close for every door), then closes:
 *
 * - a sender that writes its whole body at full speed and reads nothing until the body has ended reads `429` (a refused caller's next upload,
 *   answered before a byte is read) and `413` (a body over the inflated ceiling), whole, with `Connection: close`, and is never reset;
 * - the drain reads no more than a named byte bound and holds the socket no longer than a named time bound: a sender that keeps sending past the
 *   bytes is cut, and one that never ends its body or closes is cut at the time. The bounds are set through the knob, a few hundred kilobytes
 *   and a second, and reset after every case.
 *
 * The first two cases hold the sender's read until its body has ended, so the server has closed (or lingers) long before the sender looks: the
 * race of a sender that writes while the server closes is certain, not likely.
 *
 * Run: node --test testing/standalone/an-admin-import-reads-out-the-body-it-refused-at-full-speed-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor } from './_import-door.mjs';
import { pacedSender, floodedSender, setPace, resetPace, setLingerBounds, resetLingerBounds, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'importflood';
const T = { timeout: 60_000 };
const MIB = 1024 * 1024;

let door;

describe('the admin import reads out a body it refused, at full speed and within bounds (real route, real MongoDB)', { skip }, () => {
  before(async () => { door = await openImportDoor({ suite: 'importflood', spaces: [{ id: SPACE, label: 'Flood', folders: [] }] }); });
  after(async () => { resetPace(); resetLingerBounds(); await door?.close(); });
  afterEach(() => { resetPace(); resetLingerBounds(); });

  const url = () => `${door.base}/api/admin/spaces/${SPACE}/import`;
  const headersOf = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${door.adminKey}` });

  it('a cooled-down caller sending 2 MiB at full speed reads the 429 whole, with Connection: close, and is not reset', T, async () => {
    setPace({ idleMs: 300, windowMs: 20_000, minBytesPerSecond: 1 });
    const stalled = pacedSender(url(), { headers: headersOf(), first: '{"facts":[', everyMs: null });
    assert.equal((await answeredWithin(stalled, 15_000, 'the stalled upload to be answered')).status, 408);
    stalled.stop();
    const flood = floodedSender(url(), { headers: headersOf(), first: '{"facts":[', totalBytes: 2 * MIB });
    const answer = await answeredWithin(flood, 30_000, 'the flooding upload of a cooled-down caller to be answered');
    flood.stop();
    assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
    assert.equal(answer.status, 429, `${answer.status} ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, 'space_import_upload_cooldown');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
    assert.equal(answer.wroteAll, true, 'the sender could not write its whole body');
  });

  it('a body over the inflated ceiling sent at full speed reads the 413 whole, with Connection: close, and is not reset', T, async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    try {
      const flood = floodedSender(url(), { headers: headersOf(), first: '{"facts":[', totalBytes: 2 * MIB });
      const answer = await answeredWithin(flood, 30_000, 'the flooding upload over the ceiling to be answered');
      flood.stop();
      assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
      assert.equal(answer.status, 413, `${answer.status} ${answer.text.slice(0, 200)}`);
      assert.match(String(answer.headers.connection ?? ''), /close/i);
      assert.equal(answer.wroteAll, true, 'the sender could not write its whole body');
    } finally { door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; }); }
  });

  it('a sender that keeps sending past the byte bound of the drain is cut before its body ends', T, async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    setLingerBounds({ maxBytes: 256 * 1024, maxMs: 30_000 });
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    try {
      const flood = floodedSender(url(), { headers: headersOf(), first: '{"facts":[', totalBytes: 8 * MIB, everyMs: 4 });
      const answer = await answeredWithin(flood, 30_000, 'the flooding upload past the drain\'s byte bound to end');
      flood.stop();
      assert.equal(answer.wroteAll, false, `the drain read all ${answer.sentBytes} bytes of a body past its bound of 256 KiB`);
    } finally { door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; }); }
  });

  it('a refused sender that never ends its body or closes is cut at the time bound of the drain', T, async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    setLingerBounds({ maxBytes: 64 * MIB, maxMs: 1_000 });
    const open = floodedSender(url(), { headers: { ...headersOf(), 'Content-Type': 'text/plain' }, first: 'not json', stayOpen: true });
    try {
      const answer = await answeredWithin(open, 15_000, 'the upload of another content type to be answered');
      assert.equal(answer.status, 415, `${answer.status} ${answer.text.slice(0, 200)}`);
      const heldMs = await answeredWithin({ answer: open.closed, stop: open.stop }, 15_000, 'the server to close the connection of a sender that never does');
      assert.ok(heldMs >= 800, `the server closed the connection after ${heldMs} ms, before it had drained for its time bound of 1 000 ms`);
    } finally { open.stop(); }
  });
});

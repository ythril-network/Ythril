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
 *   bytes is cut, after it read the refusal, and one that never ends its body or closes is cut at the time, not at the production bound. The
 *   bounds are set through the knob, a few hundred kilobytes and a second, and reset after every case;
 * - while the socket lingers no further request on it is parsed or run (Q-953, review F1): Node's parser stays attached to a socket whose data
 *   listener the drain adds, and a request the sender pipelined behind its refused upload ran, with its side effects, its answer lost on the
 *   ended socket. The case sends the end of its body and a next request straight after the refusal and counts what reaches the
 *   server's request event.
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
import { pacedSender, floodedSender, setPace, resetPace, setLingerBounds, resetLingerBounds, answeredWithin, lingerModule } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'importflood';
const T = { timeout: 60_000 };
const MIB = 1024 * 1024;
/** The bounds the drain cases narrow the lingering close to: the bytes it reads after the answer and the time it holds the socket. */
const DRAIN_BYTES = 256 * 1024;
const DRAIN_MS = 1_000;
/** How late the server answers a refusal in the late case: longer than a sender writing on the clock takes to write 8 MiB (about 512 ms). */
const LATE_ANSWER_MS = 700;
/** The window the pipelining case keeps the drain open for: far longer than the case, so only the sender's end closes the socket. */
const OPEN_WINDOW_MS = 20_000;

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

  /**
   * A sender that keeps sending past the drain's byte bound, its refusal answered `answerDelayMs` after it was decided. The sender follows the server
   * (`followServer`): the pieces it has sent are what the server has read and the kernel holds, so a server that answers late, as on a loaded
   * runner, still has a sender to cut. A sender that wrote its body on the clock had it all in flight before a late server began to read
   * (the Full run 45638678554: "the drain read all 8388608 bytes"), and no cut could be seen.
   */
  const keepsSendingPastTheBound = (answerDelayMs) => async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    setLingerBounds({ maxBytes: DRAIN_BYTES, maxMs: 30_000 });
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    const holdAnswer = (req, res) => {
      const end = res.end.bind(res);
      // waits-differently: a simulated slow server, the answer is held back for a fixed time
      res.end = (...args) => { setTimeout(() => end(...args), answerDelayMs); return res; };
    };
    if (answerDelayMs > 0) door.server.httpServer.prependListener('request', holdAnswer);
    try {
      const flood = floodedSender(url(), { headers: headersOf(), first: '{"facts":[', totalBytes: 64 * MIB, everyMs: 4, readWhileSending: true, followServer: true });
      const answer = await answeredWithin(flood, 30_000, 'the flooding upload past the drain\'s byte bound to end');
      flood.stop();
      assert.equal(answer.wroteAll, false, `the drain read all ${answer.sentBytes} bytes of a body past its bound of ${DRAIN_BYTES}`);
      // A server that closes at once cuts the sender too, and before the bound; and the answer it was sent must have been read first.
      assert.equal(answer.status, 413, `the refusal was not read before the cut: ${answer.status} (${answer.error})`);
      assert.ok(answer.sentBytes > DRAIN_BYTES, `the sender was cut after ${answer.sentBytes} bytes, before the drain's byte bound of ${DRAIN_BYTES}`);
    } finally {
      door.server.httpServer.off('request', holdAnswer);
      door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; });
    }
  };

  it('a sender that keeps sending past the byte bound of the drain is cut before its body ends', T, keepsSendingPastTheBound(0));

  it('a sender that keeps sending past the byte bound is cut before its body ends when the server answers its refusal late', T, keepsSendingPastTheBound(LATE_ANSWER_MS));

  it('a refused sender that never ends its body or closes is cut at the time bound of the drain', T, async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    setLingerBounds({ maxBytes: 64 * MIB, maxMs: DRAIN_MS });
    const open = floodedSender(url(), { headers: { ...headersOf(), 'Content-Type': 'text/plain' }, first: 'not json', stayOpen: true });
    try {
      const answer = await answeredWithin(open, 15_000, 'the upload of another content type to be answered');
      assert.equal(answer.status, 415, `${answer.status} ${answer.text.slice(0, 200)}`);
      const heldMs = await answeredWithin({ answer: open.closed, stop: open.stop }, 15_000, 'the server to close the connection of a sender that never does');
      assert.ok(heldMs >= 0.8 * DRAIN_MS, `the server closed the connection after ${heldMs} ms, before it had drained for its time bound of ${DRAIN_MS} ms`);
      // A bound that has no effect holds the sender for the production bound: the narrowed one must have cut it well before that.
      assert.ok(heldMs < lingerModule.LINGER_MAX_MS, `the server held the connection for ${heldMs} ms: the narrowed time bound of ${DRAIN_MS} ms had no effect (production's is ${lingerModule.LINGER_MAX_MS} ms)`);
    } finally { open.stop(); }
  });

  it('a refused sender that ends its body and pipelines a next request while the socket lingers has no further request parsed or run', T, async () => {
    setPace({ idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 });
    setLingerBounds({ maxBytes: 64 * MIB, maxMs: OPEN_WINDOW_MS });
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    const NEXT_PATH = '/api/the-request-pipelined-behind-a-refused-upload';
    const reached = [];
    const watch = (req) => { reached.push(`${req.method} ${req.url}`); };
    // The server's own `request` event, read where the parser hands a parsed request over: the moment a request is run.
    door.server.httpServer.prependListener('request', watch);
    try {
      const next = `GET ${NEXT_PATH} HTTP/1.1\r\nHost: ${new URL(door.base).host}\r\nAuthorization: Bearer ${door.adminKey}\r\n\r\n`;
      const flood = floodedSender(url(), { headers: headersOf(), first: '{"facts":[', totalBytes: 8 * MIB, pipelined: next });
      const answer = await answeredWithin(flood, 15_000, 'the refusal of the upload with a request pipelined behind it to be read');
      // The connection is closed by the sender's end (its FIN follows its bytes), so every byte it sent has been through the server by then.
      const closedMs = await answeredWithin({ answer: flood.closed, stop: flood.stop }, 15_000, 'the server to end the connection of a refused sender that has ended its body');
      flood.stop();
      assert.equal(answer.pipelinedAfterAnswer, true, 'the sender did not write its next request after it had read the refusal');
      assert.deepEqual(reached.filter(r => r.includes(NEXT_PATH)), [], 'the lingering socket parsed and ran the request the sender pipelined behind its refused upload');
      assert.equal(answer.reset, false, `the sender was reset before it read the answer (after ${answer.sentBytes} bytes): ${answer.error}`);
      assert.equal(answer.status, 413, `${answer.status} ${answer.text.slice(0, 200)}`);
      assert.match(String(answer.headers.connection ?? ''), /close/i);
      assert.ok(closedMs < OPEN_WINDOW_MS, `the connection was held for ${closedMs} ms, the whole drain window of ${OPEN_WINDOW_MS} ms`);
    } finally {
      door.server.httpServer.off('request', watch);
      door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; });
    }
  });
});

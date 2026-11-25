/**
 * The senders that test an import door's upload pace, and the pace knob every such test sets and resets (bundle-270, Q-953).
 *
 * ## Why a module
 *
 * Three doors read an upload through one reader (`server/src/util/upload-reader.ts`): the RDF import, the schema-from-RDF door and the admin
 * import. Each door's test needs the same two senders (one that sends a little and then nothing, one that keeps sending too little), the same
 * reading of an answer that comes while the sender is still sending, and the same reset of the pace knob and of the doors' cooldowns after a
 * case. A case that forgot the reset left its short window, or a caller still cooled down, to the next case; the reset is here so no file can.
 *
 * ## What a sender answers
 *
 * `{ status, headers, text, json, reset }`: what the server answered, read to its end. `reset` is true when the connection failed before the
 * answer was read whole (a door that destroys the request it refused resets the sender, who then never reads the code). A write after the
 * answer that fails because the server closed its side is not a reset: the answer was read.
 *
 * Pace is set through the knob with short windows, never waited for at production figures.
 */
import http from 'node:http';
import net from 'node:net';
import { raceDeadline } from '../_shared/sleep.mjs';

/** The reader module, or `{}` where it does not exist (a missing module fails the case on its rule, not the file at import). */
export const readerModule = await import('../../server/dist/util/upload-reader.js').catch(() => ({}));
/** The doors' cooldown module, or `{}`. */
export const cooldownModule = await import('../../server/dist/util/upload-cooldown.js').catch(() => ({}));

/** Set the upload pace (`{ idleMs, windowMs, minBytesPerSecond }`), or fail naming the missing knob. */
export function setPace(pace) {
  if (typeof readerModule.setUploadPaceForTest !== 'function') throw new Error('setUploadPaceForTest is not exported by server/src/util/upload-reader.ts');
  readerModule.setUploadPaceForTest(pace);
}

/** Restore the production pace and forget every door's cooldowns: called after every case that set a pace or met a refusal. */
export function resetPace() {
  readerModule.setUploadPaceForTest?.(null);
  cooldownModule.forgetUploadCooldownsForTest?.();
}

/**
 * POST to `url` with `headers`, chunked: `first`, then `piece` every `everyMs` until the server answers (`everyMs` null: nothing after `first`,
 * a stalled sender). Resolves with the answer once it is read to its end; `stop()` ends the sender's side.
 */
export function pacedSender(url, { headers = {}, first, piece = '', everyMs = null }) {
  let request;
  let ticker = null;
  const stopTicker = () => { if (ticker !== null) { clearInterval(ticker); ticker = null; } };
  const answer = new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; stopTicker(); resolve(value); } };
    request = http.request(url, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        done({ status: res.statusCode, headers: res.headers, text, json, reset: false });
      });
      res.on('error', (err) => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), json: null, reset: true, error: String(err?.message ?? err) }));
    });
    request.on('error', (err) => done({ status: 0, headers: {}, text: '', json: null, reset: true, error: String(err?.message ?? err) }));
    request.write(first);
    if (everyMs !== null) {
      ticker = setInterval(() => { if (!request.destroyed && !request.writableEnded) request.write(piece); else stopTicker(); }, everyMs);
    }
  });
  return { answer, stop: () => { stopTicker(); try { request.destroy(); } catch { /* gone */ } } };
}

/**
 * The sender's answer, or a failure naming `what` when none came within `ms`: a door without the bound under test never answers a stalled
 * sender, and the case fails on that rule, not on the file's timeout.
 */
export function answeredWithin(sender, ms, what) {
  return raceDeadline(sender.answer, ms, 'race timeout: a door without the bound under test never answers the sender', () => {
    sender.stop();
    throw new Error(`no answer within ${ms} ms: ${what}`);
  });
}

/** The lingering-close module of the doors, or `{}` where it does not exist. */
export const lingerModule = await import('../../server/dist/util/lingering-close.js').catch(() => ({}));

/** Narrow the bounds of the doors' lingering close (`{ maxBytes, maxMs }`), or fail naming the missing knob. */
export function setLingerBounds(bounds) {
  if (typeof lingerModule.setLingerBoundsForTest !== 'function') throw new Error('setLingerBoundsForTest is not exported by server/src/util/lingering-close.ts');
  lingerModule.setLingerBoundsForTest(bounds);
}

/** Restore the production bounds of the lingering close: called after every case that narrowed them. */
export function resetLingerBounds() { lingerModule.setLingerBoundsForTest?.(null); }

/**
 * POST to `url` with `headers` as a sender that never waits for the server: a chunked body of `totalBytes`, a `chunkBytes` piece every
 * `everyMs` at full speed, written while the server's answer is still unread (the sender reads nothing until its body has ended), so a door that
 * ends the connection while the body is unread resets this sender. `answer` resolves when the server ended its side: `{ status, headers, text,
 * json, reset, error, sentBytes, wroteAll, pipelinedAfterAnswer }`; `reset` is true when the socket failed (a write that met a closed server, a
 * reset) or the answer was not read whole. `stayOpen` is a sender that never ends its body or closes: it sends a byte a tick and reads the answer
 * at once, and `closed` resolves with the milliseconds from the first byte to the server closing the connection.
 *
 * - `readWhileSending`: the sender reads as it writes, so the answer that came before a cut is read too: a socket that failed after the
 *   refusal's head was read answers `status` of that head (with `reset` true), never 0.
 * - `followServer`: the sender writes a piece only when the socket has taken the last one (backpressure), so a server that began to read late, on
 *   a loaded runner, still meets a sender that has sent no more than the server read and its kernel buffers hold. Without it the pieces go out on
 *   the clock, and a server slower than `totalBytes / chunkBytes * everyMs` finds the whole body already written: no cut can be seen (Full run
 *   45638678554). `totalBytes` is then the most it sends, far above the kernel buffers.
 * - `pipelined`: the raw text of a next request. The sender reads as it writes, sends pieces until the refusal's head has been read (`totalBytes`
 *   is only the most it sends), then ends its body and writes `pipelined` straight after it, on the same socket, while the server still reads and
 *   drops what the sender sends. `pipelinedAfterAnswer` says it was written after the answer was read: a case that asserts on the next request
 *   must also assert that it was sent.
 */
export function floodedSender(url, { headers = {}, first = '', totalBytes = 0, chunkBytes = 64 * 1024, everyMs = 16, stayOpen = false, readWhileSending = false, pipelined = null, followServer = false }) {
  const target = new URL(url);
  const started = Date.now();
  const socket = net.connect({ host: target.hostname, port: Number(target.port), allowHalfOpen: true });
  const piece = Buffer.alloc(chunkBytes, 0x20);
  const received = [];
  let sentBytes = 0;
  let ticker = null;
  let failure = null;
  let finished = false;
  let pipelinedAfterAnswer = false;
  const stopTicker = () => { if (ticker !== null) { clearInterval(ticker); ticker = null; } };
  const head = [
    `POST ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, 'Transfer-Encoding: chunked',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', '',
  ].join('\r\n');
  const chunk = (data) => Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n')]);
  let collecting = false;
  /** Collect what the server sends from now on: from the first byte for a sender that reads while it writes, else once its body has ended. */
  const collect = () => { if (!collecting) { collecting = true; socket.on('data', c => received.push(c)); } };
  /** The status of the answer read so far, or 0 when no head has been read. */
  const statusRead = () => Number(/^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(received).toString('latin1'))?.[1] ?? 0);
  const headRead = () => Buffer.concat(received).includes('\r\n\r\n');
  let answered;
  const answer = new Promise((resolve) => { answered = resolve; });
  let closedAt;
  const closed = new Promise((resolve) => { closedAt = resolve; });
  let serverEnded = false;
  let bodyEnded = false;
  /** The answer is whole once the server has ended its side and this side's body has ended: a sender that reads while it writes sees the end early. */
  const answerWhole = () => {
    if (!serverEnded || !bodyEnded || finished) return;
    finished = true;
    const raw = Buffer.concat(received);
    const split = raw.indexOf('\r\n\r\n');
    const lines = split < 0 ? [] : raw.subarray(0, split).toString('latin1').split('\r\n');
    const status = Number(/^HTTP\/1\.1 (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0);
    const responseHeaders = Object.fromEntries(lines.slice(1).map(l => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    const text = split < 0 ? '' : raw.subarray(split + 4).toString('utf8');
    const whole = status !== 0 && Buffer.byteLength(text) >= Number(responseHeaders['content-length'] ?? 0);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    answered({ status, headers: responseHeaders, text, json, reset: failure !== null || !whole, error: failure ? String(failure.message ?? failure) : undefined, sentBytes, wroteAll: sentBytes >= totalBytes, pipelinedAfterAnswer });
    if (!stayOpen) socket.end();
  };
  socket.once('end', () => { serverEnded = true; answerWhole(); });
  /** Read what the server answered, now that this side's body has ended. */
  const readAnswer = () => {
    collect();
    bodyEnded = true;
    answerWhole();
  };
  socket.on('error', (err) => {
    failure ??= err;
    stopTicker();
    if (!finished) { finished = true; answered({ status: statusRead(), headers: {}, text: '', json: null, reset: true, error: String(err?.message ?? err), sentBytes, wroteAll: false, pipelinedAfterAnswer }); }
  });
  socket.on('close', () => { stopTicker(); if (!finished) { finished = true; answered({ status: statusRead(), headers: {}, text: '', json: null, reset: true, error: 'closed before an answer', sentBytes, wroteAll: false, pipelinedAfterAnswer }); } closedAt(Date.now() - started); });
  if (readWhileSending || pipelined !== null) collect();
  socket.write(head);
  if (first) socket.write(chunk(Buffer.from(first)));
  // The tick is the sender's pace of writing, never a wait for the server: a body of `totalBytes` ends the sender's side, then it reads.
  ticker = setInterval(() => {
    if (socket.destroyed) { stopTicker(); return; }
    // A sender that stays open sends a byte a tick and never ends: only the server's own bounds close the connection, and its next write meets it.
    if (stayOpen) { socket.write(chunk(Buffer.from(' '))); sentBytes += 1; return; }
    // A sender that follows the server writes only while the kernel takes its bytes: what it has sent is what the server has read and what its
    // two kernel buffers hold, however late the server began to read, never the whole body written on the clock.
    if (followServer && socket.writableNeedDrain) return;
    // A sender with a next request keeps sending until the refusal has been read: that is the moment the server's close has begun.
    const refused = pipelined === null || headRead();
    if (sentBytes < totalBytes && !(pipelined !== null && refused)) { socket.write(chunk(piece)); sentBytes += chunkBytes; return; }
    stopTicker();
    socket.write('0\r\n\r\n');
    if (pipelined !== null) { pipelinedAfterAnswer = refused; socket.write(pipelined); }
    readAnswer();
  }, everyMs);
  if (stayOpen) readAnswer();
  return { answer, closed, stop: () => { stopTicker(); socket.destroy(); } };
}

/** The `Retry-After` of an answer in whole seconds, or NaN. */
export const retryAfterOf = (answer) => Number(answer.headers?.['retry-after'] ?? answer.headers?.get?.('retry-after'));

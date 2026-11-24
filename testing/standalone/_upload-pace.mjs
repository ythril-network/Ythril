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
  return raceDeadline(sender.answer, ms, `race timeout: ${what}`, () => { sender.stop(); throw new Error(`no answer within ${ms} ms: ${what}`); });
}

/** The `Retry-After` of an answer in whole seconds, or NaN. */
export const retryAfterOf = (answer) => Number(answer.headers?.['retry-after'] ?? answer.headers?.get?.('retry-after'));

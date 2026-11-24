/**
 * An upload is read at the pace the export asks of its reader, by one window rule and one rate, and the reader never leaves a timer, a listener
 * or a destroyed request behind (bundle-270, Q-953, design revisions 2 and 3; tests 5, 11, 12, 14 and 15's shared rule).
 *
 * ## What it holds
 *
 * - **One window rule** (`util/pace-window.ts`): over a window of awaited time, a sender at exactly the floor passes and one byte under it is
 *   slow; a span shorter than the window is never judged; the window opens at the first mark and rolls once passed. The export and the upload
 *   read one rate constant.
 * - **Time counts only while the reader waits** (test 5): a sender above the rate whose consumer is slow is not refused, though its bytes over
 *   the wall time are under the floor.
 * - **A stall and a trickle are refused** by their own errors, and the reader neither destroys its source nor leaves its `readable` listener
 *   on it, so the door can answer and drain the rest (challenge F1, F2).
 * - **A bursty sender above the rate is accepted** (test 12), and a blocked event loop is not counted as the sender's silence (F8).
 * - **The timer is cleared on every exit** (test 11): the end, a consumer that throws, an abort, each refusal, a body over its bound.
 * - **A consumer failure mid-wait answers at once** (test 14): the abort signal settles the pending wait, and the stream form's destroy closes
 *   at once, not after the window.
 * - **One warn line per refusal**, naming the door, the code, the bytes and the awaited time, never the body (N6).
 *
 * Every case sets the pace through the knob with windows of a few hundred milliseconds and resets it after.
 *
 * Run: node --test testing/standalone/an-upload-is-read-at-the-pace-the-export-asks-of-its-reader.test.js (server build)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { elapse } from '../_shared/sleep.mjs';
import { readerModule as reader, setPace, resetPace } from './_upload-pace.mjs';

const windowModule = await import('../../server/dist/util/pace-window.js').catch(() => ({}));
const exportAct = await import('../../server/dist/rdf/export-act.js').catch(() => ({}));
const logModule = await import('../../server/dist/util/log.js');

const DOOR = 'pace-test';

/** The reader's generator over `source`, or a failing assertion naming the missing export. */
function read(source, options = {}) {
  assert.equal(typeof reader.readUpload, 'function', 'readUpload is not exported by server/src/util/upload-reader.ts');
  return reader.readUpload(source, { door: DOOR, ...options });
}

/** Drain `gen`, calling `each` per chunk; answers `{ bytes, error }`. */
async function drain(gen, each = async () => undefined) {
  let bytes = 0;
  try {
    for await (const chunk of gen) { bytes += chunk.length; await each(chunk); }
    return { bytes, error: null };
  } catch (error) { return { bytes, error }; }
}

/** Write `piece` to `source` `times` times, every `everyMs`, then end it unless `end` is false. */
async function feed(source, piece, times, everyMs, { end = true } = {}) {
  for (let i = 0; i < times; i++) {
    if (source.destroyed) return;
    source.write(piece);
    await elapse(everyMs, 'pacing: the sender keeps the rate the case is about');
  }
  if (end) source.end();
}

const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

afterEach(() => resetPace());

describe('the window rule both the export and the upload apply', () => {
  const rule = { windowMs: 1_000, minBytesPerSecond: 1_000 };
  const win = () => {
    assert.equal(typeof windowModule.paceWindow, 'function', 'paceWindow is not exported by server/src/util/pace-window.ts');
    return windowModule.paceWindow(() => rule);
  };

  it('a sender at exactly the floor over a window passes; one byte under it is slow (test 12, the exact floor)', () => {
    const at = win();
    assert.equal(at.observe({ bytes: 0, waitedMs: 0 }), undefined, 'the first mark opens the window');
    assert.equal(at.observe({ bytes: 1_000, waitedMs: 1_000 }), undefined, 'exactly the floor over the window is slow');
    const under = win();
    under.observe({ bytes: 0, waitedMs: 0 });
    assert.equal(under.observe({ bytes: 999, waitedMs: 1_000 }), 'slow', 'a byte under the floor over a whole window is not slow');
  });

  it('a span shorter than the window is never judged, and a passed window rolls from its close', () => {
    const w = win();
    w.observe({ bytes: 0, waitedMs: 0 });
    assert.equal(w.observe({ bytes: 0, waitedMs: 999 }), undefined, 'a span shorter than the window was judged');
    assert.equal(w.observe({ bytes: 5_000, waitedMs: 1_000 }), undefined);
    // The next window opens at the last close (1 000 ms, 5 000 bytes): 500 more bytes over the next second is under the floor.
    assert.equal(w.observe({ bytes: 5_500, waitedMs: 2_000 }), 'slow', 'the window did not roll from its close: the first window\'s bytes still counted');
  });

  it('the export and the upload read one rate constant (test 15\'s shared rule)', () => {
    assert.equal(typeof windowModule.MIN_TRANSFER_BYTES_PER_SECOND, 'number', 'MIN_TRANSFER_BYTES_PER_SECOND is not exported by server/src/util/pace-window.ts');
    assert.equal(exportAct.RDF_EXPORT_MIN_BYTES_PER_SECOND, windowModule.MIN_TRANSFER_BYTES_PER_SECOND, 'the export keeps a rate of its own');
    assert.equal(typeof reader.uploadPace, 'function', 'uploadPace is not exported by server/src/util/upload-reader.ts');
    assert.equal(reader.uploadPace().minBytesPerSecond, windowModule.MIN_TRANSFER_BYTES_PER_SECOND, 'the upload keeps a rate of its own');
  });
});

describe('the upload reader', () => {
  it('a sender above the rate whose consumer is slow is not refused: only the reader\'s waiting counts (test 5)', async () => {
    // 4 KiB every 20 ms is 200 KB/s, above the floor of 150 000 B/s; the consumer's 400 ms pause brings the bytes over the wall time under it.
    setPace({ idleMs: 2_000, windowMs: 200, minBytesPerSecond: 150_000 });
    const source = new PassThrough();
    const piece = Buffer.alloc(4_096, 0x61);
    const sending = feed(source, piece, 10, 20);
    const out = await drain(read(source), () => elapse(400, 'simulated latency: a consumer slower than its sender'));
    await sending;
    assert.equal(out.error, null, `an upload above the rate was refused for its consumer's pace: ${out.error?.name} ${out.error?.message}`);
    assert.equal(out.bytes, 10 * piece.length);
  });

  it('a sender that sends nothing for the idle bound is refused as stalled; the source is not destroyed and keeps no listener (F1, F2)', async () => {
    setPace({ idleMs: 300, windowMs: 5_000, minBytesPerSecond: 1 });
    const source = new PassThrough();
    source.write('first');
    const out = await drain(read(source));
    assert.equal(out.error?.name, 'UploadStalled', `a stalled source answered ${out.error?.name}: ${out.error?.message}`);
    assert.equal(out.error.idleMs, 300, 'the refusal names the idle bound it applied');
    assert.equal(source.destroyed, false, 'the reader destroyed its source: the door can no longer answer a client still sending');
    assert.equal(source.listenerCount('readable'), 0, 'the reader left its listener on the source: the door\'s drain cannot resume it');
  });

  it('a sender under the rate is refused as too slow once a window of waiting closes (test 2\'s rule)', async () => {
    setPace({ idleMs: 2_000, windowMs: 300, minBytesPerSecond: 10_000 });
    const source = new PassThrough();
    const sending = feed(source, 'x'.repeat(16), 40, 25, { end: false });
    const started = Date.now();
    const out = await drain(read(source));
    source.destroy();
    await sending;
    assert.equal(out.error?.name, 'UploadTooSlow', `a trickle answered ${out.error?.name}: ${out.error?.message}`);
    assert.ok(Date.now() - started < 1_500, `the trickle was refused only after ${Date.now() - started} ms: not when the window closed`);
    assert.equal(source.listenerCount('readable'), 0, 'the reader left its listener on the source');
  });

  it('a bursty sender above the rate is accepted (test 12)', async () => {
    // 8 KiB every 200 ms is 40 KB/s against a floor of 10 000 B/s over windows of 300 ms: each window holds a burst and a silence.
    setPace({ idleMs: 1_000, windowMs: 300, minBytesPerSecond: 10_000 });
    const source = new PassThrough();
    const sending = feed(source, Buffer.alloc(8_192, 0x62), 8, 200);
    const out = await drain(read(source));
    await sending;
    assert.equal(out.error, null, `a bursty sender above the rate was refused: ${out.error?.name} ${out.error?.message}`);
    assert.equal(out.bytes, 8 * 8_192);
  });

  it('a blocked event loop is not counted as the sender\'s silence (F8)', async () => {
    setPace({ idleMs: 100, windowMs: 5_000, minBytesPerSecond: 1 });
    const source = new PassThrough();
    source.write('first');
    const gen = read(source);
    assert.equal((await gen.next()).value.toString(), 'first');
    const pending = gen.next();
    // The loop is held past the idle bound, and the data that came meanwhile is handed over in the turn after the expired timers.
    setTimeout(() => {
      const until = Date.now() + 300;
      while (Date.now() < until) { /* the event loop is blocked */ }
      setImmediate(() => source.end('second'));
    }, 10);
    const next = await pending.then(r => ({ r }), error => ({ error }));
    assert.equal(next.error, undefined, `a sender whose data waited behind a blocked loop was refused: ${next.error?.name}`);
    assert.equal(next.r.value.toString(), 'second');
    await drain(gen);
  });

  it('a body over its bound is refused as over the bound', async () => {
    const source = new PassThrough();
    source.end(Buffer.alloc(2_048));
    const out = await drain(read(source, { max: 1_024 }));
    assert.equal(out.error?.name, 'UploadOverBound');
    assert.equal(out.error.limit, 1_024);
  });

  it('the timer is cleared on every exit: end, a consumer that throws, an abort, each refusal, a body over its bound (test 11)', async () => {
    setPace({ idleMs: 250, windowMs: 200, minBytesPerSecond: 100_000 });
    const exits = {
      end: async () => { const s = new PassThrough(); s.end('all'); return drain(read(s)); },
      'consumer throws': async () => {
        const s = new PassThrough(); s.write('a');
        const gen = read(s);
        try { for await (const _ of gen) throw new Error('the consumer failed'); } catch { /* expected */ }
      },
      abort: async () => {
        const s = new PassThrough(); const ac = new AbortController(); s.write('a');
        const gen = read(s, { signal: ac.signal });
        await gen.next();
        const pending = gen.next().catch(e => e);
        ac.abort();
        await pending;
      },
      stalled: async () => { const s = new PassThrough(); s.write('a'); return drain(read(s)); },
      'too slow': async () => { const s = new PassThrough(); const f = feed(s, 'x', 30, 20, { end: false }); const r = await drain(read(s, { idleMs: 2_000 })); s.destroy(); await f; return r; },
      'over its bound': async () => { const s = new PassThrough(); s.end(Buffer.alloc(64)); return drain(read(s, { max: 8 })); },
    };
    for (const [exit, run] of Object.entries(exits)) {
      await elapse(30, 'absence window: the previous case\'s own timers have run out');
      const before = timers();
      await run();
      await new Promise(r => setImmediate(r));
      assert.equal(timers(), before, `the reader left a timer after "${exit}"`);
    }
  });

  it('a consumer failure mid-wait answers at once, through the signal and through the stream form\'s destroy (test 14)', async () => {
    setPace({ idleMs: 5_000, windowMs: 5_000, minBytesPerSecond: 1 });
    const source = new PassThrough();
    source.write('a');
    const ac = new AbortController();
    const gen = read(source, { signal: ac.signal });
    await gen.next();
    const pending = gen.next().then(() => null, e => e);
    const started = Date.now();
    ac.abort(new Error('the consumer failed'));
    const err = await pending;
    assert.ok(err instanceof Error, 'an aborted wait did not reject');
    assert.ok(Date.now() - started < 1_000, `the aborted wait settled after ${Date.now() - started} ms, not at once`);
    assert.equal(source.destroyed, false, 'an abort destroyed the source');

    assert.equal(typeof reader.uploadReadable, 'function', 'uploadReadable is not exported by server/src/util/upload-reader.ts');
    const source2 = new PassThrough();
    source2.write('a');
    const stage = reader.uploadReadable(source2, { door: DOOR });
    stage.on('error', () => { /* the destroy's own */ });
    await new Promise(r => stage.once('data', r));
    const closedAt = new Promise(r => stage.once('close', () => r(Date.now())));
    const destroyedAt = Date.now();
    stage.destroy(new Error('the pipeline failed downstream'));
    assert.ok(await closedAt - destroyedAt < 1_000, 'a stage destroyed while its reader waited closed only after the window');
    assert.equal(source2.destroyed, false, 'destroying the stage destroyed the request under it');
  });

  it('each refusal writes one warn line naming the door, the code, the bytes and the awaited time, never the body (N6)', async () => {
    setPace({ idleMs: 200, windowMs: 5_000, minBytesPerSecond: 1 });
    const lines = [];
    const stop = logModule.subscribeLogLines(l => lines.push(l));
    try {
      const source = new PassThrough();
      source.write('SECRET-BODY-TEXT');
      await drain(read(source));
    } finally { stop(); }
    const warns = lines.filter(l => l.includes('[WARN') && l.includes(DOOR));
    assert.equal(warns.length, 1, `warn lines naming the door: ${JSON.stringify(lines)}`);
    assert.match(warns[0], /stalled/);
    assert.match(warns[0], /16 bytes/);
    assert.ok(!warns[0].includes('SECRET'), 'the warn line carries the body');
  });
});

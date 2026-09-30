/**
 * Local inference does not occupy the server's main thread.
 *
 * ## The finding this pins (Q-99 part 1), measured 2026-09-30 on the real nomic-embed-text-v1.5
 *
 * One text at a time took 39 ms and the main event loop's lag p50 was 38 ms: the lag WAS the inference. A batch of
 * 16 blocked it for 516 ms. The same inference in another thread or process left the main loop's lag at the timer
 * floor. So while the server embedded, it could not answer `/health`, a recall or a write; a bulk import
 * of 50 facts made `/health` take 1639 ms at p95 (idle p50 3 ms).
 *
 * ## What is run here, and why it is a real process
 *
 * The REAL inference child (`brain/embed-process`), under the REAL `fork`, running a fixture pipeline whose
 * inference spins the CPU for 500 ms, and a ticker on this thread that records the longest gap between ticks. A
 * thread would also pass a lag test; it is the repo's own incident log (an ONNX arena that never gave back 15.4 GiB,
 * a native abort taking the process down) that makes it a process, and `fork` semantics (IPC, exit codes, signals)
 * are only what they are in a real one. The fixture is given to `createLocalInference` as an ARGUMENT; it is
 * never found through the environment.
 *
 * ## It is only a gate if it can fail
 *
 * `inProcessSpawn()` (in `_inference-harness.mjs`) is the old behaviour dressed as a child: the same fixture
 * inference run on THIS thread. The second test asserts the ticker sees it, so a change that quietly moved the work
 * back (a thread that shares the loop, an `await` of a synchronous function) is red here and not in production.
 *
 * Not covered by any offline test: the real transformers loader inside the child on a machine that has the model.
 * Only the Docker suites exercise that.
 *
 * Run: node --test testing/standalone/local-inference-runs-off-the-main-thread.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURE_PIPELINE, tap, inProcessSpawn, startTicker } from './_inference-harness.mjs';

const MODEL = 'fixture/a';
const BUSY_MS = 500;
/** The loop may be late by a scheduling quantum, a GC, an IPC parse; it may not be late by an inference. */
const MAX_GAP_MS = 100;

let createLocalInference, forkChild;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-inference-'));
const savedCache = process.env.MODEL_CACHE_DIR;

before(async () => {
  process.env.MODEL_CACHE_DIR = tmp;
  ({ createLocalInference } = await import('../../server/dist/brain/local-inference.js'));
  ({ forkChild } = await import('../../server/dist/util/supervised-worker.js'));
});

after(() => {
  if (savedCache === undefined) delete process.env.MODEL_CACHE_DIR; else process.env.MODEL_CACHE_DIR = savedCache;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Warm the host (spawn, handshake, load), then measure one busy inference. The window opens after `ready`. */
async function measure(spawn) {
  const host = createLocalInference({ pipelineModule: FIXTURE_PIPELINE, spawn, log: () => {} });
  try {
    await host.warm({ modelId: MODEL });
    const ticker = startTicker(5);
    const reply = await host.request({ input: `busy [busy:${BUSY_MS}]`, lane: 'document', modelId: MODEL });
    return { ...ticker.stop(), reply };
  } finally {
    await host.stop({ budgetMs: 2_000 });
  }
}

describe('the main thread while the model works', () => {
  it(`keeps running timers: the longest gap stays under ${MAX_GAP_MS} ms while the child spins for ${BUSY_MS} ms`, async () => {
    const real = tap(forkChild);
    const { maxGap, ticks, reply } = await measure(real.spawn);

    assert.ok(reply.inferenceMs >= BUSY_MS - 50,
      `the child reported ${reply.inferenceMs} ms for a ${BUSY_MS} ms inference: the work did not happen, so the gap below means nothing`);
    assert.ok(real.children.length === 1 && real.children[0].pid !== process.pid, 'the work ran in another process');
    assert.ok(ticks >= 20, `only ${ticks} ticks in a ${BUSY_MS} ms window: the loop was starved`);
    assert.ok(maxGap < MAX_GAP_MS,
      `the main thread went ${Math.round(maxGap)} ms without running a timer while the model worked — `
      + 'the inference is occupying it, which is the defect this part of Q-99 removes');
  });

  it(`the measurement can tell the difference: the same inference on this thread leaves a gap of at least ${BUSY_MS - 100} ms`, async () => {
    const { maxGap } = await measure(inProcessSpawn().spawn);
    assert.ok(maxGap >= BUSY_MS - 100,
      `an inference run ON the main thread produced a max gap of only ${Math.round(maxGap)} ms: `
      + 'the ticker cannot see a blocked loop, so the test above proves nothing');
  });
});

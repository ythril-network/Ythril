/**
 * What the real-process inference tests share: a way to reach the REAL child, and to watch it without sleeping.
 *
 * ## Why a tap and not a timer
 *
 * A test that "waits a bit for the child to start working" passes on a fast machine and fails on a loaded one, and
 * worse, it passes when the child never started. The fixture pipeline announces `{ fixture: 'started' }` over the
 * same IPC channel the host uses, and the host ignores messages it does not know. A test that needs the child to be
 * demonstrably mid-inference wraps `spawn`, listens to `message`, and acts when that arrives: an event, not a guess.
 *
 * ## Why the mutation lives here
 *
 * The claim under test — *inference no longer occupies the main thread* — is only a claim if the measurement can
 * fail. `inProcessSpawn()` is the old behaviour dressed as a child: it runs the same fixture inference, but inside
 * the test's own process. The measurement must be green with the real child and red with this, and the test that
 * says so (`the measurement can tell the difference`) is what stops the gate from being a claim.
 */
import { fileURLToPath } from 'node:url';
import { FakeChild } from './_fake-child.mjs';
import { makePipeline } from './_fixtures/fixture-pipeline.mjs';

export const FIXTURE_PIPELINE = fileURLToPath(new URL('./_fixtures/fixture-pipeline.mjs', import.meta.url));
export const DRIVER = fileURLToPath(new URL('./_fixtures/inference-driver.mjs', import.meta.url));

/** Fail a wait instead of hanging the suite. Generous: it is a ceiling for a broken run, never a pace. */
export const CEILING_MS = 30_000;

/**
 * Wrap a real `spawn` so a test can see what each child says, in order, and wait for a message it cares about.
 *
 * @param {(spec: object) => import('node:child_process').ChildProcess} realSpawn  `forkChild` from the host module
 */
export function tap(realSpawn) {
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  /** Every message every child sent, with the child that sent it. */
  const messages = [];
  const waiters = [];

  function spawn(spec) {
    const child = realSpawn(spec);
    children.push(child);
    child.on('message', (m) => {
      messages.push({ child, m });
      for (const w of [...waiters]) {
        if (w.pred(m, child)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve({ m, child }); }
      }
    });
    return child;
  }

  /** Resolves with the first message (already seen or yet to come) matching `pred`. */
  function waitFor(pred, what = 'a message') {
    const seen = messages.find(x => pred(x.m, x.child));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`timed out after ${CEILING_MS} ms waiting for ${what}`));
      }, CEILING_MS);
      const w = { pred, resolve, timer };
      waiters.push(w);
    });
  }

  return { spawn, children, messages, waitFor };
}

/** Resolves when `child` has exited (immediately if it already has). */
export function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} did not exit within ${CEILING_MS} ms`)), CEILING_MS);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

/** Is a process with this pid alive? (`kill(pid, 0)` probes without signalling.) */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The OLD behaviour, as a `spawn`: a "child" that does the inference on the calling thread.
 *
 * It speaks the same protocol as the real child, so the host cannot tell the difference except by the one thing
 * the test measures: the main thread is busy while it works.
 */
export function inProcessSpawn() {
  const children = [];
  function spawn(spec) {
    const child = new FakeChild(spec, children.length);
    children.push(child);
    let pipe = null;
    let modelId = null;
    const realSend = child.send.bind(child);
    child.send = (msg, cb) => {
      const ok = realSend(msg, cb);
      queueMicrotask(async () => {
        if (msg?.type === 'load') {
          modelId = msg.modelId;
          pipe = makePipeline(modelId, () => {});
          child.loaded(modelId);
        } else if (msg?.type === 'request') {
          const started = Date.now();
          const out = await pipe(msg.input);   // runs to completion on THIS thread
          child.reply(msg.id, { vector: Array.from(out.data), modelId, inferenceMs: Date.now() - started });
        } else if (msg?.type === 'shutdown') {
          child.exit(0, null);
        }
      });
      return ok;
    };
    queueMicrotask(() => child.ready());
    return child;
  }
  return { spawn, children };
}

/**
 * A ticker on the main thread that records the longest gap between two ticks.
 *
 * `setInterval(5)` fires every ~5 ms on an idle loop, so the largest gap IS the longest time the loop was
 * unable to run a timer: the same quantity a `/health` request experiences as latency.
 */
export function startTicker(intervalMs = 5) {
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      // The interval that is still pending when the window closes counts too.
      const tail = performance.now() - last;
      return { maxGap: Math.max(maxGap, tail), ticks };
    },
  };
}

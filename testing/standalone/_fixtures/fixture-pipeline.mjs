/**
 * A stand-in for `brain/local-pipeline.js`, for tests that run the REAL inference child process.
 *
 * ## Why it exists, and why it is handed in rather than found
 *
 * The real loader needs a 274 MB model, so a test that used it would be a test only some machines can run — and
 * one that measures the model's speed instead of the host's behaviour. The child process, the host and the IPC
 * between them are what these tests are about, so the one thing that is faked is the thing that loads and runs
 * the model. It is passed to `createLocalInference({ pipelineModule })` as an argument. It is never read from an
 * environment variable or a config key: a switch like that in production code is a way to replace the embedder of
 * a running instance, and a gate (`the-inference-child-takes-its-module-as-an-argument`) says so.
 *
 * ## Its contract is the real module's
 *
 * `loadLocalPipeline({ modelId, cacheDir, offline, threads }, log)` resolving to `async (input, opts) => ({ data })`, where
 * `data` is a `Float32Array` — exactly what `brain/local-pipeline.ts` exports. Anything that works against this
 * works against the real one; nothing here is a second protocol.
 *
 * ## Behaviour is chosen by the INPUT
 *
 * The child's environment is an allowlist (that is one of the things under test), so the test cannot steer the
 * fixture through env variables. Directives in the text instead, each in square brackets:
 *
 *   [busy:N]      spin the CPU for N ms — a synchronous loop, the shape of real inference
 *   [crash]       exit the process (code 97) in the middle of the inference, after announcing it started
 *   [kill]        SIGKILL ourselves in the middle of the inference
 *   [hang]        never answer
 *   [throw]       the inference throws
 *   [stderr:TEXT] write TEXT to stderr first
 *   [noise]       send malformed and mismatched replies before the real one
 *
 * and a model id of `fixture/unloadable` refuses to load.
 *
 * Every inference announces itself over IPC first — `{ fixture: 'started', input }` — so a test can act at the
 * moment the child is demonstrably mid-request instead of sleeping and hoping. The host ignores messages it does
 * not know, which is also part of what is under test.
 */

/** Stable, model-dependent and input-dependent, so a vector says which model computed it. */
export function vectorFor(modelId, input) {
  const v = new Float32Array(8);
  let h = 2166136261;
  for (const ch of `${modelId}\u0000${input}`) {
    h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  }
  for (let i = 0; i < v.length; i++) {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    v[i] = (h % 10_000) / 10_000;
  }
  return v;
}

const directive = (input, name) => {
  const m = new RegExp(`\\[${name}(?::([^\\]]*))?\\]`).exec(input);
  return m ? (m[1] ?? '') : null;
};

function busyWait(ms) {
  const until = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < until) { /* the point: the thread is occupied */ }
}

/**
 * The inference function itself, with the channel it announces on passed in.
 *
 * Split from `loadLocalPipeline` so a test can run it IN the test's own process with a channel that goes nowhere:
 * that is the "before" arm of the off-the-main-thread measurement, and `process.send` in a `node --test` worker is
 * not a channel to write fixture chatter into.
 */
export function makePipeline(modelId, send) {
  return async function pipe(input /* , opts */) {
    send({ fixture: 'started', input, pid: process.pid });

    const stderr = directive(input, 'stderr');
    if (stderr !== null) process.stderr.write(`${stderr}\n`);

    const busy = directive(input, 'busy');
    if (busy !== null) busyWait(Number(busy) || 0);

    if (directive(input, 'crash') !== null) process.exit(97);
    if (directive(input, 'kill') !== null) process.kill(process.pid, 'SIGKILL');
    if (directive(input, 'hang') !== null) await new Promise(() => {});
    if (directive(input, 'throw') !== null) throw new Error('fixture inference failure');

    if (directive(input, 'noise') !== null) {
      // Replies the host must ignore: an id nobody asked about, a vector that is not numbers, an empty one,
      // a reply kind that does not exist, and a message of a type it has never heard of.
      send({ type: 'reply', id: 987654321, vector: [1, 2, 3], modelId, inferenceMs: 1 });
      send({ type: 'reply', id: 'not-a-number', vector: [1, 2, 3], modelId, inferenceMs: 1 });
      send({ type: 'reply', vector: [1, 2, 3], modelId, inferenceMs: 1 });
      send({ type: 'reply', id: -1, vector: ['x', null, 3], modelId, inferenceMs: 1 });
      send({ type: 'reply', id: -2, vector: [], modelId, inferenceMs: 1 });
      send({ type: 'error', id: -3, kind: 'no-such-kind', error: 'ignore me' });
      send({ type: 'no-such-type', payload: 'x'.repeat(1000) });
      send('a bare string');
      send(null);
    }

    return { data: vectorFor(modelId, input), dims: [1, 8] };
  };
}

export async function loadLocalPipeline({ modelId, cacheDir, offline, threads }, log) {
  const send = (m) => { if (typeof process.send === 'function') process.send(m); };
  send({
    fixture: 'loading', modelId, cacheDir, offline, threads,
    envKeys: Object.keys(process.env).sort(),
    execArgv: process.execArgv,
    pid: process.pid,
  });
  log?.('info', `fixture loading ${modelId}`);
  if (modelId === 'fixture/unloadable') {
    throw new Error(`Embedding model '${modelId}' cannot be loaded (fixture)`);
  }
  // A loaded model runtime holds handles of its own (onnxruntime's thread pool does), so a child that has loaded a
  // model does NOT end just because nothing else is left to do. This stand-in does the same: without it, "the child
  // exits when its parent dies" would pass for the wrong reason — an empty event loop — and only the explicit
  // `disconnect` handler, which is what a real model needs, would go untested.
  setInterval(() => {}, 60_000);
  return makePipeline(modelId, send);
}

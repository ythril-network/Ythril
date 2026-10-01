/**
 * The inference child: the process that holds the embedding model and runs it.
 *
 * ## What this process is for (Q-99 part 1)
 *
 * Inference used to run inside the server. One text took ~40 ms of CPU and the main event loop's lag WAS that
 * inference: while the server embedded it could not answer `/health`, a recall or a write. A native fault in
 * onnxruntime took the whole server with it, and its arena never gave memory back to the OS. Here the model lives
 * in a process of its own: the server stays responsive, a crash costs a respawn, and ten idle minutes return the
 * memory. `util/supervised-worker.ts` is the parent that starts, watches and replaces it;
 * `brain/local-inference.ts` is the embedding layer on top of that.
 *
 * ## What it does, and nothing else
 *
 *   host to child   `{ type: 'load', modelId }`                  load this model
 *                   `{ type: 'request', id, input, modelId }`    one inference
 *                   `{ type: 'shutdown' }`                       leave
 *   child to host   `{ type: 'ready' }`                          the channel is up (before any model is loaded)
 *                   `{ type: 'loaded', modelId }`
 *                   `{ type: 'reply', id, vector, modelId, inferenceMs }`
 *                   `{ type: 'error', kind: 'load', error }`     the model cannot be loaded (deterministic)
 *                   `{ type: 'error', id, kind: 'inference', error }`
 *                   `{ type: 'log', level, message }`
 *
 * The string it is given is the string it embeds: the task prefix is applied ONCE, on the main side, so the same
 * text embeds the same way wherever the model runs. The reply echoes the model the vector was computed with, and
 * the host stamps THAT, never the configuration it read earlier.
 *
 * ## Rules this file keeps, each held by `local-inference-structure.test.js`
 *
 *  - **It imports nothing of the server** — only its own small `brain/` modules, node built-ins and the model
 *    library (through `local-pipeline.ts`). There is no loaded config, no database and no logger in this process,
 *    and whatever it imported from the server would either fail here or drag the server's state into a process
 *    that must stay small.
 *  - **It never writes a console line.** A line from this process would reach the container log without the
 *    server's redaction; what it has to say goes over IPC (`log`) to the redacting logger. What the runtime itself
 *    writes to stderr is captured by the host and logged, redacted, when the process is lost.
 *  - **Its pipeline module is an ARGUMENT** (`--pipeline=<absolute path>`), for the tests, which replace the model
 *    with a fixture. It is never read from the environment or from configuration: a switch like that is a way to
 *    replace the embedder of a running instance.
 *  - **Its thread count is an ARGUMENT too** (`--threads=<n>`), decided by the host from the container's CPU budget.
 *    Nothing in this process counts CPUs: onnxruntime's default is the host's cores, which on a one-CPU container on
 *    16 cores ran at 640 ms per text against 54 ms with one thread.
 *  - **It ends with its owner.** An owner that died without saying goodbye (`kill -9`, the OOM killer) closes the
 *    IPC channel, and a process holding a loaded model would otherwise sit on its memory for good: it exits on
 *    `disconnect`. (A loaded model keeps handles of its own, so an empty event loop cannot be relied on to do it.)
 */
import { pathToFileURL } from 'node:url';
import { loadLocalPipeline, type LocalPipeline, type LocalPipelineSpec, type LoaderLog } from './local-pipeline.js';
import { modelsOffline } from './models-offline.js';

type Loader = (spec: LocalPipelineSpec, log?: LoaderLog) => Promise<LocalPipeline>;

/** Keeps a send to a closed channel from becoming an 'error' event on `process`, which nothing handles. */
function send(message: unknown, then?: () => void): void {
  try {
    process.send!(message, undefined, undefined, () => then?.());
  } catch {
    then?.();
  }
}

const log: LoaderLog = (level, message) => send({ type: 'log', level, message });

/** `--pipeline=<absolute path>` names a module exporting `loadLocalPipeline`; absent means the real loader. */
async function resolveLoader(): Promise<Loader> {
  const arg = process.argv.find(a => a.startsWith('--pipeline='));
  if (!arg) return loadLocalPipeline;
  const mod = await import(pathToFileURL(arg.slice('--pipeline='.length)).href) as { loadLocalPipeline?: Loader };
  if (typeof mod.loadLocalPipeline !== 'function') throw new Error(`${arg} does not export loadLocalPipeline`);
  return mod.loadLocalPipeline;
}

/**
 * `--threads=<n>`: how many intra-op threads the model may use, decided by the HOST from the container's CPU budget
 * (`util/cpu-budget.ts`). This process never sizes it itself: onnxruntime's own default is the host's core count,
 * which on a CPU-limited container is the thrash this argument exists to prevent.
 */
function threadsArgument(): number {
  const arg = process.argv.find(a => a.startsWith('--threads='));
  const n = arg ? Number(arg.slice('--threads='.length)) : Number.NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error('--threads=<n> was not passed to the inference process');
  return n;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

let loading = false;
let model: { id: string; pipe: LocalPipeline } | null = null;

async function onLoad(modelId: string): Promise<void> {
  // A child loads one model in its life; the host starts a new process for another.
  if (loading || model) return;
  loading = true;
  try {
    const cacheDir = process.env['MODEL_CACHE_DIR'];
    if (!cacheDir) throw new Error('MODEL_CACHE_DIR was not passed to the inference process');
    const threads = threadsArgument();
    const loader = await resolveLoader();
    const pipe = await loader({ modelId, cacheDir, offline: modelsOffline(), threads }, log);
    model = { id: modelId, pipe };
    send({ type: 'loaded', modelId });
  } catch (err) {
    // Deterministic, so the host remembers it and does not start another process for the same model. This process
    // stays up for the host's `shutdown` instead of exiting on its own: a process that exits right after sending
    // races its own last message, and a load failure misread as a crash would be retried.
    send({ type: 'error', kind: 'load', error: errorText(err) });
  }
}

async function onRequest(id: number, input: unknown, modelId: unknown): Promise<void> {
  try {
    if (!model || model.id !== modelId) throw new Error(`the inference process has not loaded model ${String(modelId)}`);
    if (typeof input !== 'string') throw new Error('an inference request needs a text input');
    const started = performance.now();
    // `truncation: true` is not a nicety — without it a long input cost GIGABYTES and produced a worse vector.
    //
    // Self-attention is quadratic in sequence length. A customer's 57 KB Markdown file chunked to two ~28 KB
    // chunks (the chunker had a minimum section size and no maximum, fixed in `section-chunker.ts`), which is
    // ~7,000 tokens: ~196 MiB of attention scores per head in fp32, ~2.35 GiB for one layer's twelve. Their pod
    // went 3.98 → 9.996 GiB inside a single 15-second scrape window, was OOMKilled at a 16 GiB limit, and then
    // sat at 15.40 GiB at idle because the ONNX arena allocator never returns its high-water mark. Reducing
    // embed concurrency had made it worse, because the peak is set by one chunk's size.
    //
    // It was also silently WRONG beyond the model's position count, so this is a correctness fix as much as a
    // fact one — and the chunker's cap does not make it redundant: this is the path every caller shares,
    // including `saveFact` with a large fact and a query nobody bounded. (That arena is also why this is a
    // process that exits when idle: the memory goes back to the OS.)
    const output = await model.pipe(input, { pooling: 'mean', normalize: true, truncation: true });
    const inferenceMs = Math.round((performance.now() - started) * 10) / 10;
    send({ type: 'reply', id, vector: Array.from(output.data), modelId: model.id, inferenceMs });
  } catch (err) {
    send({ type: 'error', id, kind: 'inference', error: errorText(err) });
  }
}

function onMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const m = message as { type?: unknown; id?: unknown; input?: unknown; modelId?: unknown };
  if (m.type === 'load' && typeof m.modelId === 'string') void onLoad(m.modelId);
  else if (m.type === 'request' && typeof m.id === 'number') void onRequest(m.id, m.input, m.modelId);
  else if (m.type === 'shutdown') process.exit(0);
}

if (typeof process.send !== 'function') {
  process.stderr.write('embed-process is started by the server with an IPC channel; it is not a command.\n');
  process.exit(2);
}

process.on('message', onMessage);
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
send({ type: 'ready' });

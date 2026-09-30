/**
 * Does running the embedding model occupy the server's main thread? Measures it, asserts nothing.
 *
 * ## What it measures (Q-99 part 1)
 *
 * The same texts, embedded by the REAL model two ways, with the event loop's delay sampled (a 5 ms timer) while they run:
 *
 *   main    the model loaded and run on THIS thread: what the server did before the model moved out
 *   child   the model behind `brain/local-inference.ts`, in its supervised child process: what it does now
 *
 * and, for `main` only, the same texts given to the model in batches of 16, which is the experiment that showed why
 * the inference process embeds ONE text per call: the batch blocks the loop for half a second, and on mixed-length
 * text it is slower per text as well, because every text in a batch is padded to the longest.
 *
 * Numbers from the machine that motivated the change, nomic-embed-text-v1.5, 16 texts of ~400 characters:
 *
 *   main thread, one text at a time    39 ms per text, loop lag p50 38 ms   (the lag IS the inference)
 *   main thread, batches of 16         a 516 ms block per batch
 *   child process, either shape        loop lag at the timer floor (p95 about 16 ms)
 *
 * ## Why it is a bench and not a gate
 *
 * It needs the real 274 MB model, so it can only run where the model is cached, and what it reports is speed, which
 * differs per machine. The gate that holds the claim on every machine is
 * `testing/standalone/local-inference-runs-off-the-main-thread.test.js`, which runs the real child under the real
 * `fork` with a fixture inference that spins the CPU and fails if the main thread is starved. This script is what to
 * run by hand when you want the real figures, for instance before changing `embedConcurrency` guidance.
 *
 * ## Running it
 *
 *   cd server && npm run build
 *   MODEL_CACHE_DIR=/path/to/model-cache node testing/bench/inference-blocks-the-loop.mjs [main|child|both]
 *
 * `MODEL_CACHE_DIR` must already contain the model (in the published image it is `/app/model-cache`). It never
 * downloads: runtime downloads are switched off for the run.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const dist = (p) => new URL(`../../server/dist/${p}`, import.meta.url).href;

const cacheDir = process.env['MODEL_CACHE_DIR'];
if (!cacheDir) {
  console.error('MODEL_CACHE_DIR is not set. Point it at a model cache that already holds the model (nothing is downloaded).');
  process.exit(2);
}
process.env['YTHRIL_MODELS_OFFLINE'] ??= '1';

const MODEL = process.env['EMBEDDING_MODEL'] ?? 'nomic-ai/nomic-embed-text-v1.5';
const OPTIONS = { pooling: 'mean', normalize: true, truncation: true };
const TEXTS = Array.from({ length: 64 }, (_, i) =>
  `search_document: Fact ${i}: the quarterly report for the northern region shows revenue growth of ${i}% driven by subscriptions, `
  + 'with churn falling after the onboarding redesign and support tickets per customer halving over two quarters. '.repeat(3));

const mode = process.argv[2] ?? 'both';
const lag = monitorEventLoopDelay({ resolution: 5 });
const ms = (ns) => (ns / 1e6).toFixed(1);

async function measured(label, count, work) {
  lag.enable();
  lag.reset();
  const started = performance.now();
  await work();
  const total = performance.now() - started;
  lag.disable();
  console.log(`${label.padEnd(36)} ${total.toFixed(0).padStart(6)} ms total, ${(total / count).toFixed(1).padStart(6)} ms/text`
    + ` | loop lag p50 ${ms(lag.percentile(50))} ms, p95 ${ms(lag.percentile(95))} ms, max ${ms(lag.max)} ms`);
}

if (mode === 'main' || mode === 'both') {
  const { loadLocalPipeline } = await import(dist('brain/local-pipeline.js'));
  const pipe = await loadLocalPipeline({ modelId: MODEL, cacheDir, offline: true });
  await pipe(TEXTS[0], OPTIONS);   // warm: the first inference pays one-time costs
  await measured('main thread, one text at a time', 16, async () => {
    for (let i = 0; i < 16; i++) await pipe(TEXTS[i], OPTIONS);
  });
  await measured('main thread, batches of 16', 64, async () => {
    for (let i = 0; i < 4; i++) await pipe(TEXTS.slice(i * 16, i * 16 + 16), OPTIONS);
  });
}

if (mode === 'child' || mode === 'both') {
  const { createLocalInference } = await import(dist('brain/local-inference.js'));
  const host = createLocalInference({ cacheDir, log: () => {} });
  const loadStarted = performance.now();
  await host.warm({ modelId: MODEL });
  console.log(`child process started and model loaded in ${(performance.now() - loadStarted).toFixed(0)} ms`);
  await host.request({ input: TEXTS[0], lane: 'document', modelId: MODEL });   // warm, as above
  await measured('child process, one text at a time', 16, async () => {
    for (let i = 0; i < 16; i++) await host.request({ input: TEXTS[i], lane: 'document', modelId: MODEL });
  });
  await host.stop({ budgetMs: 2_000 });
}

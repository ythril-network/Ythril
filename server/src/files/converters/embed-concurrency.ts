/**
 * How many chunk embeds may run at once — and why the answer differs by embedder.
 *
 * ## What the bundled model used to do to the server (measured, and no longer true)
 *
 * The bundled ONNX model ran INSIDE the server process. One chunk embed of ~1.8 KB took **~208 ms** and blocked the
 * event loop for essentially all of it: a 50 ms timer sampled during a run showed **mean 161 ms / max 222 ms of
 * lag**, and later a single text at a time showed 39 ms of inference against 38 ms of loop lag (the lag WAS the
 * inference), a batch of 16 blocking it for 516 ms. The pipeline ran **eight** chunks at once, the embedder is
 * CPU-bound, so eight concurrent inferences saturated every core and left nothing for the thread that answers
 * `/health`. On a reporting fleet a 358 KB document took ~6 minutes and the pod was killed repeatedly by an ordinary
 * liveness probe while it was working correctly: no error, no `failed` status, just restarts. That is why the
 * default was 2 and not 8.
 *
 * ## What it is for now (Q-99 part 1)
 *
 * The bundled model runs in a child process behind a first-in-first-out host (`brain/local-inference.ts`). The server's
 * loop no longer waits on it at ANY concurrency: the lag stays at the timer floor while the child works. The inference
 * process runs one embed at a time, so a larger number does not make the document faster; it only adds requests to the
 * queue in front of it, and that queue is shared with every recall query and brain write on the instance. What the
 * default bounds now is that queue pressure, and 2 is what keeps the inference process fed while the answer to the
 * previous request is crossing the IPC channel (a pipeline of depth two), without one large document putting
 * eight of its chunks ahead of a user's query (a query goes first, but never pre-empts the inference already running).
 *
 * ## Why this is not sized from the core count
 *
 * A container's CPU budget IS visible from inside it: `util/cpu-budget.ts` reads the cgroup quota (the reporting
 * deployment's 4 CPU on a 16-core node, the test stack's 1), and the inference process sizes its threads from it.
 * It is still not what this number should follow. The inference process runs one embed at a time whatever the core
 * count, so what this bounds is queue depth in front of it (see above), not parallel CPU work, and a larger budget
 * does not make a deeper queue useful. So the default stays a deliberately conservative constant, and an operator
 * with a reason can raise it. (The inference process does compete with the server for the container's CPU: it is a
 * second process, not a second allowance.)
 *
 * An EXTERNAL embedding endpoint is network-bound: the work happens elsewhere, this process is waiting on
 * sockets, and eight in flight is the right call. Same constant for both was the mistake.
 */

/**
 * Bundled-model default: what keeps the one inference process fed without stacking a document's chunks ahead of everything else.
 * (The name says "in process" for history; the model is in the inference process, and renaming an exported constant is a change to every importer.)
 */
export const IN_PROCESS_EMBED_CONCURRENCY = 2;

/** External default: the work is on another host, so this is a socket-count question, not a CPU one. */
export const EXTERNAL_EMBED_CONCURRENCY = 8;

/** Hard ceiling on the operator override, so a typo cannot turn into hundreds of parallel requests. */
export const MAX_EMBED_CONCURRENCY = 32;

/**
 * Resolve the chunk-embed concurrency for the configured embedder.
 *
 * `baseUrl` present ⇒ external. A blank/absent baseUrl is the bundled model, which runs one embed at a time in its own
 * process and is the case where more only queues. An explicit `embedConcurrency` wins for either, clamped to at least 1 — a zero or a
 * negative would otherwise stall ingestion completely, which is a worse failure than a slow one.
 */
export function embedConcurrency(cfg: { baseUrl?: string | null; embedConcurrency?: number }): number {
  const external = !!cfg.baseUrl?.trim();
  const dflt = external ? EXTERNAL_EMBED_CONCURRENCY : IN_PROCESS_EMBED_CONCURRENCY;
  const override = cfg.embedConcurrency;
  if (typeof override !== 'number' || !Number.isFinite(override)) return dflt;
  return Math.max(1, Math.min(MAX_EMBED_CONCURRENCY, Math.floor(override)));
}

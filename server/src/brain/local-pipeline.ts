/**
 * The ONE place that loads the local embedding model.
 *
 * ## Where it runs, and what that forced
 *
 * The model runs in a supervised child process (`brain/embed-process.ts`, hosted by `brain/local-inference.ts`), so
 * this is the code that child calls. That changes the shape of it, and only the shape:
 *
 *  - **Its inputs are arguments.** `{ modelId, cacheDir, offline, threads }`. The child has no loaded server config and must
 *    not guess, and the loader never reads `process.env`: the process that read the flags decided `offline` and
 *    passes it in. (`brain/models-offline.ts` is the one place those variables are read.)
 *  - **Its output is a callback.** Progress and warnings go to `log(level, message)`, which the child forwards over
 *    IPC to the server's redacting logger. A line written to a console in the child would reach the container log
 *    without redaction, and a model id or a URL in an error can carry a credential.
 *  - **It is the only importer of `@huggingface/transformers`** (`local-inference-structure.test.js`), so a second
 *    copy of the model library cannot be loaded into the server process by accident; if it could, inference would
 *    be back on the main thread.
 *
 * Everything else moved here unchanged from `embedding.ts`, including every sentence an operator might have in a
 * runbook.
 *
 * ## What is pinned where
 *
 * `local-pipeline-loader.test.js` runs this for real on the cases that are refused before any download could start.
 * `no-runtime-model-egress.test.js` pins the order that matters for the rest: an offline flag switches runtime
 * downloads off, and a cache miss with downloads allowed is announced BEFORE the request leaves.
 */
import fs from 'node:fs';
import path from 'node:path';

/** What a loaded pipeline is: text and options in, a tensor-like `{ data }` out. */
export type LocalPipeline = (text: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;

export interface LocalPipelineSpec {
  modelId: string;
  /** Where the model cache lives (`MODEL_CACHE_DIR`, or `<DATA_ROOT>/.model-cache` in development). */
  cacheDir: string;
  /** True when runtime downloads are forbidden (`brain/models-offline.ts`). */
  offline: boolean;
  /** onnxruntime's intra-op thread count: the host's CPU budget (`util/cpu-budget.ts`), never the library's default. */
  threads: number;
}

export type LoaderLog = (level: 'info' | 'warn', message: string) => void;

/**
 * Is `modelId` already in the on-disk cache, so that loading it needs no network?
 *
 * transformers.js keys its `FileCache` as `<cacheDir>/<model-id>/<file>` — verified against the cache the
 * Dockerfile bakes, which contains `nomic-ai/nomic-embed-text-v1.5/{config.json,tokenizer.json,onnx/…}`.
 * `config.json` is the first file every load asks for, so its presence is the cheap, accurate test for
 * "this load will stay local". Deliberately synchronous and best-effort: this only decides whether to
 * WARN, never whether to load.
 */
function isCached(cacheDir: string, modelId: string): boolean {
  try {
    return fs.existsSync(path.join(cacheDir, ...modelId.split('/'), 'config.json'));
  } catch {
    return false;
  }
}

export async function loadLocalPipeline(
  { modelId, cacheDir, offline, threads }: LocalPipelineSpec,
  log?: LoaderLog,
): Promise<LocalPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  // MODEL_CACHE_DIR: baked into Docker image at /app/model-cache (set in Dockerfile).
  // Falls back to DATA_ROOT/.model-cache for local development. Resolved by the host, which has the config.
  env.cacheDir = cacheDir;

  // A cache MISS reaches out to huggingface.co, and nothing used to say so.
  //
  // `env.allowRemoteModels` defaults to `true` in @huggingface/transformers, so `pipeline(…)` on a model
  // that is not in `cacheDir` silently downloads it: the instance's IP and the model id it asked for,
  // to a third party, with no configuration, from a product whose README says "works fully offline".
  // The shipped image bakes exactly ONE model, `nomic-ai/nomic-embed-text-v1.5`, so every other id —
  // and any id at all on a from-source install with an empty cache — was that request.
  //
  // Two changes, and neither of them can break the default:
  //   1. the offline flag is honoured (see `modelsOffline`), and the published image sets it;
  //   2. when remote IS allowed and the model is absent, the egress is ANNOUNCED before it happens.
  //
  // Measured rather than assumed, because the ordering inside `getModelFile` decides whether this is
  // safe: the `FileCache` is consulted BEFORE any local-or-remote decision, so a populated `cacheDir`
  // satisfies a load with remote fetching disabled. Loading the baked model against a real populated
  // cache with `allowRemoteModels = false` succeeded; a different id under the same conditions failed.
  const cached = isCached(cacheDir, modelId);
  if (offline) env.allowRemoteModels = false;
  else if (!cached) {
    log?.('warn',
      `Embedding model '${modelId}' is not in the local cache (${cacheDir}), so loading it will DOWNLOAD it `
      + 'from huggingface.co — roughly 274 MB, and that request carries this instance\'s IP address and the '
      + 'model id. Set HF_HUB_OFFLINE=1 (or YTHRIL_MODELS_OFFLINE=1) to forbid it, and bake the model into '
      + 'your image instead. The published Ythril image already ships with the flag set.',
    );
  }

  log?.('info', `Loading embedding model ${modelId} (cache: ${cacheDir}${offline ? ', offline' : ''}, ${threads} thread${threads === 1 ? '' : 's'})`);
  let pipe: unknown;
  try {
    // The thread count is not a tuning knob, it is the difference between working and not. onnxruntime sizes its
    // intra-op pool from the HOST's cores and ignores a container's CPU quota, so a one-CPU container on a 16-core
    // node ran sixteen threads on one CPU's quota: 640 ms per text, against 54 ms with one thread (measured in the
    // test stack, 2026-10-01). The host passes the budget it read from the cgroup; one request runs at a time, so
    // there is nothing for an inter-op pool to do.
    pipe = await pipeline('feature-extraction', modelId, {
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    });
  } catch (err) {
    // The library's own message on a blocked miss names `node_modules/@huggingface/transformers/models/`,
    // a path that has nothing to do with where Ythril keeps its models — so an operator would go looking
    // in the wrong place for a file that was never meant to be there. Say what actually happened.
    if (offline && !cached) {
      throw new Error(
        `Embedding model '${modelId}' is not in the model cache (${cacheDir}) and runtime downloads are `
        + 'disabled by HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / YTHRIL_MODELS_OFFLINE. Either bake the model '
        + 'into the image (see docs/integration-guide/02-hosting.md), point MODEL_CACHE_DIR at a cache that '
        + 'has it, or unset the flag to allow a one-time download from huggingface.co. '
        + `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }
  log?.('info', `Embedding model ready: ${modelId}`);
  return pipe as LocalPipeline;
}

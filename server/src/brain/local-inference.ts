/**
 * Local embedding inference: the model, in a supervised child process, as the rest of the server sees it.
 *
 * ## What this layer adds to "a child that may die"
 *
 * `util/supervised-worker.ts` owns everything generic (lanes, handshake, deadlines, backoff, idle exit, what a child
 * may say). This module owns the four things the EMBEDDING layer adds, and the generic host must not know about:
 *
 *  1. **Which child, and how it is told its model.** `brain/embed-process.ts`, found through `resolveEntry`, with the
 *     model cache directory in its environment, its inference thread count (`--threads=<n>`, the CPU budget from
 *     `util/cpu-budget.ts`) on its command line, and, for the tests only, `--pipeline=<module>` there too.
 *  2. **Two failure classes, crossing the process boundary as strings** (`brain/embed-errors.ts`). A model that
 *     cannot load is deterministic: the host remembers it and the text is unchanged, so the queue ends the job
 *     `failed` after its attempts and an operator can retry it. A LOST child is the embedder's fault and is
 *     transient, carrying a marker the queue recognises from the message alone. The marker is raised only here, by
 *     the host; any text the CHILD supplies is redacted and has the marker defused, so a string it chose can never
 *     read as "the process was lost".
 *  3. **The environment.** The child gets an allowlist (`LOCAL_INFERENCE_ENV_NAMES` on top of the platform basics),
 *     never the server's: no Mongo credential, master key or API token. The offline flags are on it because the loader
 *     no longer reads the environment, and the child's entry does; a flag the child never saw would let it download.
 *     The flags are read when a child STARTS, so a changed flag (or cache directory) restarts the child and forgets a
 *     load failure that was about the old setting.
 *  4. **What an operator can read.** Restarts by reason, the process state, and the queue wait, separately from how
 *     long the inference itself took (`ythril_embed_*`; the wait is its own metric so that a busy queue does not read
 *     as a slow model).
 *
 * ## The one instance
 *
 * `runLocalInference` and friends run over ONE lazily created instance, so nothing starts until the first local
 * embed, a `warm`, or never. `_setLocalInferenceForTests` is the seam for the tests of what CALLS it (`embed()`, the
 * brain embed worker).
 */
import path from 'node:path';
import { createSupervisedWorker, type SupervisedWorker, type WorkerEvent, type WorkerState, type Scheduler, type SpawnSpec, type ChildLike, type WorkerRequest, type WorkerReply } from '../util/supervised-worker.js';
import { resolveEntry } from '../util/entry-path.js';
import { availableCpus } from '../util/cpu-budget.js';
import { log as serverLog, redactSecrets } from '../util/log.js';
import { getDataRoot } from '../config/loader.js';
import { embedProcessRestartsTotal, embedWaitSeconds, setEmbedProcessPhaseSource } from '../metrics/registry.js';
import { LostChildError, withoutLostMarker } from './embed-errors.js';
import { MODELS_OFFLINE_ENV, modelsOffline } from './models-offline.js';

/**
 * The variables the child may inherit, on top of the platform basics: what the model loader needs, and nothing that
 * could be a secret. Written out (not derived) so that a reader of the allowlist sees it; `MODELS_OFFLINE_ENV` is the
 * list the child itself reads, and the check below refuses to start if the two ever disagree.
 */
export const LOCAL_INFERENCE_ENV_NAMES: readonly string[] = [
  'MODEL_CACHE_DIR', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE',
];

for (const name of MODELS_OFFLINE_ENV) {
  if (!LOCAL_INFERENCE_ENV_NAMES.includes(name)) {
    throw new Error(`${name} is read by the inference child but is not on its environment allowlist`);
  }
}

export interface LocalInferenceRequest extends WorkerRequest { lane: 'query' | 'document' }
export type LocalInferenceReply = WorkerReply;

/** What `embed()` and the brain embed worker use of the host, which is also what a test stands in for. */
export interface LocalInference {
  request(r: LocalInferenceRequest): Promise<LocalInferenceReply>;
  warm(r: { modelId: string }): Promise<void>;
  recycle(): Promise<void>;
  forgetLoadFailures(): void;
  waitOutBackoff(): Promise<void>;
  stop(opts?: { budgetMs?: number }): Promise<void>;
  state(): WorkerState;
}

export interface LocalInferenceOptions {
  /** TESTS ONLY: an absolute module path exporting `loadLocalPipeline`, given to the child as `--pipeline=`. Never read from the environment or config. */
  pipelineModule?: string;
  /** Overrides `MODEL_CACHE_DIR` and the development default. */
  cacheDir?: string;
  spawn?: (spec: SpawnSpec) => ChildLike;
  now?: () => number;
  scheduler?: Scheduler;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
  onEvent?: (event: WorkerEvent) => void;
  idleMs?: number;
  requestDeadlineMs?: number;
  loadDeadlineMs?: number;
  killGraceMs?: number;
  backoffMs?: (consecutiveLosses: number) => number;
  /** How many CPUs the child's inference may use; default `availableCpus` (`util/cpu-budget.ts`). Read once, by this host. */
  cpus?: () => number;
}

/**
 * The inference thread count the child is told, as `--threads=<n>`: the CPU budget, or 1 for anything that is not a
 * positive integer. onnxruntime would otherwise size its pool from the HOST's cores and ignore the container's quota
 * (640 ms per text against 54 ms on a one-CPU container on 16 cores). Decided here, once, never by the child.
 */
function inferenceThreads(cpus: () => number): number {
  const n = cpus();
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Where the model cache is: the argument, else `MODEL_CACHE_DIR` (baked into the Docker image at /app/model-cache),
 * else `<DATA_ROOT>/.model-cache` for local development. Resolved HERE, in the process that has the config, and
 * handed to the child, which has none.
 */
function resolveCacheDir(explicit: string | undefined): string {
  return explicit ?? process.env['MODEL_CACHE_DIR'] ?? path.join(getDataRoot(), '.model-cache');
}

/** What a child cannot see change once it has started: a change in either means a new process. */
function configurationFingerprint(explicitCacheDir: string | undefined): string {
  return `${modelsOffline() ? 'offline' : 'online'}|${resolveCacheDir(explicitCacheDir)}`;
}

export function createLocalInference(opts: LocalInferenceOptions = {}): LocalInference {
  const entry = resolveEntry('brain/embed-process');
  const threads = `--threads=${inferenceThreads(opts.cpus ?? availableCpus)}`;
  const worker: SupervisedWorker = createSupervisedWorker({
    entry: {
      cmd: entry.cmd,
      args: [...entry.args, threads, ...(opts.pipelineModule ? [`--pipeline=${opts.pipelineModule}`] : [])],
    },
    label: 'Inference process',
    spawn: opts.spawn,
    now: opts.now,
    scheduler: opts.scheduler,
    log: opts.log ?? ((level, message) => serverLog[level](message)),
    onEvent: (event) => {
      if (event.type === 'restart') embedProcessRestartsTotal.labels({ reason: event.reason }).inc();
      else if (event.type === 'served') embedWaitSeconds.observe(event.waitMs / 1000);
      opts.onEvent?.(event);
    },
    // `inFlight` is the generic host's answer to "was this the request the child held"; only that one is charged.
    lostError: (detail, { inFlight }) => new LostChildError(detail, { inFlight }),
    // Everything the child says is redacted first and has the marker defused second: see the module docblock.
    childText: text => withoutLostMarker(redactSecrets(text)),
    envNames: LOCAL_INFERENCE_ENV_NAMES,
    env: () => ({ MODEL_CACHE_DIR: resolveCacheDir(opts.cacheDir) }),
    idleMs: opts.idleMs,
    requestDeadlineMs: opts.requestDeadlineMs,
    loadDeadlineMs: opts.loadDeadlineMs,
    killGraceMs: opts.killGraceMs,
    backoffMs: opts.backoffMs,
  });

  let fingerprint: string | null = null;
  let recycling: Promise<void> | null = null;

  /** Before any request reaches the host: has something the running child read at its start changed? */
  async function settleConfiguration(): Promise<void> {
    const now = configurationFingerprint(opts.cacheDir);
    if (fingerprint !== null && now !== fingerprint) {
      recycling = worker.recycle().finally(() => { recycling = null; });
    }
    fingerprint = now;
    if (recycling) await recycling;
  }

  return {
    async request(r) {
      await settleConfiguration();
      return worker.request(r);
    },
    async warm(r) {
      await settleConfiguration();
      return worker.warm(r);
    },
    recycle: () => worker.recycle(),
    forgetLoadFailures: () => worker.forgetLoadFailures(),
    waitOutBackoff: () => worker.waitOutBackoff(),
    stop: (stopOpts) => worker.stop(stopOpts),
    state: () => worker.state(),
  };
}

// ── the one instance ───────────────────────────────────────────────────────────────────────────────

let instance: LocalInference | null = null;

const NEVER_STARTED: WorkerState = {
  phase: 'none', modelId: null, pid: null, inFlight: 0, queued: 0, spawns: 0,
  consecutiveLosses: 0, backoffRemainingMs: 0, loadFailure: null, loadFailureModelId: null,
};

function current(): LocalInference {
  instance ??= createLocalInference();
  return instance;
}

/** One inference in the child process. The caller has already prefixed `input`; the child embeds exactly that. */
export function runLocalInference(r: LocalInferenceRequest): Promise<LocalInferenceReply> {
  return current().request(r);
}

/** Start the child and load `modelId` without embedding anything. */
export function warmLocalInference(r: { modelId: string }): Promise<void> {
  return current().warm(r);
}

/** Drain and end the child. Never starts one just to stop it. */
export async function stopLocalInference(opts?: { budgetMs?: number }): Promise<void> {
  if (instance) await instance.stop(opts);
}

export function localInferenceState(): WorkerState {
  return instance ? instance.state() : NEVER_STARTED;
}

// What `ythril_embed_process_state` reports, read at scrape time from whichever instance is current.
setEmbedProcessPhaseSource(() => localInferenceState().phase);

/** Resolves at once unless the child is being respawned after a loss; the brain embed worker waits on this before it claims. */
export function waitOutLocalInferenceBackoff(): Promise<void> {
  return instance ? instance.waitOutBackoff() : Promise.resolve();
}

/** Test seam: replace the instance (or pass `null` for a fresh lazily created one). */
export function _setLocalInferenceForTests(replacement: LocalInference | null): void {
  instance = replacement;
}

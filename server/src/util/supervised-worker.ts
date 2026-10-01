/**
 * Run a request/response child process that may die — and say what a parent does about it.
 *
 * ## The one question this module answers
 *
 * *What does the parent do about a child that dies, hangs, lies, idles, or has to be replaced?* Everything the local
 * embedding model needs from its process lives here, and nothing embedding-specific does: the model, the error
 * classes the queue reads and the metrics are `brain/local-inference.ts`. A second child that answers requests (a
 * document converter, a reranker) would be a second caller of this, not a second supervisor.
 *
 * ## Why the model is in a child at all (Q-99 part 1)
 *
 * Inference in the server process occupied the main thread (40 ms a text; a 16-batch 516 ms), so `/health`, a recall
 * and every write waited behind it, and a native fault in onnxruntime took the whole server down. A worker thread
 * would fix the lag and nothing else: a native abort still kills its process, and only a process gives its memory
 * back to the OS (the repo already records an ONNX arena that never did). So this is a process.
 *
 * ## The rules, each held by `supervised-worker-host.test.js` on a clock the test drives
 *
 *  - **Lazy and single-flight.** Nothing starts until the first request. One request is on the child at a time (the
 *    model is single-flight; a second would only queue inside it), in two lanes: a `query` goes ahead of queued
 *    `document` requests and never pre-empts the one already running, so a recall waits for at most one inference.
 *  - **A handshake, then a model.** The child says `ready`; only then is it told which model to load; only after
 *    `loaded` does it get a request. A message before the handshake is believed no more than one after it.
 *  - **Everything that can be lost is rejected, never left to hang.** A loss (exit, crash, signal, a dead channel, a
 *    spawn error, a deadline) rejects the request it held AND every request queued behind it with `lostError`, and so
 *    does a request that arrives while the respawn backoff is running. A request that has been `send`-ed to a child
 *    that cannot answer must not wait for a reply that cannot come. Only the request the child HELD is rejected with
 *    `inFlight: true`: the rest were never sent, so they cannot have caused the loss, and a caller that counts losses
 *    against a request (the embed queue's `lostChildFailures`) must not count them.
 *  - **Deadlines, measured from the SEND.** A request gets `requestDeadlineMs` from the moment it leaves, not from the
 *    moment it was queued; the model load gets the much longer `loadDeadlineMs` (a first download takes minutes).
 *    Past either, the child is SIGKILLed and the request is rejected without waiting for the kill to land.
 *  - **Capped respawn backoff, reset only by a success.** A child that loaded and died without answering is not a
 *    success, so a crash loop does not reset its own backoff by reaching `ready`.
 *  - **A load failure is deterministic, so it is remembered.** The child says so (`kind: 'load'`), the host caches the
 *    text per model, and the same model is never tried twice until `forgetLoadFailures()` / `recycle()` (an operator
 *    changed something). Five failing embeds are one spawn, not five.
 *  - **Idle exit.** Ten minutes without a request and the child is told to leave, so the memory returns to the OS. The
 *    idle timer never runs while a request is pending, and an idle exit is not a fault: no backoff.
 *  - **One model per process.** A request for another model retires the child, AWAITS its exit, and only then starts a
 *    new one, so two copies of a model never coexist. Every vector carries the model its child echoed.
 *  - **The child holds the parent open only while there is work for it.** The child, its IPC channel and its pipes are
 *    `ref`'d while a request is pending and `unref`'d otherwise, so a script that awaits one embed can end, and the
 *    child ends with it (its channel closes).
 *  - **Nothing the child says is trusted.** Replies are validated (a known in-flight id, a non-empty vector of finite
 *    numbers no longer than `maxVectorLength`) and anything else is ignored; text it supplies is bounded and passed
 *    through `childText` before it reaches an error or a log; events of a child that is no longer current are ignored.
 *  - **The child gets an allowlisted environment**, never the server's: no database credential, master key or API
 *    token, no inherited inspector or heap flag.
 *
 * `node:child_process` is reached only through `forkChild`, and only here.
 */
import { fork } from 'node:child_process';
import { backoffDelayMs } from './backoff.js';

export type Lane = 'query' | 'document';
export type WorkerPhase = 'none' | 'starting' | 'ready' | 'backoff';
/** Why a child ended while its host was running, as the `restart` event reports it. */
export type RestartReason = 'exit' | 'killed' | 'deadline' | 'idle' | 'model-change';

/**
 * What a child needs from the platform just to START, and nothing else.
 *
 * Kept short on purpose (a test holds it to twenty): it is what node needs to find its own runtime and the temp
 * directory, not a second copy of the server's environment. On Windows `SystemRoot` is required for node to start
 * sockets at all, and the variable's case differs between shells, so both spellings are listed; they are de-duplicated
 * case-insensitively there. What the CALLER's child needs on top (the model cache, the offline flags) is `envNames`.
 */
export const PLATFORM_ENV: readonly string[] = [
  'PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'windir', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'TZ', 'NODE_ENV',
];

/** What `spawn` is given; `forkChild` is the production implementation. */
export interface SpawnSpec {
  entry: { cmd: string; args: string[] };
  env: Record<string, string>;
  execArgv: string[];
  /** Counts up with every spawn, so a caller's log and a test can tell one child from the next. */
  generation: number;
}

/** The part of `child_process.ChildProcess` the host is allowed to use. */
export interface ChildLike {
  pid?: number;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  ref?(): void;
  unref?(): void;
  channel?: { ref?(): void; unref?(): void } | null;
  stdout?: { on(event: string, fn: (chunk: unknown) => void): unknown; unref?(): void } | null;
  stderr?: { on(event: string, fn: (chunk: unknown) => void): unknown; unref?(): void } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Start the child for real: `fork` with an IPC channel, JSON serialisation, piped output and an explicit environment.
 *
 * `env` and `execArgv` are ALWAYS named. Left out, `fork` hands the child the server's whole environment (Mongo
 * credentials, the master key, API tokens) and its inspector and heap flags; `local-inference-structure.test.js`
 * holds every `fork(` in the server to naming both.
 */
export function forkChild(spec: SpawnSpec): ChildLike {
  const [script, ...rest] = spec.entry.args;
  if (!script) throw new Error('an entry needs at least a script to run');
  return fork(script, rest, {
    execPath: spec.entry.cmd,
    env: spec.env,
    execArgv: spec.execArgv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  }) as unknown as ChildLike;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): { unref?(): unknown };
  clearTimeout(handle: unknown): void;
}

const REAL_SCHEDULER: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface SupervisedWorkerOptions {
  /** What to run: a command and its arguments, normally from `resolveEntry`. */
  entry: { cmd: string; args: string[] };
  /** Starts a child; default `forkChild`. Tests inject a scripted one. */
  spawn?: (spec: SpawnSpec) => ChildLike;
  now?: () => number;
  scheduler?: Scheduler;
  /** The caller's (redacting) logger. */
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
  /** Observability: `spawn`, `restart`, `served` and `state` events. Never allowed to throw into the host. */
  onEvent?: (event: WorkerEvent) => void;
  /**
   * Builds the error for a lost child; the caller owns the class and its marker. `inFlight` is true only for the one
   * request the child was holding (sent, and not answered) when it was lost: every other rejection (queued behind it,
   * arriving during the backoff, waiting on a model load) is for a request that cannot have caused the loss, and a
   * caller that charges a loss to a request must be able to tell the two apart.
   */
  lostError?: (detail: string, info: { inFlight: boolean }) => Error;
  /** Respawn delay after the n-th consecutive loss. */
  backoffMs?: (consecutiveLosses: number) => number;
  idleMs?: number;
  requestDeadlineMs?: number;
  loadDeadlineMs?: number;
  killGraceMs?: number;
  /** A vector longer than this is taken for garbage. */
  maxVectorLength?: number;
  /** Longest text taken from a child for an error or a log line. */
  maxErrorChars?: number;
  /** Variables copied from the server's environment, on top of `PLATFORM_ENV`. */
  envNames?: readonly string[];
  /** Variables set explicitly (they win); a function is read at every spawn. */
  env?: Record<string, string> | (() => Record<string, string>);
  /** Applied to every string a child supplies, after it is bounded (redaction, marker defusing). */
  childText?: (text: string) => string;
  /** What to call the child in log lines and the stopped error. */
  label?: string;
}

export type WorkerEvent =
  | { type: 'spawn'; modelId: string }
  | { type: 'restart'; reason: RestartReason }
  | { type: 'served'; lane: Lane; waitMs: number; inferenceMs: number }
  | { type: 'state'; phase: WorkerPhase };

export interface WorkerRequest { input: string; lane?: Lane; modelId: string }
export interface WorkerReply { vector: number[]; modelId: string; inferenceMs: number }
export interface WorkerState {
  phase: WorkerPhase;
  modelId: string | null;
  pid: number | null;
  inFlight: number;
  queued: number;
  spawns: number;
  consecutiveLosses: number;
  backoffRemainingMs: number;
  loadFailure: string | null;
  /** The model `loadFailure` is about, so a reader can tell it from a failure of a model no longer configured. */
  loadFailureModelId: string | null;
}

/**
 * The default respawn delay: 1 s, 2 s, 4 s, ... capped at a minute, each scattered by `withJitter`.
 *
 * The cap is what keeps a transient fault (an OOM kill during a burst) from silencing the embedder for a day, and a
 * minute keeps a permanently broken child at about one 1-2 s model load a minute. The schedule is `backoffDelayMs`,
 * the repo's one capped exponential, so the exponent clamp and the jitter are not written here a second time. The
 * first loss is attempt 0, the base itself.
 */
const RESPAWN_BASE_MS = 1_000;
const RESPAWN_CAP_MS = 60_000;
export function respawnBackoffMs(consecutiveLosses: number, random: () => number = Math.random): number {
  return backoffDelayMs(Math.max(0, consecutiveLosses - 1), RESPAWN_BASE_MS, RESPAWN_CAP_MS, random);
}

/** How much of a child's own output is kept for the loss warning. */
const OUTPUT_TAIL_CHARS = 4_096;
/** After a loss, how long to wait for the child's output to finish arriving before logging without it. */
const LOSS_LOG_WAIT_MS = 1_000;

type Stage = 'starting' | 'loading' | 'loaded';
type Leaving = 'idle' | 'model-change' | 'load-failure' | 'stop';

interface Pending {
  warm: boolean;
  id: number;
  input: string;
  lane: Lane;
  modelId: string;
  enqueuedAt: number;
  sentAt: number;
  /** The send to the child failed, so a loss that follows cannot have been caused by this request. */
  undelivered?: boolean;
  /** `undefined` for a warm-up, which answers nothing. */
  resolve: (reply: WorkerReply | undefined) => void;
  reject: (error: Error) => void;
  deadline?: unknown;
}

/** One child process's life, from spawn to exit. */
interface Incarnation {
  child: ChildLike | null;
  modelId: string;
  stage: Stage;
  /** Set when WE asked it to go; its exit is then expected and is not a loss. */
  leaving: Leaving | null;
  /** We decided it is lost and have already rejected what it held; later events of it only finish the bookkeeping. */
  lost: boolean;
  exited: boolean;
  closed: boolean;
  output: string;
  lastInputChars: number;
  loadTimer?: unknown;
  killTimer?: unknown;
  logTimer?: unknown;
  finishLossLog?: () => void;
  exitWaiters: Array<() => void>;
}

export function createSupervisedWorker(opts: SupervisedWorkerOptions) {
  const now = opts.now ?? Date.now;
  const scheduler = opts.scheduler ?? REAL_SCHEDULER;
  const label = opts.label ?? 'Worker process';
  const log = opts.log ?? (() => {});
  const idleMs = opts.idleMs ?? 10 * 60_000;
  const requestDeadlineMs = opts.requestDeadlineMs ?? 60_000;
  const loadDeadlineMs = opts.loadDeadlineMs ?? 15 * 60_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const maxVectorLength = opts.maxVectorLength ?? 65_536;
  const maxErrorChars = opts.maxErrorChars ?? 900;
  const backoffMs = opts.backoffMs ?? respawnBackoffMs;
  const spawn = opts.spawn ?? forkChild;
  const lostError = opts.lostError
    ?? ((detail: string, info: { inFlight: boolean }) => Object.assign(new Error(`${label} lost (${detail})`), { lost: true, inFlight: info.inFlight }));

  const queues: Record<Lane, Pending[]> = { query: [], document: [] };
  let inFlight: Pending | null = null;
  let current: Incarnation | null = null;
  let generation = 0;
  let nextId = 0;
  let spawns = 0;
  let consecutiveLosses = 0;
  let backoffUntil = 0;
  let backoffTimer: unknown = null;
  let backoffWaiters: Array<() => void> = [];
  let idleTimer: unknown = null;
  let lastPhase: WorkerPhase = 'none';
  let stopping = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let inFlightWaiters: Array<() => void> = [];
  /** model -> the text its load failed with. Sticky until `forgetLoadFailures()`. */
  const loadFailures = new Map<string, string>();
  let lastLoadFailure: string | null = null;
  let lastLoadFailureModelId: string | null = null;

  // ── small helpers ────────────────────────────────────────────────────────────────────────────────
  const emit = (event: WorkerEvent): void => {
    try { opts.onEvent?.(event); } catch { /* an observer must never break the host */ }
  };

  /** A timer that never keeps the process alive by itself: the ref'd child is what does that, while there is work. */
  const timer = (fn: () => void, ms: number): unknown => {
    const handle = scheduler.setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  };
  const clear = (handle: unknown): void => { if (handle) scheduler.clearTimeout(handle); };

  const pending = (): number => queues.query.length + queues.document.length + (inFlight ? 1 : 0);
  const inBackoff = (): boolean => current === null && backoffUntil > now();
  const stoppedError = (): Error => new Error(`${label} is stopped`);

  /** Text from a child, bounded BEFORE it is processed (a megabyte of "error" costs a regex pass) and after. */
  const fromChild = (value: unknown): string => {
    const raw = (typeof value === 'string' ? value : String(value)).slice(0, maxErrorChars * 4);
    return (opts.childText ? opts.childText(raw) : raw).slice(0, maxErrorChars);
  };

  function phase(): WorkerPhase {
    if (inBackoff()) return 'backoff';
    if (!current) return 'none';
    return current.stage === 'loaded' ? 'ready' : 'starting';
  }

  function phaseChanged(): void {
    const p = phase();
    if (p !== lastPhase) { lastPhase = p; emit({ type: 'state', phase: p }); }
  }

  /** The environment for a child: the allowlist, read NOW, so a changed setting reaches the next child. */
  function childEnvironment(): Record<string, string> {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const name of [...PLATFORM_ENV, ...(opts.envNames ?? [])]) {
      const value = process.env[name];
      if (value === undefined) continue;
      const key = process.platform === 'win32' ? name.toLowerCase() : name;   // Windows names are case-insensitive
      if (seen.has(key)) continue;
      seen.add(key);
      out[name] = value;
    }
    return { ...out, ...(typeof opts.env === 'function' ? opts.env() : opts.env) };
  }

  /** Keep the parent alive for the child only while there is work for it (or while it is leaving). */
  function updateRef(): void {
    const inc = current;
    if (!inc || inc.exited || !inc.child) return;
    const hold = pending() > 0 || inc.leaving !== null;
    try {
      if (hold) { inc.child.ref?.(); inc.child.channel?.ref?.(); } else { inc.child.unref?.(); inc.child.channel?.unref?.(); }
    } catch { /* a handle that is already gone has nothing to hold */ }
  }

  function unrefAll(inc: Incarnation): void {
    try { inc.child?.unref?.(); inc.child?.channel?.unref?.(); } catch { /* as above */ }
  }

  function kill(inc: Incarnation): void {
    if (inc.exited || !inc.child) return;
    try { inc.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** `send` that cannot throw out of the host and treats a dead channel as a lost child. */
  /** `undelivered` runs before the loss when the message did not reach the child. */
  function sendOrLose(inc: Incarnation, message: unknown, undelivered?: () => void): void {
    if (!inc.child) return;
    try {
      inc.child.send(message, (error) => {
        if (error) { undelivered?.(); lose(inc, `send failed: ${error.message}`, 'exit'); }
      });
    } catch (error) {
      undelivered?.();
      lose(inc, `send failed: ${error instanceof Error ? error.message : String(error)}`, 'exit');
    }
  }

  function settleInFlight(): void {
    if (!inFlight) return;
    clear(inFlight.deadline);
    inFlight = null;
    const waiters = inFlightWaiters;
    inFlightWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Reject the request in flight and everything queued; `error` is told which of the two each one was. */
  function rejectEverything(error: (inFlight: boolean) => Error): void {
    const held = inFlight && !inFlight.undelivered ? inFlight : null;
    const all = [...(inFlight ? [inFlight] : []), ...queues.query, ...queues.document];
    settleInFlight();
    queues.query = [];
    queues.document = [];
    for (const p of all) p.reject(error(p === held));
  }

  // ── idle ─────────────────────────────────────────────────────────────────────────────────────────
  function disarmIdle(): void { clear(idleTimer); idleTimer = null; }

  /** Counts from the last activity: every time the queue drains this is re-armed from now. */
  function armIdle(): void {
    disarmIdle();
    const inc = current;
    if (!inc || inc.exited || inc.leaving || pending() > 0 || stopping) return;
    idleTimer = timer(() => {
      idleTimer = null;
      if (current === inc && pending() === 0) leave(inc, 'idle');
    }, idleMs);
  }

  // ── leaving and losing ───────────────────────────────────────────────────────────────────────────
  /** Ask a child to go (an orderly end), and make it go if it will not. Its exit is then expected. */
  function leave(inc: Incarnation, reason: Leaving): void {
    if (inc.leaving || inc.exited || inc.lost) return;
    inc.leaving = reason;
    disarmIdle();
    clear(inc.loadTimer);
    try { inc.child?.send({ type: 'shutdown' }, () => {}); } catch { /* the kill below is the answer to that */ }
    inc.killTimer = timer(() => kill(inc), killGraceMs);
    updateRef();
  }

  /**
   * The child is gone or cannot be talked to. Everything it held, and everything queued behind it, is rejected NOW
   * (not when the kill lands), the respawn backoff starts, and one warning carries what the child last said.
   */
  function lose(inc: Incarnation, detail: string, reason: RestartReason): void {
    if (inc.lost) return;
    inc.lost = true;
    clear(inc.loadTimer);
    clear(inc.killTimer);
    kill(inc);
    if (current !== inc) return;

    current = null;
    disarmIdle();
    unrefAll(inc);
    consecutiveLosses++;
    const wait = backoffMs(consecutiveLosses);
    if (!stopping && wait > 0) {
      backoffUntil = now() + wait;
      backoffTimer = timer(() => {
        backoffTimer = null;
        backoffUntil = 0;
        phaseChanged();
        const waiters = backoffWaiters;
        backoffWaiters = [];
        for (const wake of waiters) wake();
        pump();
      }, wait);
    }
    emit({ type: 'restart', reason });
    logLoss(inc, `${detail}; consecutive loss ${consecutiveLosses}${wait > 0 && !stopping ? `, next attempt in ${wait} ms` : ''}`);
    rejectEverything(inFlightNow => lostError(detail, { inFlight: inFlightNow }));
    phaseChanged();
  }

  /** One warning per loss, written once the child's output has finished arriving (or after a short wait for it). */
  function logLoss(inc: Incarnation, what: string): void {
    const finish = (): void => {
      if (!inc.finishLossLog) return;
      inc.finishLossLog = undefined;
      clear(inc.logTimer);
      const output = inc.output.trim();
      log('warn', `${label} lost (${what}); lastInputChars=${inc.lastInputChars}`
        + (output ? `; its output ended: ${opts.childText ? opts.childText(output) : output}` : ''));
    };
    inc.finishLossLog = finish;
    if (inc.closed || !inc.child) finish();
    else inc.logTimer = timer(finish, LOSS_LOG_WAIT_MS);
  }

  // ── the child's events ───────────────────────────────────────────────────────────────────────────
  function onExit(inc: Incarnation, code: number | null, signal: string | null): void {
    if (inc.exited) return;
    inc.exited = true;
    clear(inc.killTimer);
    clear(inc.loadTimer);
    if (!inc.lost && current === inc) {
      if (inc.leaving) {
        current = null;
        if (inc.leaving === 'idle' || inc.leaving === 'model-change') emit({ type: 'restart', reason: inc.leaving });
        phaseChanged();
      } else {
        lose(inc, `code=${code} signal=${signal}`, signal ? 'killed' : 'exit');
      }
    }
    const waiters = inc.exitWaiters.splice(0);
    for (const wake of waiters) wake();
    pump();
  }

  function onMessage(inc: Incarnation, message: unknown): void {
    if (current !== inc || inc.lost || !message || typeof message !== 'object' || Array.isArray(message)) return;
    const m = message as Record<string, unknown>;

    switch (m['type']) {
      case 'ready':
        if (inc.stage !== 'starting') return;
        inc.stage = 'loading';
        sendOrLose(inc, { type: 'load', modelId: inc.modelId });
        return;

      case 'loaded':
        if (inc.stage !== 'loading' || m['modelId'] !== inc.modelId) return;
        inc.stage = 'loaded';
        clear(inc.loadTimer);
        phaseChanged();
        pump();
        return;

      case 'log': {
        const level = m['level'];
        if ((level === 'info' || level === 'warn' || level === 'error' || level === 'debug') && typeof m['message'] === 'string') {
          log(level, fromChild(m['message']));
        }
        return;
      }

      case 'reply': {
        const request = inFlight;
        if (!request || inc.stage !== 'loaded' || typeof m['id'] !== 'number' || m['id'] !== request.id) return;
        const vector = m['vector'];
        if (!Array.isArray(vector) || vector.length === 0 || vector.length > maxVectorLength) return;
        if (!vector.every(x => typeof x === 'number' && Number.isFinite(x))) return;
        if (typeof m['modelId'] !== 'string') return;
        const ms = m['inferenceMs'];
        const inferenceMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0;
        settleInFlight();
        consecutiveLosses = 0;
        emit({ type: 'served', lane: request.lane, waitMs: request.sentAt - request.enqueuedAt, inferenceMs });
        request.resolve({ vector: vector as number[], modelId: m['modelId'], inferenceMs });
        updateRef();
        pump();
        return;
      }

      case 'error': {
        if (m['kind'] === 'load') {
          if (inc.stage !== 'loading') return;
          const text = fromChild(m['error']);
          // ONE warning, here, where the failure is learned. Every later request for this model is refused from
          // `loadFailures` in `enqueue` without reaching this line, so a queue of a thousand records cannot write a
          // thousand warnings; and without this line the only trace was a debug entry per failed embed job, which
          // an operator at the default level never sees. Both strings go through `fromChild` (bounded, redacted).
          if (!loadFailures.has(inc.modelId)) {
            log('warn', `${label}: model ${fromChild(inc.modelId)} could not be loaded; requests for it are refused `
              + `until the configuration changes: ${text}`);
          }
          loadFailures.set(inc.modelId, text);
          lastLoadFailure = text;
          lastLoadFailureModelId = inc.modelId;
          // What was waiting for THIS model can never be served; other models' requests stay queued.
          for (const lane of ['query', 'document'] as const) {
            const keep: Pending[] = [];
            for (const p of queues[lane]) {
              if (p.modelId === inc.modelId) p.reject(Object.assign(new Error(text), { kind: 'load' }));
              else keep.push(p);
            }
            queues[lane] = keep;
          }
          leave(inc, 'load-failure');
        } else if (m['kind'] === 'inference') {
          const request = inFlight;
          if (!request || typeof m['id'] !== 'number' || m['id'] !== request.id) return;
          settleInFlight();
          request.reject(Object.assign(new Error(fromChild(m['error'])), { kind: 'inference' }));
          updateRef();
          pump();
        }
        return;
      }

      default:
        return;   // a message of a type it has never heard of: ignored, which is part of the contract
    }
  }

  // ── starting and feeding a child ─────────────────────────────────────────────────────────────────
  function start(modelId: string): void {
    const inc: Incarnation = {
      child: null, modelId, stage: 'starting', leaving: null, lost: false, exited: false, closed: false,
      output: '', lastInputChars: 0, exitWaiters: [],
    };
    spawns++;
    current = inc;
    emit({ type: 'spawn', modelId });

    let child: ChildLike;
    try {
      child = spawn({ entry: opts.entry, env: childEnvironment(), execArgv: [], generation: ++generation });
    } catch (error) {
      lose(inc, `could not start: ${error instanceof Error ? error.message : String(error)}`, 'exit');
      return;
    }
    inc.child = child;

    const collect = (chunk: unknown): void => { inc.output = (inc.output + String(chunk)).slice(-OUTPUT_TAIL_CHARS); };
    try {
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      // Their pipes must not hold the parent open on their own either.
      child.stdout?.unref?.();
      child.stderr?.unref?.();
    } catch { /* output is a diagnostic, not a dependency */ }

    child.on('message', (message: unknown) => onMessage(inc, message));
    child.on('exit', (code: number | null, signal: string | null) => onExit(inc, code, signal));
    child.on('close', () => { inc.closed = true; inc.finishLossLog?.(); });
    // An 'error' event with no listener is thrown by node, and from here it would reach uncaughtException.
    child.on('error', (error: Error) => lose(inc, `child error: ${error?.message ?? error}`, 'exit'));

    inc.loadTimer = timer(
      () => lose(inc, `not loaded within ${loadDeadlineMs} ms, killed (signal=SIGKILL)`, 'deadline'),
      loadDeadlineMs,
    );
    phaseChanged();
    updateRef();
  }

  function dispatch(inc: Incarnation, request: Pending): void {
    inFlight = request;
    request.sentAt = now();
    inc.lastInputChars = request.input.length;
    request.deadline = timer(() => {
      if (current === inc && inFlight === request) lose(inc, `no answer within ${requestDeadlineMs} ms, killed (signal=SIGKILL)`, 'deadline');
    }, requestDeadlineMs);
    updateRef();
    sendOrLose(inc, { type: 'request', id: request.id, input: request.input, modelId: request.modelId },
      () => { request.undelivered = true; });
  }

  /** Decide what happens next: spawn, switch models, send the next request, or go idle. */
  function pump(): void {
    if (stopping || inFlight || inBackoff()) return;
    for (;;) {
      const next = queues.query[0] ?? queues.document[0];
      if (!next) { armIdle(); return; }
      disarmIdle();
      const inc = current;
      if (!inc) { start(next.modelId); return; }
      if (inc.leaving) return;                                   // its exit pumps again: never two copies of a model
      if (inc.modelId !== next.modelId) { leave(inc, 'model-change'); return; }
      if (inc.stage !== 'loaded') return;
      (queues.query[0] === next ? queues.query : queues.document).shift();
      if (next.warm) { next.resolve(undefined); continue; }
      dispatch(inc, next);
      return;
    }
  }

  function enqueue(warm: boolean, r: WorkerRequest): Promise<WorkerReply | undefined> {
    if (stopping || stopped) return Promise.reject(stoppedError());
    const lane = r.lane ?? 'document';
    if (lane !== 'query' && lane !== 'document') return Promise.reject(new TypeError(`unknown lane ${String(lane)}`));
    if (typeof r.modelId !== 'string' || r.modelId === '') return Promise.reject(new TypeError('a request needs a modelId'));
    if (!warm && typeof r.input !== 'string') return Promise.reject(new TypeError('a request needs a text input'));

    const failure = loadFailures.get(r.modelId);
    if (failure !== undefined) return Promise.reject(Object.assign(new Error(failure), { kind: 'load' }));
    if (inBackoff()) return Promise.reject(lostError(`respawning, ${backoffUntil - now()} ms of backoff remaining`, { inFlight: false }));

    return new Promise<WorkerReply | undefined>((resolve, reject) => {
      queues[lane].push({
        warm, id: ++nextId, input: warm ? '' : r.input, lane, modelId: r.modelId, enqueuedAt: now(), sentAt: 0, resolve, reject,
      });
      disarmIdle();
      updateRef();
      pump();
    });
  }

  const exitOf = (inc: Incarnation): Promise<void> =>
    inc.exited ? Promise.resolve() : new Promise<void>(resolve => inc.exitWaiters.push(resolve));

  const whenNoInFlight = (): Promise<void> =>
    inFlight ? new Promise<void>(resolve => inFlightWaiters.push(resolve)) : Promise.resolve();

  function forgetLoadFailures(): void {
    loadFailures.clear();
    lastLoadFailure = null;
    lastLoadFailureModelId = null;
  }

  async function doStop(budgetMs: number): Promise<void> {
    stopping = true;
    for (const lane of ['query', 'document'] as const) {
      const queued = queues[lane];
      queues[lane] = [];
      for (const p of queued) p.reject(stoppedError());
    }
    disarmIdle();
    clear(backoffTimer);
    backoffTimer = null;
    const waiters = backoffWaiters;
    backoffWaiters = [];
    for (const wake of waiters) wake();

    const inc = current;
    if (inc && inFlight) {
      // The running inference gets the budget to finish; past it, the child is cut off and the request told so.
      let budget: unknown;
      await Promise.race([
        whenNoInFlight(),
        new Promise<void>(resolve => { budget = timer(resolve, budgetMs); }),
      ]);
      clear(budget);
      if (inFlight) {
        const cutOff = inFlight;
        settleInFlight();
        cutOff.reject(stoppedError());
        inc.leaving = inc.leaving ?? 'stop';
        kill(inc);
      }
    }
    const last = current;
    if (last) {
      leave(last, 'stop');
      await exitOf(last);
    }
    stopped = true;
  }

  return {
    /** One inference. Resolves with the vector, the model the child echoed, and the child's own timing. */
    request: async (r: WorkerRequest): Promise<WorkerReply> => {
      const reply = await enqueue(false, r);
      if (!reply) throw new Error('a request resolved without a reply');   // only a warm-up resolves empty
      return reply;
    },

    /** Start the child and load the model without running an inference. */
    async warm(r: { modelId: string }): Promise<void> {
      await enqueue(true, { input: '', modelId: r.modelId, lane: 'document' });
    },

    forgetLoadFailures,

    /**
     * A configuration change the child cannot see (the offline flag, the cache directory): finish what is running,
     * end the child, await its exit, and forget what was learned about load failures, so the next request starts a
     * process under the new configuration and a model that failed to load is tried again.
     */
    async recycle(): Promise<void> {
      forgetLoadFailures();
      const inc = current;
      if (!inc) return;
      await whenNoInFlight();
      if (current !== inc) return;
      leave(inc, 'model-change');
      await exitOf(inc);
    },

    /** Resolves at once when the host is not backing off, and when the backoff ends when it is. */
    waitOutBackoff(): Promise<void> {
      if (!inBackoff()) return Promise.resolve();
      return new Promise<void>(resolve => backoffWaiters.push(resolve));
    },

    /** Drain the running inference (up to `budgetMs`), end the child and refuse further requests. Idempotent. */
    stop({ budgetMs = 2_000 }: { budgetMs?: number } = {}): Promise<void> {
      stopPromise ??= doStop(budgetMs);
      return stopPromise;
    },

    state(): WorkerState {
      return {
        phase: phase(),
        modelId: current?.modelId ?? null,
        pid: current?.child?.pid ?? null,
        inFlight: inFlight ? 1 : 0,
        queued: queues.query.length + queues.document.length,
        spawns,
        consecutiveLosses,
        backoffRemainingMs: inBackoff() ? backoffUntil - now() : 0,
        loadFailure: lastLoadFailure,
        loadFailureModelId: lastLoadFailureModelId,
      };
    },
  };
}

export type SupervisedWorker = ReturnType<typeof createSupervisedWorker>;

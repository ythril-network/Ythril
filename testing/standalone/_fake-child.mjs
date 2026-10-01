/**
 * A child process that is an object, for testing the supervisor without a process.
 *
 * ## What it stands in for, and the contract it keeps
 *
 * `child_process.fork()`'s return value — the parts the supervising host is allowed to use: `send`, `kill`,
 * `ref`/`unref` (and the same on `channel`), `pid`, `connected`, `exitCode`/`signalCode`, the `message`, `exit`,
 * `close`, `error` and `disconnect` events, and `stdout`/`stderr` streams. A host that reaches for anything else
 * works against the real thing by accident or not at all, and the real-process tests are the authority on that.
 *
 * ## The wire protocol (the ONE place a test spells it out)
 *
 * host to child:
 *   `{ type: 'load', modelId }`                    load this model, then answer `loaded` or an error
 *   `{ type: 'request', id, input, modelId }`      one inference
 *   `{ type: 'shutdown' }`                         finish up and exit
 * child to host:
 *   `{ type: 'ready' }`                            the IPC channel is up (sent before any model is loaded)
 *   `{ type: 'loaded', modelId }`                  the model is in memory
 *   `{ type: 'reply', id, vector, modelId, inferenceMs }`
 *   `{ type: 'error', kind: 'load', error }`       the model cannot be loaded (deterministic; the child then exits)
 *   `{ type: 'error', id, kind: 'inference', error }`
 *   `{ type: 'log', level, message }`              a line for the main process's redacting logger
 *
 * ## Nothing happens by itself
 *
 * By default the child says nothing and does nothing; the test calls `ready()`, `loaded()`, `reply()` and
 * `exit()` at the moment it wants to examine. `autopilot()` switches on a well-behaved child for the tests where
 * the child is not the subject.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { vectorFor } from './_fixtures/fixture-pipeline.mjs';

export class FakeChild extends EventEmitter {
  constructor(spec, index) {
    super();
    this.spec = spec;
    this.index = index;
    this.pid = 40_000 + index;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.exited = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    /** Every message the host sent, in order. */
    this.sent = [];
    /** Every signal the host sent, in order. */
    this.kills = [];
    // A freshly forked child keeps its parent alive until told otherwise — the default the host must manage.
    this.refed = true;
    this.channelRefed = true;
    this.channel = {
      ref: () => { this.channelRefed = true; },
      unref: () => { this.channelRefed = false; },
    };
    /** 'ok' | 'callback-error' | 'throw' | 'emit-error' — how `send` fails on a dead channel. */
    this.sendMode = 'ok';
    /** When false, `kill()` records the signal and the child stays alive until the test calls `exit()`. */
    this.dieOnKill = true;
    /** A real child leaves when told to. A test that needs one that ignores the request sets this false. */
    this.exitOnShutdown = true;
    /** Set by `autopilot()`. */
    this.auto = null;
    /** The model this child has loaded, as the protocol says it. */
    this.loadedModel = null;
  }

  send(msg, cb) {
    if (this.sendMode === 'throw') throw new Error('write EPIPE (fake)');
    if (this.sendMode === 'callback-error') {
      queueMicrotask(() => cb?.(new Error('channel closed (fake)')));
      return false;
    }
    if (this.sendMode === 'emit-error') {
      queueMicrotask(() => this.emit('error', new Error('write EPIPE (fake)')));
      return false;
    }
    if (this.exited) {
      queueMicrotask(() => cb?.(new Error('channel closed (fake)')));
      return false;
    }
    this.sent.push(msg);
    queueMicrotask(() => cb?.(null));
    if (msg?.type === 'shutdown' && this.exitOnShutdown) queueMicrotask(() => this.exit(0, null));
    if (this.auto) queueMicrotask(() => this.#autoAnswer(msg));
    return true;
  }

  kill(signal = 'SIGTERM') {
    this.kills.push(signal);
    // SIGKILL cannot be ignored; anything else can be, by `dieOnKill = false`.
    if (!this.exited && (this.dieOnKill || signal === 'SIGKILL')) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  ref() { this.refed = true; return this; }
  unref() { this.refed = false; return this; }

  // ── the test's side ──────────────────────────────────────────────────────────────────────────────
  say(msg) { this.emit('message', msg); }
  ready() { this.say({ type: 'ready' }); }
  loaded(modelId) { this.loadedModel = modelId; this.say({ type: 'loaded', modelId }); }
  reply(id, { vector = [0.1, 0.2, 0.3], modelId = this.loadedModel, inferenceMs = 5 } = {}) {
    this.say({ type: 'reply', id, vector, modelId, inferenceMs });
  }
  failInference(id, error = 'inference failed (fake)') {
    this.say({ type: 'error', id, kind: 'inference', error });
  }
  failLoad(error = 'model cannot be loaded (fake)') {
    this.say({ type: 'error', kind: 'load', error });
  }
  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    // `close` follows once the stdio streams are done, as in node.
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', code, signal);
    });
  }
  /** The `request` messages the host sent. */
  requests() { return this.sent.filter(m => m?.type === 'request'); }
  /** The `load` messages the host sent. */
  loads() { return this.sent.filter(m => m?.type === 'load'); }
  lastRequestId() { return this.requests().at(-1)?.id; }

  #autoAnswer(msg) {
    const a = this.auto;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'load') {
      if (a.failLoad?.(msg.modelId)) {
        this.failLoad(a.failLoad(msg.modelId));
        this.exit(1, null);
      } else {
        this.loaded(msg.modelId);
      }
    } else if (msg.type === 'request') {
      this.reply(msg.id, {
        vector: Array.from(vectorFor(this.loadedModel, msg.input)),
        modelId: a.echoModel ? a.echoModel(this.loadedModel) : this.loadedModel,
        inferenceMs: a.inferenceMs ?? 5,
      });
    } else if (msg.type === 'shutdown') {
      this.exit(0, null);
    }
  }
}

/**
 * Make `child` a well-behaved process: ready on spawn, loads what it is asked to, answers every request, exits on
 * `shutdown`.
 *
 * @param {FakeChild} child
 * @param {{ failLoad?: (modelId: string) => string | false, echoModel?: (modelId: string) => string,
 *           inferenceMs?: number, readyOnSpawn?: boolean }} [opts]
 */
export function autopilot(child, opts = {}) {
  child.auto = opts;
  if (opts.readyOnSpawn !== false) queueMicrotask(() => child.ready());
  return child;
}

/**
 * A `spawn` for the host, recording every child it made.
 *
 * @param {{ onSpawn?: (child: FakeChild, index: number) => void, auto?: boolean | object }} [opts]
 *   `auto` switches every child to `autopilot` (pass an object for its options); `onSpawn` runs afterwards, so a
 *   test can make a particular child misbehave.
 */
export function createFakeSpawn(opts = {}) {
  /** @type {FakeChild[]} */
  const children = [];
  function spawn(spec) {
    const child = new FakeChild(spec, children.length);
    children.push(child);
    if (opts.auto) autopilot(child, opts.auto === true ? {} : opts.auto);
    opts.onSpawn?.(child, children.length - 1);
    return child;
  }
  return { spawn, children, last: () => children.at(-1) };
}

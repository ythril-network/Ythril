/**
 * The embedding host built on the supervisor (`brain/local-inference.ts`): what it adds to "a child that may die".
 *
 * ## What this file is, against its neighbours
 *
 * `supervised-worker-host.test.js` pins the generic rules and `local-inference-child-lifecycle.test.js` pins
 * them against a real `fork`. This file pins the four things the EMBEDDING layer adds and the supervisor must not
 * know about: which child it launches and how it is told its model; the two kinds of failure crossing the process
 * boundary as strings (a load failure is deterministic and sticky, a lost child is transient and marked); what the
 * child is allowed to put in an error; and the metrics an operator reads to see any of it. On virtual time with a
 * scripted child, like the generic tests.
 *
 * ## The contract (names the implementation must match)
 *
 *   createLocalInference({ pipelineModule?, cacheDir?, spawn?, now?, scheduler?, log?, onEvent?, idleMs?, ... })
 *     returns the same object as `createSupervisedWorker`: request / warm / recycle / stop / state / waitOutBackoff
 *   LOCAL_INFERENCE_ENV_NAMES            the variables the child is allowed to inherit (the model loader's needs)
 *   runLocalInference(req), warmLocalInference({ modelId }), stopLocalInference({ budgetMs }),
 *   localInferenceState(), waitOutLocalInferenceBackoff()         module-level, over one lazily created instance
 *   _setLocalInferenceForTests(instance | null)                   the seam for `embed()` tests
 *
 * The child is launched as `resolveEntry('brain/embed-process')`, with `--pipeline=<absolute path>` appended ONLY
 * when a `pipelineModule` was passed.
 *
 * Run: node --test testing/standalone/local-inference-host.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualTime, flush } from './_virtual-time.mjs';
import { createFakeSpawn } from './_fake-child.mjs';

let createLocalInference, LOCAL_INFERENCE_ENV_NAMES, local;
let LOST_MARKER, isLostChildError, isTransientEmbedError, register;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-local-inference-'));
const saved = { MODEL_CACHE_DIR: process.env.MODEL_CACHE_DIR };
const FLAGS = ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE'];
for (const k of FLAGS) saved[k] = process.env[k];

before(async () => {
  process.env.MODEL_CACHE_DIR = tmp;
  for (const k of FLAGS) delete process.env[k];
  local = await import('../../server/dist/brain/local-inference.js');
  ({ createLocalInference, LOCAL_INFERENCE_ENV_NAMES } = local);
  ({ LOST_MARKER, isLostChildError } = await import('../../server/dist/brain/embed-errors.js'));
  ({ isTransientEmbedError } = await import('../../server/dist/brain/embed-queue.js'));
  ({ register } = await import('../../server/dist/metrics/registry.js'));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { local?._setLocalInferenceForTests?.(null); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function setup({ fake = { auto: true }, host = {} } = {}) {
  const vt = createVirtualTime();
  const spawns = createFakeSpawn(fake);
  const logs = [];
  const events = [];
  const inference = createLocalInference({
    spawn: spawns.spawn, now: vt.now, scheduler: vt.scheduler,
    log: (level, message) => logs.push({ level, message }),
    onEvent: e => events.push(e),
    idleMs: 10 * 60_000, requestDeadlineMs: 60_000, loadDeadlineMs: 15 * 60_000, backoffMs: () => 1_000,
    ...host,
  });
  return { vt, inference, fake: spawns, logs, events };
}

const ask = (inference, input = 'a', modelId = 'm', lane = 'document') => inference.request({ input, lane, modelId });
const reject = (p) => p.then(() => null, e => e);

/** The current value of a prom-client metric, optionally for one label set; 0 when it has no sample yet. */
async function sample(name, labels = {}, suffix = '') {
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `${name} is not registered — an operator cannot see what the host is doing`);
  const { values } = await metric.get();
  const row = values.find(v => (suffix ? v.metricName === `${name}${suffix}` : true)
    && Object.entries(labels).every(([k, val]) => v.labels?.[k] === val));
  return row?.value ?? 0;
}

describe('the child it launches', () => {
  it('is brain/embed-process, resolved through entry-path, with the pipeline module passed as an ARGUMENT', async () => {
    const { inference, fake } = setup();
    await ask(inference);
    const { entry } = fake.last().spec;
    assert.equal(entry.cmd, process.execPath);
    const target = entry.args.at(-1);
    assert.match(target.replace(/\\/g, '/'), /brain\/embed-process\.(js|ts)$/, `launches ${target}`);
    assert.ok(!entry.args.some(a => a.startsWith('--pipeline=')), 'no fixture unless one was given');

    const withModule = setup({ host: { pipelineModule: '/some/where/fixture.mjs' } });
    await ask(withModule.inference);
    assert.ok(withModule.fake.last().spec.entry.args.includes('--pipeline=/some/where/fixture.mjs'),
      `args were ${JSON.stringify(withModule.fake.last().spec.entry.args)}`);
  });

  it('gets the model cache directory through its environment, from the argument when one is given', async () => {
    const a = setup();
    await ask(a.inference);
    assert.equal(a.fake.last().spec.env.MODEL_CACHE_DIR, tmp);

    const b = setup({ host: { cacheDir: '/elsewhere' } });
    await ask(b.inference);
    assert.equal(b.fake.last().spec.env.MODEL_CACHE_DIR, '/elsewhere');
  });

  it('lists the variables the model loader needs and nothing else', () => {
    for (const must of ['MODEL_CACHE_DIR', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE']) {
      assert.ok(LOCAL_INFERENCE_ENV_NAMES.includes(must), `${must} missing`);
    }
    assert.deepEqual(LOCAL_INFERENCE_ENV_NAMES.filter(k => /KEY|SECRET|TOKEN|PASS|MONGO|URI|URL|AUTH|CRED/i.test(k)), []);
  });

  it('is restarted when the offline flag changes, because the child read it when it started', async () => {
    const { inference, fake, events } = setup();
    await ask(inference);
    assert.equal(fake.children.length, 1);
    process.env.HF_HUB_OFFLINE = '1';
    try {
      await ask(inference);
      assert.equal(fake.children.length, 2, 'the new flag can only reach a new process');
      assert.equal(fake.last().spec.env.HF_HUB_OFFLINE, '1');
      assert.deepEqual(events.filter(e => e.type === 'restart').map(e => e.reason), ['model-change']);
      await ask(inference);
      assert.equal(fake.children.length, 2, 'and an unchanged flag is not a reason to restart');
    } finally {
      delete process.env.HF_HUB_OFFLINE;
    }
  });

  it('forgets a sticky load failure when the offline flag changes', async () => {
    const { inference, fake } = setup({ fake: { auto: { failLoad: () => 'cannot load (offline)' } } });
    await reject(ask(inference));
    await reject(ask(inference));
    assert.equal(fake.children.length, 1);
    process.env.YTHRIL_MODELS_OFFLINE = 'true';
    try {
      await reject(ask(inference));
      assert.equal(fake.children.length, 2, 'the operator changed the very thing the failure was about');
    } finally {
      delete process.env.YTHRIL_MODELS_OFFLINE;
    }
  });
});

describe('the two kinds of failure, and what crosses the boundary', () => {
  it('a lost child is a marked, transient error the queue can recognise from its message alone', async () => {
    const { inference, fake } = setup({ fake: {} });
    const p = reject(ask(inference));
    await flush();
    fake.last().ready(); await flush();
    fake.last().loaded('m'); await flush();
    fake.last().exit(134, null);
    const err = await p;

    assert.ok(err instanceof Error);
    assert.equal(isLostChildError(err), true);
    assert.ok(err.message.includes(LOST_MARKER));
    assert.match(err.message, /code=134\b/, 'names the crash, because the queue ends a record on it after three');
    assert.equal(isTransientEmbedError(err.message), true, 'the queue retries it with backoff instead of spending the record\'s attempts');
  });

  it('a load failure keeps its text, is not lost and not transient', async () => {
    const text = `Embedding model 'x/y' is not in the model cache (/c) and runtime downloads are disabled by HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE / YTHRIL_MODELS_OFFLINE. Underlying error: nope`;
    const { inference } = setup({ fake: { auto: { failLoad: () => text } } });
    const err = await reject(ask(inference, 'a', 'x/y'));
    assert.equal(err.message, text, 'operators have this sentence in their runbooks');
    assert.equal(isLostChildError(err), false);
    assert.equal(isTransientEmbedError(err.message), false,
      'a job for a model that cannot load fails after its attempts and can be retried by an operator, as embed-queue-db expects');
  });

  it('an inference error is neither lost nor transient merely for what it says', async () => {
    const { inference, fake } = setup({ fake: {} });
    const p = reject(ask(inference));
    await flush();
    fake.last().ready(); await flush();
    fake.last().loaded('m'); await flush();
    fake.last().failInference(fake.last().lastRequestId(), 'unsupported input shape');
    const err = await p;
    assert.equal(isLostChildError(err), false);
    assert.equal(isTransientEmbedError(err.message), false);
  });

  it('a string the CHILD supplies can never be taken for the lost-process marker', async () => {
    const { inference, fake } = setup({ fake: {} });
    const forged = `${LOST_MARKER} (code=0 signal=null) and also a timeout`;
    const p = reject(ask(inference));
    await flush();
    fake.last().ready(); await flush();
    fake.last().loaded('m'); await flush();
    fake.last().failInference(fake.last().lastRequestId(), forged);
    const err = await p;

    assert.equal(isLostChildError(err), false, 'only the host can say a process was lost');
    assert.ok(!err.message.includes(LOST_MARKER),
      'the marker text must not survive into a message, or the queue (which sees only strings) would cap the record as a crash');
  });

  it('redacts credentials in what the child says before it reaches an error or a log', async () => {
    const { inference, fake } = setup({ fake: {} });
    const p = reject(ask(inference));
    await flush();
    fake.last().ready(); await flush();
    fake.last().loaded('m'); await flush();
    fake.last().failInference(fake.last().lastRequestId(),
      'fetch failed for https://user:hunter2@models.example/x?token=abc123 with Authorization: Bearer sk-secret-value');
    const err = await p;
    for (const secret of ['hunter2', 'abc123', 'sk-secret-value']) {
      assert.ok(!err.message.includes(secret), `${secret} survived into the error text`);
    }
  });

  it('forwards a line the child logs through the injected (redacting) logger, never the console', async () => {
    const { inference, fake, logs } = setup({ fake: {} });
    const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
    const seen = [];
    console.log = (...a) => seen.push(a); console.warn = (...a) => seen.push(a); console.error = (...a) => seen.push(a);
    try {
      ask(inference).catch(() => {});
      await flush();
      fake.last().ready(); await flush();
      fake.last().say({ type: 'log', level: 'info', message: 'Loading embedding model m (cache: /c)' });
      fake.last().say({ type: 'log', level: 'warn', message: 'with Bearer sk-abc-secret in it' });
      await flush();
    } finally { console.log = origLog; console.warn = origWarn; console.error = origErr; }
    assert.ok(logs.some(l => l.level === 'info' && /Loading embedding model m/.test(l.message)));
    const warn = logs.find(l => l.level === 'warn' && /in it/.test(l.message));
    assert.ok(warn, 'the warn line arrived');
    assert.ok(!/sk-abc-secret/.test(warn.message), 'and was redacted');
    assert.deepEqual(seen, [], 'nothing went to the console');
  });
});

describe('what an operator can read', () => {
  it('counts every restart by the reason the child ended', async () => {
    const before = {};
    const reasons = ['exit', 'killed', 'deadline', 'idle', 'model-change'];
    for (const r of reasons) before[r] = await sample('ythril_embed_process_restarts_total', { reason: r });

    const { inference, fake, vt } = setup({ fake: {}, host: { backoffMs: () => 10 } });
    local._setLocalInferenceForTests(inference);
    try {
      /** Start a request and bring its child to "model loaded"; `done` settles when the request does. */
      const up = async (modelId = 'm') => {
        const done = reject(ask(inference, 'x', modelId));
        await flush();
        fake.last().ready(); await flush();
        fake.last().loaded(modelId); await flush();
        return { done };
      };
      const answerIt = async () => { fake.last().reply(fake.last().lastRequestId()); await flush(); };

      let r = await up(); fake.last().exit(2, null); await r.done; await vt.advance(10);          // exit
      r = await up(); fake.last().exit(null, 'SIGKILL'); await r.done; await vt.advance(10);      // killed
      r = await up(); await vt.advance(60_000); await r.done; await vt.advance(10);               // deadline
      r = await up(); await answerIt(); await r.done;                                             // idle
      await vt.advance(10 * 60_000);
      r = await up('A'); await answerIt(); await r.done;                                          // model-change:
      const changed = reject(ask(inference, 'y', 'B'));                                           // A is retired,
      await flush(); await flush();                                                               // B spawned
      fake.last().ready(); await flush(); fake.last().loaded('B'); await flush();
      await answerIt(); await changed;
    } finally { local._setLocalInferenceForTests(null); }

    for (const r of reasons) {
      assert.equal(await sample('ythril_embed_process_restarts_total', { reason: r }) - before[r], 1, `reason ${r}`);
    }
  });

  it('exposes the process state as a gauge: 0 none, 1 starting, 2 ready, 3 backoff', async () => {
    const { inference, fake, vt } = setup({ fake: {}, host: { backoffMs: () => 5_000 } });
    local._setLocalInferenceForTests(inference);
    try {
      assert.equal(await sample('ythril_embed_process_state'), 0);
      const p = reject(ask(inference));
      await flush();
      assert.equal(await sample('ythril_embed_process_state'), 1);
      fake.last().ready(); await flush();
      fake.last().loaded('m'); await flush();
      assert.equal(await sample('ythril_embed_process_state'), 2, 'the model is in memory: ready, whether or not a request is running');
      fake.last().reply(fake.last().lastRequestId()); await p;
      assert.equal(await sample('ythril_embed_process_state'), 2);
      fake.last().exit(1, null); await flush();
      assert.equal(await sample('ythril_embed_process_state'), 3);
      await vt.advance(5_000);
      assert.equal(await sample('ythril_embed_process_state'), 0);
    } finally { local._setLocalInferenceForTests(null); }
  });

  it('records how long a request waited in the queue, separately from how long the inference took', async () => {
    const { inference, fake, vt } = setup({ fake: {} });
    local._setLocalInferenceForTests(inference);
    const sumBefore = await sample('ythril_embed_wait_seconds', {}, '_sum');
    try {
      const a = reject(ask(inference, 'a'));
      const b = reject(ask(inference, 'b'));
      await flush();
      fake.last().ready(); await flush();
      fake.last().loaded('m'); await flush();
      await vt.advance(3_000);                       // b waits three seconds behind a
      fake.last().reply(fake.last().lastRequestId()); await a;
      fake.last().reply(fake.last().lastRequestId()); await b;
    } finally { local._setLocalInferenceForTests(null); }
    const waited = await sample('ythril_embed_wait_seconds', {}, '_sum') - sumBefore;
    assert.ok(waited >= 3 && waited < 10, `the queue wait recorded was ${waited} s`);
  });
});

describe('the module-level door', () => {
  it('reports no process and waits for nothing when nothing was ever started', async () => {
    local._setLocalInferenceForTests(null);
    assert.equal(local.localInferenceState().phase, 'none');
    await local.waitOutLocalInferenceBackoff();
    await local.stopLocalInference({ budgetMs: 10 });
  });

  it('routes runLocalInference, warm, state and stop to the instance it was given', async () => {
    const { inference, fake } = setup();
    local._setLocalInferenceForTests(inference);
    try {
      await local.warmLocalInference({ modelId: 'm' });
      assert.equal(local.localInferenceState().phase, 'ready');
      const r = await local.runLocalInference({ input: 'a', lane: 'query', modelId: 'm' });
      assert.equal(r.modelId, 'm');
      await local.stopLocalInference({ budgetMs: 100 });
      assert.ok(fake.children[0].exited);
    } finally { local._setLocalInferenceForTests(null); }
  });
});

/**
 * The inference child against a REAL `fork()`: what a fake cannot tell you.
 *
 * ## Why these are separate from `supervised-worker-host.test.js`
 *
 * The host's rules (lanes, backoff, deadlines, idle) are pinned there on virtual time with a scripted child. They
 * say what the host DOES when the child behaves in a particular way. They cannot say that the real `fork` behaves
 * that way: that a SIGKILL surfaces as `signal=SIGKILL` and not a code, that a child whose parent died really exits,
 * that an unref'd channel really lets a script end, that stderr arrives, that the environment really is what was
 * chosen. Each test here is one of those facts about the real thing, and every wait is an event from the fixture
 * (`started`, `exit`, a log line) rather than a sleep. The only timers are constants the test injects (an idle
 * period of 200 ms, a deadline of 300 ms) because the constant IS the behaviour under test.
 *
 * The fixture pipeline (`_fixtures/fixture-pipeline.mjs`) replaces the model; it reaches the child as an
 * argument of `createLocalInference`, never through the environment.
 *
 * Run: node --test testing/standalone/local-inference-child-lifecycle.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { FIXTURE_PIPELINE, DRIVER, CEILING_MS, tap, exited, alive } from './_inference-harness.mjs';
import { vectorFor } from './_fixtures/fixture-pipeline.mjs';

let createLocalInference, LOCAL_INFERENCE_ENV_NAMES, forkChild, PLATFORM_ENV, isLostChildError, LOST_MARKER;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-inference-life-'));
const saved = {};
const PLANTED = {
  MODEL_CACHE_DIR: tmp,
  YTHRIL_TEST_CANARY_SECRET: 'canary',
  MONGO_URI: 'mongodb://user:pw@mongo.example/db',
  MASTER_KEY: 'master',
  ANTHROPIC_API_KEY: 'sk-ant-canary',
  NODE_OPTIONS: '--max-old-space-size=96',
};

before(async () => {
  for (const [k, v] of Object.entries(PLANTED)) { saved[k] = process.env[k]; process.env[k] = v; }
  ({ createLocalInference, LOCAL_INFERENCE_ENV_NAMES } = await import('../../server/dist/brain/local-inference.js'));
  ({ forkChild, PLATFORM_ENV } = await import('../../server/dist/util/supervised-worker.js'));
  ({ isLostChildError, LOST_MARKER } = await import('../../server/dist/brain/embed-errors.js'));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A log sink a test can wait on: resolves when a line matching the predicate exists (already or to come). */
function logSink() {
  const lines = [];
  const waiters = [];
  return {
    lines,
    log(level, message) {
      lines.push({ level, message });
      for (const w of [...waiters]) {
        if (w.pred({ level, message })) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve({ level, message }); }
      }
    },
    waitFor(pred, what = 'a log line') {
      const seen = lines.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; saw ${JSON.stringify(lines)}`)), CEILING_MS);
        waiters.push({ pred, resolve, timer });
      });
    },
  };
}

/** A host over the real child, with a tap on its messages and a log sink. Always stopped. */
async function withHost(opts, fn) {
  const real = tap(forkChild);
  const sink = logSink();
  const events = [];
  const host = createLocalInference({
    pipelineModule: FIXTURE_PIPELINE, spawn: real.spawn, log: sink.log, onEvent: e => events.push(e),
    backoffMs: () => 20, ...opts,
  });
  try {
    return await fn({ host, real, sink, events });
  } finally {
    await host.stop({ budgetMs: 1_000 });
  }
}

const ask = (host, input, modelId = 'fixture/a', lane = 'document') => host.request({ input, lane, modelId });

describe('a child killed between the request and the reply', () => {
  it('rejects the request with a lost error naming the signal, and the next embed succeeds on a new process', async () => {
    await withHost({}, async ({ host, real }) => {
      const hung = ask(host, 'victim [hang]').then(() => null, e => e);
      const { child } = await real.waitFor(m => m.fixture === 'started' && /victim/.test(m.input), 'the fixture to be mid-inference');
      const firstPid = child.pid;
      child.kill('SIGKILL');                          // from outside, as the OOM killer would
      const err = await hung;

      assert.ok(err, 'the request was rejected, not left waiting for a reply that cannot come');
      assert.equal(isLostChildError(err), true);
      assert.ok(err.message.includes(LOST_MARKER));
      assert.match(err.message, /signal=SIGKILL/);

      await host.waitOutBackoff();
      const ok = await ask(host, 'after');
      assert.deepEqual(ok.vector, Array.from(vectorFor('fixture/a', 'after')));
      assert.notEqual(host.state().pid, firstPid, 'a fresh process, not the dead one');
      assert.equal(real.children.length, 2);
    });
  });

  it('logs a fixture that crashes itself with its exit code and what it wrote to stderr', async () => {
    await withHost({}, async ({ host, sink }) => {
      const err = await ask(host, 'boom [stderr:BOOM-FROM-THE-FIXTURE] [crash]').then(() => null, e => e);
      assert.equal(isLostChildError(err), true);
      assert.match(err.message, /code=97\b/, 'the exit code is in the error the caller sees');
      const line = await sink.waitFor(l => l.level === 'warn' && /code=97\b/.test(l.message), 'the loss warning');
      assert.match(line.message, /BOOM-FROM-THE-FIXTURE/, 'the child\'s last words reach the operator\'s log');
      assert.match(line.message, /lastInputChars=\d+/);
    });
  });

  it('a child that kills ITSELF is reported as lost, with whatever the platform says about how', async () => {
    await withHost({}, async ({ host }) => {
      const err = await ask(host, 'suicide [kill]').then(() => null, e => e);
      assert.equal(isLostChildError(err), true);
      // Windows has no signals: a process that `kill`s itself simply ends with code 1, and node reports a signal
      // only for one it sent. So the assertion is about what the platform can say.
      assert.match(err.message, process.platform === 'win32' ? /code=1(?!\d)/ : /signal=SIGKILL/);
    });
  });
});

describe('a child whose owner died', () => {
  it('exits by itself when its PARENT is SIGKILLed with no chance to say goodbye', async () => {
    const driver = spawnProcess(process.execPath, [DRIVER, 'orphan', FIXTURE_PIPELINE], {
      stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
    });
    try {
      const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the driver never reported a child')), CEILING_MS);
        let buf = '';
        driver.stdout.on('data', (d) => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl >= 0) { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); }
        });
        driver.once('exit', () => reject(new Error('the driver exited before reporting a child')));
      });
      assert.equal(line.ready, true);
      assert.ok(alive(line.childPid), 'the child is running while its parent is');

      driver.kill('SIGKILL');
      await exited(driver);

      // `kill(pid, 0)` is the only way to watch a process that is nobody\'s child any more. Bounded, not a pace.
      const deadline = Date.now() + CEILING_MS;
      while (alive(line.childPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      assert.equal(alive(line.childPid), false,
        'the inference child outlived its parent: after a kill -9 or an OOM kill it would sit on its memory for good');
    } finally {
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    }
  });
});

describe('what keeps the parent process alive', () => {
  async function runDriver(scenario) {
    const driver = spawnProcess(process.execPath, [DRIVER, scenario, FIXTURE_PIPELINE], {
      stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
    });
    let out = '';
    driver.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => driver.kill('SIGKILL'), CEILING_MS);
    const { code, signal } = await exited(driver);
    clearTimeout(timer);
    return { code, signal, lines: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  }

  it('a script that awaits one embed and does nothing else ends by itself afterwards', async () => {
    const r = await runDriver('finishes');
    assert.equal(r.signal, null, 'the driver had to be killed: something still held the process open after the embed');
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines[0].vector, Array.from(vectorFor('fixture/a', 'hello')));
    const deadline = Date.now() + CEILING_MS;
    while (alive(r.lines[0].childPid) && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
    assert.equal(alive(r.lines[0].childPid), false, 'and the child went with it');
  });

  it('but it does NOT end while an embed is pending', async () => {
    const r = await runDriver('holds');
    assert.equal(r.code, 0);
    assert.equal(r.lines.length, 1, 'the process ended before the reply arrived: the child was not holding it open');
    assert.equal(r.lines[0].done, true, JSON.stringify(r.lines[0]));
  });
});

describe('an idle child', () => {
  it('exits after the idle period the host was given, without the parent ending, and the next embed starts another', async () => {
    await withHost({ idleMs: 200 }, async ({ host, real, events }) => {
      await ask(host, 'one');
      const first = real.children[0];
      const gone = await exited(first);             // an event, not a sleep: the host asked it to go
      assert.ok(gone.code === 0 || gone.signal !== null, `ended as ${JSON.stringify(gone)}`);
      assert.equal(host.state().phase, 'none');
      assert.deepEqual(events.filter(e => e.type === 'restart').map(e => e.reason), ['idle']);

      await ask(host, 'two');
      assert.equal(real.children.length, 2);
      assert.notEqual(real.children[1].pid, first.pid);
    });
  });
});

describe('a child that wedges', () => {
  it('is killed at the request deadline and the request rejected', async () => {
    await withHost({ requestDeadlineMs: 300 }, async ({ host, real, events }) => {
      const err = await ask(host, 'stuck [hang]').then(() => null, e => e);
      assert.equal(isLostChildError(err), true);
      const child = real.children[0];
      const { signal } = await exited(child);
      assert.equal(signal, 'SIGKILL', 'a wedged child is not asked politely');
      assert.deepEqual(events.filter(e => e.type === 'restart').map(e => e.reason), ['deadline']);
    });
  });
});

describe('the child\'s environment', () => {
  it('is the allowlist: no database credential, key, token or inspector flag from the server\'s own environment', async () => {
    await withHost({}, async ({ host, real }) => {
      await ask(host, 'env');
      const { m } = await real.waitFor(x => x.fixture === 'loading', 'the fixture to load');
      const keys = new Set(m.envKeys);

      for (const k of Object.keys(PLANTED).filter(k => k !== 'MODEL_CACHE_DIR')) {
        assert.ok(!keys.has(k), `${k} from the server's environment reached the inference child`);
      }
      assert.ok(keys.has('MODEL_CACHE_DIR'), 'what the model loader needs does reach it');
      assert.deepEqual(m.execArgv, [], 'inherited node flags are stripped');

      // Windows writes a fixed set of its own variables into EVERY process's environment block, even one started
      // with an empty environment (measured with `spawnSync(node, { env: {} })`). They are the OS's, carry no
      // secret, and are not something the host can withhold; everything else must be on the allowlist.
      const OS_INJECTED = process.platform === 'win32'
        ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR', 'SYSTEMROOT', 'TEMP']
        : [];
      const norm = (k) => (process.platform === 'win32' ? k.toLowerCase() : k);
      const allowed = new Set([
        ...PLATFORM_ENV, ...LOCAL_INFERENCE_ENV_NAMES, ...OS_INJECTED, 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE',
      ].map(norm));
      const stray = [...keys].filter(k => !allowed.has(norm(k)));
      assert.deepEqual(stray, [], 'the child has variables nobody allowed');
    });
  });

  it('names only what the loader reads: the cache, the offline flags, and nothing that looks like a secret', () => {
    for (const must of ['MODEL_CACHE_DIR', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'YTHRIL_MODELS_OFFLINE']) {
      assert.ok(LOCAL_INFERENCE_ENV_NAMES.includes(must), `${must} must reach the child or offline mode silently stops working`);
    }
    const secretish = LOCAL_INFERENCE_ENV_NAMES.filter(k => /KEY|SECRET|TOKEN|PASS|MONGO|URI|URL|AUTH|CRED/i.test(k));
    assert.deepEqual(secretish, []);
    assert.ok(LOCAL_INFERENCE_ENV_NAMES.length <= 12, 'a short list: the model loader\'s needs, not a copy of the server\'s environment');
  });
});

describe('what a child sends that the host must not believe', () => {
  it('ignores malformed, mismatched and unknown messages around a real answer, on the same process', async () => {
    await withHost({}, async ({ host, real }) => {
      const r = await ask(host, 'noisy [noise]');
      assert.deepEqual(r.vector, Array.from(vectorFor('fixture/a', 'noisy [noise]')),
        'the reply that was for this request, not one of the decoys');
      const pid = host.state().pid;
      const again = await ask(host, 'quiet');
      assert.deepEqual(again.vector, Array.from(vectorFor('fixture/a', 'quiet')));
      assert.equal(host.state().pid, pid, 'noise is not a reason to replace the process');
      assert.equal(real.children.length, 1);
    });
  });
});

describe('the model a vector is stamped with', () => {
  it('is the one its child echoed, through real model changes, and is reproducible', async () => {
    await withHost({}, async ({ host }) => {
      const out = [];
      for (const model of ['fixture/a', 'fixture/b', 'fixture/a', 'fixture/b']) {
        out.push(await ask(host, 'same text', model));
      }
      assert.deepEqual(out.map(r => r.modelId), ['fixture/a', 'fixture/b', 'fixture/a', 'fixture/b']);
      assert.deepEqual(out[0].vector, out[2].vector, 'the same text and model give the bit-identical vector before and after a change');
      assert.deepEqual(out[1].vector, out[3].vector);
      assert.notDeepEqual(out[0].vector, out[1].vector, 'and two models do not give each other\'s vector');
      assert.deepEqual(out[0].vector, Array.from(vectorFor('fixture/a', 'same text')));
      assert.deepEqual(out[1].vector, Array.from(vectorFor('fixture/b', 'same text')));
    });
  });
});

describe('a model that cannot be loaded', () => {
  it('costs one process however many embeds ask, and keeps its own error text', async () => {
    await withHost({}, async ({ host, real }) => {
      const errs = [];
      for (let i = 0; i < 3; i++) errs.push(await ask(host, `t${i}`, 'fixture/unloadable').then(() => null, e => e));
      assert.ok(errs.every(e => e && e.kind === 'load' && !isLostChildError(e)));
      assert.ok(errs.every(e => /cannot be loaded \(fixture\)/.test(e.message)), errs.map(e => e.message).join(' | '));
      assert.equal(real.children.length, 1, 'a model that cannot load is not retried in a loop');
      const ok = await ask(host, 'fine', 'fixture/a');
      assert.equal(ok.modelId, 'fixture/a', 'and it does not stop a model that can');
    });
  });
});

describe('stopping a real child', () => {
  it('ends the process', async () => {
    const real = tap(forkChild);
    const host = createLocalInference({ pipelineModule: FIXTURE_PIPELINE, spawn: real.spawn, log: () => {} });
    await ask(host, 'one');
    const child = real.children[0];
    await host.stop({ budgetMs: 2_000 });
    await exited(child);
    assert.equal(alive(child.pid), false);
  });

  it('kills a child that is stuck when the budget runs out', async () => {
    const real = tap(forkChild);
    const host = createLocalInference({ pipelineModule: FIXTURE_PIPELINE, spawn: real.spawn, log: () => {} });
    const stuck = ask(host, 'wedged [hang]').then(() => null, e => e);
    await real.waitFor(m => m.fixture === 'started' && /wedged/.test(m.input), 'the fixture to be mid-inference');
    await host.stop({ budgetMs: 300 });
    const { signal } = await exited(real.children[0]);
    assert.equal(signal, 'SIGKILL');
    assert.ok(await stuck, 'the cut-off request was rejected');
  });
});

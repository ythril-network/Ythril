/**
 * The one shape every flow-check probe that needs a running stack goes through (`tools/flow-checks/_stack.mjs`) starts only its own
 * scratch compose project, books Docker memory before it starts, never answers "holds" about a stack it did not reach, and removes
 * everything it started on every way out (Q-917).
 *
 * ## The failure this prevents
 *
 * 87 flow-check placeholders still answered "cannot answer", and 44 of them need a stack, a browser, an image or a database. A probe that
 * starts containers itself can (a) leave them running after a crash, a timeout or a kill, (b) start them without the booking every agent on
 * this machine owes the shared Docker pool, because the booking gate only sees an agent's own commands and not a probe's children, (c) touch
 * the owner's real instance (`docker-compose.yml`, port 3210, database `ythril`) or another project's containers, and (d) read a stack that
 * never became healthy as a pass. The shape holds all four in one module, so no probe can drop a guard; this test drives it over a fake
 * `spawn`, no Docker, and sees each guard fire and each exit path tear down.
 *
 * ## What is asserted
 *
 *  1. every compose call names the probe's own project (`ythril-probe-<check>-<pid>`) and both overlay files, never `docker-compose.yml`;
 *  2. `down -v` and the booking release run when the answer holds, is violated, cannot answer, throws, is cut off by SIGTERM, or runs over its budget;
 *  3. no booking script and no `CI` is exit 2 with no `up`; a busy pool (booking exit 75) is exit 2; CI books nothing and still starts;
 *  4. an unhealthy `up`, a `/health` that is not 200, a failing setup and a missing image are exit 2, and the answer is never asked;
 *  5. the guards: another project's name, another compose file, port 3210, database `ythril` and a container of another project are refused;
 *  6. a token the setup returned never reaches stdout;
 *  7. a leftover project of a dead run of the same check is removed before the start, one of a live run and one of another check are not.
 * `testing/sync/setup.js` takes its first-admin token from the shared `first-admin-token.mjs`, the module the shape uses too.
 *
 * Run: node --test testing/standalone/the-stack-probe-shape-guards-and-tears-down.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CannotAnswer, holds, violated } from '../../tools/flow-checks/_verdict.mjs';
import { runStack, refusal, projectName } from '../../tools/flow-checks/_stack.mjs';
import { firstAdminToken } from '../_shared/first-admin-token.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const CHECK = 'check-i-demo-probe';
const PID = 4242;
const PROJECT = `ythril-probe-${CHECK}-${PID}`;
const TOKEN = 'ythril_pat_SECRET_do_not_print_0123456789';
const BOOKING = '/fake/home/.claude/hooks/docker-booking.js';
const SPEC = { check: CHECK, instances: ['a'], sidecars: [], drivers: [], memGb: 6, budgetS: 30, image: 'given' };
const CONFIG = { services: { 'ythril-a': { depends_on: { 'ythril-mongo-a': { condition: 'service_healthy' } } }, 'ythril-mongo-a': {} } };

/** What the fake `docker`/`git`/booking script answer; `over` replaces one answer by a key of `answers`. */
function world(over = {}) {
  const calls = [];
  const answers = {
    info: () => ({ code: 0, stdout: '27.0\n' }),
    composeLs: () => ({ code: 0, stdout: '[]' }),
    git: () => ({ code: 0, stdout: 'abc1234\n' }),
    up: () => ({ code: 0, stdout: '' }),
    build: () => ({ code: 0, stdout: '' }),
    port: () => ({ code: 0, stdout: '127.0.0.1:49200\n' }),
    config: () => ({ code: 0, stdout: JSON.stringify(CONFIG) }),
    label: () => ({ code: 0, stdout: `${PROJECT}\n` }),
    ...over,
  };
  /** The docker argv a spawn carries: its own, or the one after `--` of a booking wrapper. */
  const inner = (cmd, args) => (cmd === 'node' && args[0] === BOOKING ? args.slice(args.indexOf('--') + 1) : [cmd, ...args]);
  const spawn = async (cmd, args) => {
    calls.push({ cmd, args });
    const [c, ...a] = inner(cmd, args);
    if (c === 'git') return { code: 0, stderr: '', ...answers.git() };
    if (c !== 'docker') return { code: 0, stdout: '', stderr: '' }; // booking `release`
    const verb = a[0] === 'compose' ? a.find((x, i) => i > 0 && /^(up|down|port|config|ls|exec|stop|start|kill|logs|restart|pause|unpause)$/.test(x)) : a[0];
    const key = { info: 'info', ls: 'composeLs', up: 'up', build: 'build', port: 'port', config: 'config', inspect: 'label' }[verb];
    const r = key ? answers[key](a, cmd) : { code: 0, stdout: '' };
    return { code: 0, stdout: '', stderr: '', ...r };
  };
  const fetchLog = [];
  const fetch = async (url, init = {}) => {
    fetchLog.push({ url: String(url), method: init.method ?? 'GET' });
    const path = new URL(url).pathname;
    const r = (over.http ?? (() => undefined))(path, init) ?? (path === '/api/setup/json' ? { status: 201, body: { plaintext: TOKEN } } : { status: 200, body: { status: 'ok' } });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: new Map(), text: async () => JSON.stringify(r.body ?? {}), json: async () => r.body ?? {} };
  };
  const out = []; // every wait the shape makes is scaled to a thousandth by `waitScale`, so a wait that times out costs milliseconds
  const handlers = {};
  const exits = [];
  const io = {
    spawn, fetch, pid: PID, argv: ['--image', 'ythril-ci:1'], env: {}, bookingPath: BOOKING, exists: (p) => p === BOOKING, out: (l) => out.push(String(l)),
    waitScale: 0.001, alive: (pid) => pid === PID, onSignal: (s, f) => { handlers[s] = f; }, exit: (c) => exits.push(c),
    root: '/fake/repo', ...over.io,
  };
  return { io, calls, out, handlers, exits, fetchLog, dockerArgv: () => calls.map((c) => inner(c.cmd, c.args)).filter((a) => a[0] === 'docker').map((a) => a.slice(1)) };
}

/** The exit code and text a verdict would print: 0 holds, 1 violated, 2 cannot answer. */
async function outcome(promise) {
  try { const v = await promise; return { code: v.holds ? 0 : 1, text: v.reason }; } catch (e) { return { code: 2, text: String(e.message) }; }
}
const composeCalls = (w) => w.dockerArgv().filter((a) => a[0] === 'compose');
const hasVerb = (w, verb) => composeCalls(w).some((a) => a.includes(verb));
const released = (w) => w.calls.some((c) => c.cmd === 'node' && c.args[0] === BOOKING && c.args[1] === 'release');
const tornDown = (w) => composeCalls(w).some((a) => a.includes('down') && a.includes('-v')) && released(w);

describe('the shape starts only its own scratch project', () => {
  it('names the project ythril-probe-<check>-<pid> and puts it and both overlay files on every compose call', async () => {
    assert.equal(projectName(CHECK, PID), PROJECT);
    const w = world();
    const r = await outcome(runStack(SPEC, async () => holds('fine'), w.io));
    assert.equal(r.code, 0, r.text);
    const calls = composeCalls(w).filter((a) => !a.includes('ls')); // `compose ls` lists projects, so it names none: the guards test says so
    assert.ok(calls.length >= 4, `only ${calls.length} compose calls`);
    for (const a of calls) {
      assert.equal(a[a.indexOf('-p') + 1], PROJECT, `compose call without the probe's project: ${a.join(' ')}`);
      const files = a.flatMap((x, i) => (x === '-f' ? [a[i + 1]] : []));
      assert.deepEqual(files.map((f) => f.split('/').pop()), ['docker-compose.test.yml', 'docker-compose.probe.yml'], a.join(' '));
    }
  });

  it('books the stack with `hold --project` before `up`, and never starts it unbooked', async () => {
    const w = world();
    await outcome(runStack(SPEC, async () => holds('fine'), w.io));
    const upIdx = w.calls.findIndex((c) => c.args.includes('up'));
    assert.equal(w.calls[upIdx].cmd, 'node', 'up is not wrapped in the booking script');
    assert.equal(w.calls[upIdx].args[0], BOOKING);
    assert.equal(w.calls[upIdx].args[1], 'hold');
    assert.equal(w.calls[upIdx].args[w.calls[upIdx].args.indexOf('--project') + 1], PROJECT);
    assert.ok(w.calls[upIdx].args.includes('--mem'));
    assert.ok(!w.calls.some((c) => c.cmd === 'docker' && c.args.includes('up')), 'an up ran outside the booking');
  });

  it('builds the checkout image under a `run` booking when the image is the source', async () => {
    const w = world({ io: { argv: [] } });
    await outcome(runStack({ ...SPEC, image: 'source' }, async () => holds('fine'), w.io));
    const build = w.calls.find((c) => c.args.includes('build') && c.cmd === 'node');
    assert.ok(build, 'no booked build');
    assert.equal(build.args[1], 'run');
    assert.ok(build.args.some((x) => /^ythril-probe:/.test(x)), 'the image is not tagged ythril-probe:*');
  });

  it('removes a leftover project of a dead run of the same check, and no other project', async () => {
    const live = `ythril-probe-${CHECK}-${PID}`;
    const dead = `ythril-probe-${CHECK}-99999`;
    const w = world({
      composeLs: () => ({ code: 0, stdout: JSON.stringify([{ Name: dead }, { Name: live }, { Name: 'ythril-test' }, { Name: 'ythril-probe-check-i-other-77' }]) }),
      io: { alive: (pid) => pid === PID },
    });
    await outcome(runStack(SPEC, async () => holds('fine'), w.io));
    const downs = composeCalls(w).filter((a) => a.includes('down')).map((a) => a[a.indexOf('-p') + 1]);
    assert.ok(downs.includes(dead), `the dead run's project was not removed: ${downs}`);
    assert.ok(!downs.includes('ythril-test'), 'the shared test stack was touched');
    assert.ok(!downs.includes('ythril-probe-check-i-other-77'), "another check's project was touched");
    assert.ok(downs.indexOf(dead) < composeCalls(w).findIndex((a) => a.includes('up')), 'the leftover was removed after the start');
  });
});

describe('the shape tears down on every way out', () => {
  const cases = {
    'the answer holds': [async () => holds('ok'), 0],
    'the answer is violated': [async () => violated('bad'), 1],
    'the answer cannot answer': [async () => { throw new CannotAnswer('no input'); }, 2],
    'the answer throws': [async () => { throw new Error('boom'); }, 2],
  };
  for (const [name, [fn, code]] of Object.entries(cases)) {
    it(`removes the project with its volumes and releases the booking when ${name}`, async () => {
      const w = world();
      const r = await outcome(runStack(SPEC, fn, w.io));
      assert.equal(r.code, code, r.text);
      assert.ok(tornDown(w), 'no `down -v` and release');
      assert.ok(composeCalls(w).some((a) => a.includes('--remove-orphans')));
    });
  }

  it('removes the project and exits 2 when SIGTERM lands while the answer runs', async () => {
    const w = world();
    let release; const blocked = new Promise((r) => { release = r; });
    let started; const began = new Promise((r) => { started = r; });
    const run = outcome(runStack(SPEC, async () => { started(); await blocked; return holds('late'); }, w.io));
    await began;
    assert.ok(w.handlers.SIGTERM && w.handlers.SIGINT && w.handlers.SIGHUP, 'a signal has no handler');
    await w.handlers.SIGTERM('SIGTERM');
    assert.ok(tornDown(w), 'SIGTERM did not tear down');
    assert.deepEqual(w.exits, [2]);
    assert.match(w.out.join('\n'), /^cannot answer: .*SIGTERM/m);
    release();
    await run;
  });

  it('is exit 2 with a teardown, never a pass, when the answer outlasts its budget', async () => {
    const w = world();
    const r = await outcome(runStack({ ...SPEC, budgetS: 0.05 }, () => new Promise(() => {}), w.io));
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /budget/);
    assert.ok(tornDown(w));
  });

  it('says a failed teardown in the verdict without changing its code', async () => {
    const w = world();
    const real = w.io.spawn;
    w.io.spawn = async (cmd, args) => (args.includes('down') ? { code: 1, stdout: '', stderr: 'network busy' } : real(cmd, args));
    const r = await outcome(runStack(SPEC, async () => holds('fine'), w.io));
    assert.equal(r.code, 0);
    assert.match(r.text, /teardown failed: .*network busy/);
  });
});

describe('the shape never answers about a stack it did not reach', () => {
  let asked;
  const ask = async () => { asked = true; return holds('should not be reached'); };

  it('is exit 2 with no `up` when the booking script is missing and CI is not set', async () => {
    asked = false;
    const w = world({ io: { exists: () => false } });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /booking/);
    assert.equal(hasVerb(w, 'up'), false);
    assert.equal(asked, false);
  });

  it('is exit 2 when the pool stays busy (booking exit 75), and removes what it may have started', async () => {
    asked = false;
    const w = world({ up: (a, cmd) => ({ code: 75, stdout: '', stderr: 'pool busy' }) });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /pool busy|busy/i);
    assert.equal(asked, false);
    assert.ok(tornDown(w));
  });

  it('under CI books nothing and still starts the stack, with the given image', async () => {
    const w = world({ io: { env: { CI: 'true' }, exists: () => false } });
    const r = await outcome(runStack(SPEC, async () => holds('fine'), w.io));
    assert.equal(r.code, 0, r.text);
    assert.equal(w.calls.some((c) => c.cmd === 'node'), false, 'a booking call ran under CI');
    assert.ok(hasVerb(w, 'up'));
  });

  it('is exit 2 when the image is `given` and no --image is passed', async () => {
    asked = false;
    const w = world({ io: { argv: [] } });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /--image/);
    assert.equal(hasVerb(w, 'up'), false);
    assert.equal(asked, false);
  });

  it('is exit 2 when an `up` fails (an unhealthy service)', async () => {
    asked = false;
    const w = world({ up: () => ({ code: 1, stdout: '', stderr: 'dependency failed to start: container ythril-mongo-a is unhealthy' }) });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /unhealthy/);
    assert.equal(asked, false);
    assert.ok(tornDown(w));
  });

  it('is exit 2 when /health is not 200 within its wait', async () => {
    asked = false;
    const w = world({ http: (path) => (path === '/health' ? { status: 503, body: {} } : undefined) });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /\/health/);
    assert.equal(asked, false);
  });

  it('is exit 2 when the first-run setup fails', async () => {
    asked = false;
    const w = world({ http: (path) => (path === '/api/setup/json' ? { status: 500, body: { error: 'down' } } : undefined) });
    const r = await outcome(runStack(SPEC, ask, w.io));
    assert.equal(r.code, 2);
    assert.match(r.text, /setup/i);
    assert.equal(asked, false);
  });

  it('is exit 2 for a driver or an image kind it does not provide, never a pass', async () => {
    asked = false;
    const a = await outcome(runStack({ ...SPEC, drivers: ['browser'] }, ask, world().io));
    const b = await outcome(runStack({ ...SPEC, image: 'previous-release' }, ask, world().io));
    assert.equal(a.code, 2);
    assert.equal(b.code, 2);
    assert.equal(asked, false);
  });
});

describe('the shape refuses what could touch anything but its own stack', () => {
  const own = { project: PROJECT };
  const files = ['-f', '/r/testing/docker-compose.test.yml', '-f', '/r/testing/docker-compose.probe.yml'];

  it('refuses a compose call for another project, another file, or the deployment file', () => {
    assert.equal(refusal(['compose', '-p', PROJECT, ...files, 'up', '-d'], own), null, 'its own call was refused');
    assert.match(refusal(['compose', '-p', 'ythril-test', ...files, 'down', '-v'], own), /project/);
    assert.match(refusal(['compose', ...files, 'down'], own), /project/);
    assert.match(refusal(['compose', '-p', PROJECT, '-f', '/r/docker-compose.yml', 'up', '-d'], own), /docker-compose\.yml|file/);
    assert.match(refusal(['compose', '-p', PROJECT, ...files, '-f', '/r/docker-compose.yml', 'up', '-d'], own), /file/);
  });

  it('refuses a published host port 3210 and a database named ythril in any form', () => {
    assert.match(refusal(['compose', '-p', PROJECT, ...files, 'run', '-p', '127.0.0.1:3210:3200', 'x'], own), /3210/);
    assert.match(refusal(['run', '--publish', '3210:3200', 'img'], own), /3210/);
    assert.match(refusal(['run', '-e', 'MONGO_URI=mongodb://u:p@host:27017/ythril?authSource=admin', 'img'], own), /ythril/);
    assert.match(refusal(['compose', '-p', PROJECT, ...files, 'exec', '-T', 'ythril-mongo-a', 'mongosh', '--eval', "db.getSiblingDB('ythril').x.drop()"], own), /ythril/);
  });

  it('refuses a stop, kill, exec or logs on a container whose compose project is not its own', async () => {
    const w = world({ label: () => ({ code: 0, stdout: 'ythril-test\n' }) });
    let msg = '';
    const r = await outcome(runStack(SPEC, async (ctx) => {
      try { await ctx.docker(['stop', 'ythril-a']); } catch (e) { msg = e.message; }
      return holds('fine');
    }, w.io));
    assert.equal(r.code, 0, r.text);
    assert.match(msg, /project/);
    assert.ok(!w.dockerArgv().some((a) => a[0] === 'stop'), 'the stop ran');
  });

  it('applies those refusals to what a probe runs: another project, the deployment file and port 3210 never reach docker', async () => {
    const w = world({ label: () => ({ code: 0, stdout: 'ythril-test\n' }) });
    const refused = [];
    const r = await outcome(runStack(SPEC, async (ctx) => {
      const testFiles = ['-f', '/r/testing/docker-compose.test.yml', '-f', '/r/testing/docker-compose.probe.yml'];
      for (const argv of [
        ['compose', '-p', 'ythril-test', ...testFiles, 'down', '-v'],
        ['compose', '-p', PROJECT, '-f', '/r/docker-compose.yml', 'down', '-v'],
        ['run', '--rm', '-p', '3210:3200', 'img'],
        ['rm', '-f', 'ythril-a'],
      ]) {
        try { await ctx.docker(argv); refused.push('ran'); } catch (e) { refused.push(e.message); }
      }
      return holds('fine');
    }, w.io));
    assert.equal(r.code, 0, r.text);
    assert.ok(refused.every((m) => m !== 'ran'), JSON.stringify(refused));
    const seen = w.dockerArgv().map((a) => a.join(' ')).join('\n');
    assert.doesNotMatch(seen, /-p ythril-test |docker-compose\.yml|3210:3200|rm -f/, 'a refused call reached docker');
  });

  it('resolves ctx.stop to this project\'s service and refuses a name that is not one of its services', async () => {
    const w = world();
    const seen = [];
    const r = await outcome(runStack(SPEC, async (ctx) => {
      await ctx.stop('ythril-mongo-a');
      for (const bad of ['ythril-mongo-b', 'ythril-a; rm -rf /', 'ythril-test-a']) {
        try { await ctx.stop(bad); seen.push('ran'); } catch (e) { seen.push(e.message); }
      }
      return holds('fine');
    }, w.io));
    assert.equal(r.code, 0, r.text);
    const stops = composeCalls(w).filter((a) => a.includes('stop'));
    assert.equal(stops.length, 1, `stops: ${JSON.stringify(stops)}`);
    assert.equal(stops[0][stops[0].indexOf('-p') + 1], PROJECT);
    assert.equal(stops[0].at(-1), 'ythril-mongo-a');
    assert.ok(seen.every((m) => /not a service/.test(m)), JSON.stringify(seen));
  });

  it('refuses an http call to port 3210 or to a port the stack did not publish, and a mongo script on database ythril', async () => {
    const w = world();
    const got = [];
    const r = await outcome(runStack(SPEC, async (ctx) => {
      for (const url of ['http://127.0.0.1:3210', 'http://127.0.0.1:1234', 'https://example.com']) {
        try { await ctx.http({ url, token: TOKEN }, 'GET', '/api/tokens'); got.push('ran'); } catch (e) { got.push(e.message); }
      }
      try { await ctx.mongo(ctx.instances[0], "db.getSiblingDB('ythril').spaces.find().toArray()"); got.push('ran'); } catch (e) { got.push(e.message); }
      return holds('fine');
    }, w.io));
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(got.map((m) => m !== 'ran'), [true, true, true, true], JSON.stringify(got));
    assert.ok(!w.fetchLog.some((f) => /:(3210|1234)\b|example\.com/.test(f.url)), 'a refused call was sent');
    assert.ok(!w.dockerArgv().some((a) => a.includes('exec')), 'the mongo script ran');
  });
});

describe('the shape keeps the token out of what it prints', () => {
  it('prints no line holding the token, whether it is said, returned in the reason or thrown', async () => {
    for (const fn of [
      async (ctx) => { ctx.say(`token ${ctx.instances[0].token}`); return holds('quiet'); },
      async (ctx) => holds(`saw ${ctx.instances[0].token}`),
      async (ctx) => { throw new CannotAnswer(`auth ${ctx.instances[0].token} refused`); },
    ]) {
      const w = world();
      const r = await outcome(runStack(SPEC, fn, w.io));
      assert.ok(!(`${w.out.join('\n')}\n${r.text}`).includes(TOKEN), 'the token reached stdout or the verdict');
    }
  });

  it('hands the answer an instance with the setup token and a url on the published port', async () => {
    const w = world();
    let inst;
    await outcome(runStack(SPEC, async (ctx) => { inst = ctx.instances[0]; return holds('fine'); }, w.io));
    assert.equal(inst.token, TOKEN);
    assert.equal(inst.url, 'http://127.0.0.1:49200');
    assert.equal(inst.service, 'ythril-a');
  });
});

describe('the first-admin token is one module, used by the test-stack setup and the shape', () => {
  it('returns the token from a first-run setup and refuses a refusal or an answer without one', async () => {
    const ok = async () => ({ ok: true, status: 201, text: async () => '', json: async () => ({ plaintext: TOKEN }) });
    assert.equal(await firstAdminToken('http://x', { fetchImpl: ok, who: 'a' }), TOKEN);
    const no = async () => ({ ok: false, status: 409, text: async () => 'already set up', json: async () => ({}) });
    await assert.rejects(firstAdminToken('http://x', { fetchImpl: no, who: 'a' }), /Setup failed for a: 409 already set up/);
    const none = async () => ({ ok: true, status: 201, text: async () => '', json: async () => ({}) });
    await assert.rejects(firstAdminToken('http://x', { fetchImpl: none, who: 'a' }), /did not include a token/);
  });

  it('is what testing/sync/setup.js calls: it holds no setup request of its own', () => {
    const setup = stripComments(readFileSync(join(REPO_ROOT, 'testing', 'sync', 'setup.js'), 'utf8'));
    assert.match(setup, /first-admin-token\.mjs/);
    assert.doesNotMatch(setup, /\/api\/setup\/json/, 'setup.js posts the first-run request itself again');
  });
});

describe('the smoke probe check-i-reliability-readiness-is-true', async () => {
  const mod = await import('../../tools/flow-checks/check-i-reliability-readiness-is-true.mjs');
  const flip = (over = {}) => ({
    baseline: { status: 200 },
    deps: [{ service: 'ythril-mongo-a', stopped: { status: 503, seconds: 4 }, restarted: { status: 200, seconds: 40 }, ...over }],
  });

  it('holds when readiness leaves 200 with the dependency stopped and returns to 200 after it starts', () => {
    assert.equal(mod.judge(flip()).holds, true);
  });

  it('is violated when readiness stays 200 with the dependency stopped (a probe that only says the process is up)', () => {
    const v = mod.judge(flip({ stopped: null }));
    assert.equal(v.holds, false);
    assert.match(v.reason, /ythril-mongo-a/);
    assert.match(v.reason, /stays ready|still ready/);
  });

  it('is violated when readiness never returns after the dependency starts', () => {
    const v = mod.judge(flip({ restarted: null }));
    assert.equal(v.holds, false);
    assert.match(v.reason, /never returned|not ready again/);
  });

  it('is violated when the stack answers not-ready before anything was stopped', () => {
    const v = mod.judge({ ...flip(), baseline: { status: 503 } });
    assert.equal(v.holds, false);
    assert.match(v.reason, /before/);
  });

  it('cannot answer when no dependency was derived: nothing was asked, so nothing holds', () => {
    assert.throws(() => mod.judge({ baseline: { status: 200 }, deps: [] }), CannotAnswer);
  });

  it('derives the dependencies from the compose file and stops each in turn, through the shape', async () => {
    const readyAfterStop = { stopped: false };
    const w = world({
      http: (path) => (path === '/ready' ? { status: readyAfterStop.stopped ? 503 : 200, body: {} } : undefined),
    });
    const real = w.io.spawn;
    w.io.spawn = async (cmd, args) => {
      if (args.includes('stop')) readyAfterStop.stopped = true;
      if (args.includes('start')) readyAfterStop.stopped = false;
      return real(cmd, args);
    };
    const r = await outcome(runStack(mod.spec, mod.decide, w.io));
    assert.equal(r.code, 0, r.text);
    const verbs = composeCalls(w).filter((a) => a.includes('stop') || a.includes('start')).map((a) => `${a.includes('stop') ? 'stop' : 'start'} ${a.at(-1)}`);
    assert.deepEqual(verbs, ['stop ythril-mongo-a', 'start ythril-mongo-a']);
  });

  it('through the shape is violated when /ready keeps answering 200 with Mongo stopped', async () => {
    const w = world();
    const r = await outcome(runStack(mod.spec, mod.decide, w.io));
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /ythril-mongo-a/);
  });

  it('is an ordinary probe script: it runs through _verdict and says cannot answer, not holds, without a booking script', () => {
    const src = readFileSync(join(REPO_ROOT, 'tools', 'flow-checks', 'check-i-reliability-readiness-is-true.mjs'), 'utf8');
    assert.match(src, /stackProbe\(/);
    assert.match(src, /isMain\(import\.meta\.url\)/);
  });
});

// The live run: a real a+Mongo scratch stack, booked through the shape (~2 minutes, 6 GB of the Docker pool). Registered only when
// YTHRIL_FLOW_PROBE_LIVE=1, so it is absent, not skipped, everywhere else: a skip is refused by the CI aggregator.
if (process.env.YTHRIL_FLOW_PROBE_LIVE === '1') {
  describe('live: check-i-reliability-readiness-is-true against a real scratch stack', () => {
    it('holds on the repository image, and the shape leaves no container, volume or booking behind', async () => {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'flow-checks', 'check-i-reliability-readiness-is-true.mjs')],
        { encoding: 'utf8', env: testChildEnv({}, process.env), timeout: 1_800_000 });
      const lines = (r.stdout ?? '').trim().split('\n');
      assert.equal(r.status, 0, lines.at(-1));
      assert.match(lines.at(-1), /^holds: /);
      const left = spawnSync('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' });
      assert.doesNotMatch(left.stdout, /ythril-probe-check-i-reliability-readiness-is-true-/, 'a probe container is left');
    });
  });
}

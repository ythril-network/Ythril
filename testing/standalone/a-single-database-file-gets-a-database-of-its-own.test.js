/**
 * A session that runs ONE database test file gets a harness database of its own, and removes exactly that one.
 *
 * ## The failure this guards
 *
 * A single `-db` file ran against the test stack's `ythril-mongo-a` on port 27117. The session that did so held the stack's
 * database: nobody else could start the stack, or take it down, while that session's files ran, and two sessions on that one
 * database dropped each other's data. `testing/_init/db-shard-stack.mjs` already starts one fresh Mongo per shard of a sharded
 * run; it now answers one more question, *give me ONE harness database of my own, tell me its name and where it listens, and
 * take exactly it away* (`own-up`, `own-list`, `own-down`).
 *
 * ## What is held, and how
 *
 * The real exported functions run against a fake `docker`: no case starts a container, reads or writes the temp directory,
 * or touches Docker, so two preflights at once cannot disturb each other. What the fake cannot say (that Docker picks and
 * reports the port, that `down` works with the placeholder port, that the label filter finds the containers) is held by
 * `an-own-database-starts-and-goes-docker.test.js`.
 *
 *  - **Names.** The start makes the project name itself, from the caller's label and eight random hex characters, so two
 *    starts never share a project whatever label they pass; no name is a shard's or the stack's.
 *  - **The forgettable parts.** Every compose call sets the port variable and names the project the start made; every Docker
 *    call has a time limit and is stopped past it; a listing that fails or cannot be read is a refusal, never "nothing there";
 *    a failed or interrupted start prints why the container stopped and removes only the project it made, and says so when
 *    that removal fails too.
 *  - **The command line.** `cli` is exported with its output and signals as parameters, so its lines and its ends are tested;
 *    `up` and `down` keep their argument handling.
 *
 * Run: node --test testing/standalone/a-single-database-file-gets-a-database-of-its-own.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import * as stack from '../_init/db-shard-stack.mjs';
import { DEFAULT_PROJECTS } from '../_init/stack-down.mjs';
import { TEST_STACK_PROJECT } from '../_init/container-state.mjs';
import { DB_SHARDS_MAX, dbShardPort } from '../_shared/db-shard-plan.mjs';

const SERVICE = 'ythril-mongo-a';
const PORT_VARIABLE = 'YTHRIL_TEST_DB_SHARD_PORT';
const OWN_PREFIX = 'ythril-db-own-';
const HEX = '0123abcd';
/** The limit a case gives a call it means to see stopped: short, so the case is quick. */
const SHORT_LIMIT_MS = 30;
const SHORT_LIMITS = { list: SHORT_LIMIT_MS, up: SHORT_LIMIT_MS, port: SHORT_LIMIT_MS, down: SHORT_LIMIT_MS, ask: SHORT_LIMIT_MS };
/** The limit a case gives a call it stops by hand: long enough never to fire first, short enough that a failing case does not hold the process for minutes. */
const LONG_SAFETY_LIMIT_MS = 5_000;

/** Wait, a turn of the event loop at a time, until `condition` holds; throws when it never does, so a case fails instead of hanging. */
async function until(condition) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise(r => setImmediate(r));
  assert.ok(condition(), 'the condition the case waits for never held');
}

/** One line of `docker ps -a --format '{{json .}}'`, as Docker prints it for a compose container. */
function psLine({ project, state = 'running', status = 'Up 3 minutes (healthy)', port = 32774, service = SERVICE, id = project }) {
  return JSON.stringify({
    ID: `id-${id}`,
    Names: `${project}-${service}-1`,
    State: state,
    Status: status,
    Ports: port === null ? '' : `127.0.0.1:${port}->27017/tcp`,
    Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service}`,
  });
}
const ownProject = (name) => `${OWN_PREFIX}${name}`;
const ownName = (i) => `q${i}-${String(i).padStart(8, '0')}`;
const listingOf = (names) => names.map(n => psLine({ project: ownProject(n) })).join('\n');

/**
 * A fake `docker`. Records every call as `{ argv, env, verb, project, aborted }` and answers by what the call is:
 * the listing (`ps -a ... --format`), a state ask (`ps -aq`, `inspect`), and compose's `port`, `up` and `down`.
 * `answers` overrides an answer: a string is the output, an Error is thrown, `'hang'` never answers, a function is
 * called with the call and returns either.
 */
function fakeDocker(answers = {}) {
  const calls = [];
  /** The verb of every call, in order, with the markers a case's own answers push (`events.push('up settled')`). */
  const events = [];
  const verbOf = (argv) => {
    if (argv[0] === 'network') return { compose: false, verb: 'network', project: undefined };
    if (argv[0] !== 'compose') return { compose: false, verb: argv.includes('--format') ? 'list' : argv[0] === 'ps' ? 'ask-ps' : argv[0], project: undefined };
    let project;
    let i = 1;
    while (i < argv.length && (argv[i] === '-p' || argv[i] === '-f')) {
      if (argv[i] === '-p') project = argv[i + 1];
      i += 2;
    }
    return { compose: true, verb: argv[i], project };
  };
  const defaults = {
    list: '',
    network: '',
    'ask-ps': 'container-id\n',
    inspect: 'name false 0 \n',
    port: '127.0.0.1:32774\n',
    up: '',
    down: '',
  };
  const run = async (argv, options = {}) => {
    const { compose, verb, project } = verbOf(argv);
    const call = { argv, env: options.env, verb, project, compose, signal: options.signal, aborted: () => options.signal?.aborted === true };
    calls.push(call);
    events.push(verb);
    let answer = answers[verb] ?? defaults[verb] ?? '';
    if (typeof answer === 'function') answer = answer(call);
    if (answer === 'hang') return new Promise(() => {});
    if (answer instanceof Error) throw answer;
    if (answer && typeof answer.then === 'function') return answer;
    return answer;
  };
  const composeCalls = () => calls.filter(c => c.compose);
  const of = (verb) => calls.filter(c => c.verb === verb);
  return { run, calls, events, composeCalls, of };
}

/**
 * An `up` that settles only after it is stopped (as a real compose does when its child is killed), a little later, and
 * that a case can also release by hand: `pending.release()` rejects every `up` still waiting, so a failing assertion never
 * leaves a call that holds the file's process.
 */
function stoppableUp(docker) {
  const waiting = [];
  const answer = (call) => new Promise((_, reject) => {
    waiting.push(reject);
    call.signal.addEventListener('abort', () => setTimeout(() => { docker.events.push('up settled'); reject(new Error('compose up was killed')); }, 20), { once: true });
  });
  return { answer, release: () => { for (const reject of waiting.splice(0)) reject(new Error('released by the case')); } };
}

/** `{ onSignal, handlers, disposed }`: the signal hook a test hands the start, recording what it registers. */
function fakeSignals() {
  const handlers = [];
  let disposed = 0;
  return { handlers, get disposed() { return disposed; }, onSignal: (handler) => { handlers.push(handler); return () => { disposed++; }; } };
}

/** Lines a function printed, one array each for the output and the errors. */
function lines() {
  const out = [];
  const err = [];
  return { out, err, print: (l) => out.push(String(l)), printError: (l) => err.push(String(l)) };
}

/** `startOwnDb` against the fake, with a fake signal hook (the real one would register handlers on this process) and a fixed random part. */
const start = (docker, label = 'q', extra = {}) => {
  const l = lines();
  return stack.startOwnDb({ label }, { run: docker.run, printError: l.printError, onSignal: fakeSignals().onSignal, random: () => HEX, ...extra });
};

/** Every compose call carries the port variable (0 for an own database) and names exactly `project`. */
function assertEveryComposeCall(docker, project, port = '0') {
  const composeCalls = docker.composeCalls();
  assert.ok(composeCalls.length > 0, 'no compose call was made, so nothing was checked');
  for (const c of composeCalls) {
    assert.equal(c.project, project, `a compose call (${c.verb}) names project ${c.project}, not ${project}`);
    assert.equal(c.env?.[PORT_VARIABLE], port, `a compose call (${c.verb}) does not carry ${PORT_VARIABLE}=${port}: \`down\` fails without it`);
  }
}

describe('an own database\'s name', () => {
  it('a label of 1 and of 40 characters is accepted, and the name is the label and the eight characters', () => {
    assert.equal(stack.ownDbName('a', HEX), `a-${HEX}`);
    const forty = `a${'b-'.repeat(19)}c`;
    assert.equal(forty.length, 40);
    assert.equal(stack.ownDbName(forty, HEX), `${forty}-${HEX}`);
    assert.equal(stack.ownDbName('0', HEX), `0-${HEX}`);
    assert.equal(stack.ownDbName('q-932-run', HEX), `q-932-run-${HEX}`);
  });

  const refused = [
    ['empty', ''],
    ['41 characters', 'a'.repeat(41)],
    ['a hyphen at the start', '-a'],
    ['a hyphen at the end', 'a-'],
    ['upper case', 'Abc'],
    ['a space', 'a b'],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['an underscore', 'a_b'],
    ['a non-ASCII letter', 'café'],
    ['not a string', undefined],
  ];
  for (const [what, label] of refused) {
    it(`a label that is ${what} is refused`, () => {
      assert.throws(() => stack.ownDbName(label, HEX), /label/);
    });
  }

  it('a random part that is not eight hex characters is refused', () => {
    for (const bad of ['', 'abc', '0123abcde', '0123ABCD', '0123abcg']) {
      assert.throws(() => stack.ownDbName('q', bad), /random|hex/i, `random part ${JSON.stringify(bad)} was accepted`);
    }
  });

  it('two starts of one label make two different names and projects', () => {
    const names = Array.from({ length: 50 }, () => stack.ownDbName('same'));
    assert.equal(new Set(names).size, names.length, 'two names of one label are equal');
    assert.equal(new Set(names.map(stack.dbOwnProject)).size, names.length);
    for (const n of names) assert.match(n, /^same-[0-9a-f]{8}$/);
  });

  it('two starts of one label through the start itself make two projects', async () => {
    const docker = fakeDocker();
    const a = await stack.startOwnDb({ label: 'twice' }, { run: docker.run, onSignal: fakeSignals().onSignal, printError: () => {} });
    const b = await stack.startOwnDb({ label: 'twice' }, { run: docker.run, onSignal: fakeSignals().onSignal, printError: () => {} });
    assert.notEqual(a.project, b.project);
    assert.notEqual(a.name, b.name);
  });

  it('no name gives the project of a sharded run, of the stack, or of the take-down\'s defaults', () => {
    const real = new Set([
      ...Array.from({ length: DB_SHARDS_MAX }, (_, i) => stack.dbShardProject(i)),
      ...DEFAULT_PROJECTS,
      TEST_STACK_PROJECT,
    ]);
    assert.ok(real.size >= DB_SHARDS_MAX + 2, 'the real projects were not collected');
    const labels = ['shard-0', 'shard', 'db-shard-0', 'test', 'testing', 'ythril-test', 'ythril', 'own', 'db-own', ...Array.from({ length: DB_SHARDS_MAX }, (_, i) => `shard-${i}`)];
    for (const label of labels) {
      const project = stack.dbOwnProject(stack.ownDbName(label, HEX));
      assert.ok(!real.has(project), `label ${label} gives the project ${project}, which a sharded run or the stack uses`);
      for (const r of real) assert.ok(!project.startsWith(`${r}-`) && project !== r, `${project} is inside ${r}'s names`);
      assert.ok(!project.startsWith('ythril-db-shard-'), `${project} begins like a shard's project`);
    }
  });

  it('dbOwnProject refuses what is not an own database\'s name', () => {
    for (const bad of ['', 'q', 'q-01234567-extra', 'Q-01234567', 'q-0123456', 'q-0123456g', '-q-01234567', 'ythril-test', '../q-01234567', 'a b-01234567']) {
      assert.throws(() => stack.dbOwnProject(bad), /own database|own-list/, `${JSON.stringify(bad)} was taken for an own database's name`);
    }
    assert.equal(stack.dbOwnProject(`q-${HEX}`), `${OWN_PREFIX}q-${HEX}`);
  });
});

describe('starting an own database', () => {
  it('every compose call carries the port variable and names exactly the project the start made', async () => {
    const docker = fakeDocker();
    const started = await start(docker, 'q');
    assert.equal(started.project, ownProject(`q-${HEX}`));
    assert.equal(started.name, `q-${HEX}`);
    assertEveryComposeCall(docker, started.project);
    assert.deepEqual(docker.composeCalls().map(c => c.verb), ['up', 'port']);
  });

  it('the `up` is detached, waits with the shards\' limit, builds nothing, and starts the one service', async () => {
    const own = fakeDocker();
    await start(own);
    const shards = fakeDocker();
    await stack.startDbShards(1, { run: shards.run });
    const ownUp = own.of('up')[0].argv;
    const shardUp = shards.of('up')[0].argv;
    const tail = (argv) => argv.slice(argv.indexOf('up'));
    assert.deepEqual(tail(ownUp), tail(shardUp), 'the own database\'s `up` is not the shards\' `up`');
    for (const flag of ['--detach', '--wait', '--wait-timeout', '--no-build', SERVICE]) assert.ok(tail(ownUp).includes(flag), `the own database's up lacks ${flag}`);
    assert.match(tail(ownUp)[tail(ownUp).indexOf('--wait-timeout') + 1], /^[1-9]\d*$/, 'the wait limit is not a number of seconds');
  });

  it('the port variable is 0, so Docker picks the port', async () => {
    const docker = fakeDocker();
    await start(docker);
    for (const c of docker.composeCalls()) assert.strictEqual(c.env[PORT_VARIABLE], '0');
  });

  it('with the most own databases there are, the start calls no `up`', async () => {
    const full = fakeDocker({ list: listingOf(Array.from({ length: stack.DB_OWN_MAX }, (_, i) => ownName(i))) });
    await assert.rejects(start(full), /own-list/);
    assert.deepEqual(full.composeCalls(), [], `the start called compose with ${stack.DB_OWN_MAX} databases listed`);
  });

  it('with one fewer than the most, the start goes on; the stack\'s and the shards\' containers are not counted', async () => {
    const others = [
      psLine({ project: 'ythril-test' }), psLine({ project: stack.dbShardProject(0) }), psLine({ project: stack.dbShardProject(1) }),
      psLine({ project: 'ythril-test', service: 'ythril-a' }), psLine({ project: ownProject('x-12345678'), service: 'other-service' }),
    ].join('\n');
    const docker = fakeDocker({ list: `${listingOf(Array.from({ length: stack.DB_OWN_MAX - 1 }, (_, i) => ownName(i)))}\n${others}` });
    const started = await start(docker);
    assert.equal(started.project, ownProject(`q-${HEX}`));
  });

  it('a listing that fails calls no `up`', async () => {
    const docker = fakeDocker({ list: new Error('Cannot connect to the Docker daemon') });
    await assert.rejects(start(docker), /Cannot connect to the Docker daemon/);
    assert.deepEqual(docker.composeCalls(), []);
  });

  it('a listing that prints what is not JSON lines calls no `up`', async () => {
    for (const printed of ['CONTAINER ID   IMAGE   COMMAND', 'error during connect: this error may indicate that the docker daemon is not running', '[1,2]', '{"Names":"x"}']) {
      const docker = fakeDocker({ list: printed });
      await assert.rejects(start(docker), undefined, `a listing that printed ${JSON.stringify(printed)} was read as nothing there`);
      assert.deepEqual(docker.composeCalls(), [], `compose was called after a listing that printed ${JSON.stringify(printed)}`);
    }
  });

  it('a listing that never answers is stopped at its limit and calls no `up`', async () => {
    const docker = fakeDocker({ list: 'hang' });
    await assert.rejects(start(docker, 'q', { limits: SHORT_LIMITS }), /no answer|did not|limit/i);
    assert.equal(docker.calls[0].aborted(), true, 'the hung call was not stopped');
    assert.deepEqual(docker.composeCalls(), []);
  });

  it('the port returned is the one `compose port` printed, whichever address Docker names', async () => {
    for (const printed of ['127.0.0.1:32774', '0.0.0.0:32774', '[::]:32774', '127.0.0.1:32774\n']) {
      const docker = fakeDocker({ port: printed });
      const started = await start(docker);
      assert.strictEqual(started.port, 32774, `read ${JSON.stringify(printed)} as ${started.port}`);
    }
    const other = fakeDocker({ port: '127.0.0.1:41999' });
    assert.strictEqual((await start(other)).port, 41999);
  });

  it('two lines, none, or something that is no address make the start throw and remove the project', async () => {
    for (const printed of ['127.0.0.1:32774\n[::]:32774', '', '\n', 'no port published', '127.0.0.1:0', '127.0.0.1:70000', 'x:32774']) {
      const docker = fakeDocker({ port: printed });
      await assert.rejects(start(docker), /port/i, `${JSON.stringify(printed)} was read as a port`);
      const down = docker.of('down');
      assert.equal(down.length, 1, `${JSON.stringify(printed)}: the project was not removed exactly once`);
      assert.equal(down[0].project, ownProject(`q-${HEX}`));
      assertEveryComposeCall(docker, ownProject(`q-${HEX}`));
    }
  });

  it('a failed `up` asks the container\'s state BEFORE the `down`, removes the same project, and the error carries Docker\'s output', async () => {
    const docker = fakeDocker({ up: new Error('exited 1\nError response from daemon: Ports are not available: listen tcp 127.0.0.1:27117') });
    const sig = fakeSignals();
    const l = lines();
    await assert.rejects(
      stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, printError: l.printError, random: () => HEX }),
      (e) => /Ports are not available/.test(e.message) && !/own-down/.test(e.message));
    const order = docker.calls.map(c => c.verb);
    const down = order.indexOf('down');
    const state = order.indexOf('ask-ps');
    assert.ok(state >= 0, 'the container\'s state was never asked for');
    assert.ok(down > state, `the state (call ${state}) is not asked before the down (call ${down}): ${order.join(', ')}`);
    assert.equal(docker.of('down').length, 1);
    assert.equal(docker.of('down')[0].project, ownProject(`q-${HEX}`));
    assert.ok(docker.of('ask-ps')[0].argv.join(' ').includes(`com.docker.compose.project=${ownProject(`q-${HEX}`)}`), 'the state was asked for another project');
    assertEveryComposeCall(docker, ownProject(`q-${HEX}`));
    assert.ok(l.err.some(x => /container state/.test(x)), `the state was not printed: ${l.err.join(' | ')}`);
  });

  it('when the `down` fails too, the error names both and the command that removes the project by hand', async () => {
    const docker = fakeDocker({ up: new Error('up failed: no space left on device'), down: new Error('down failed: daemon is gone') });
    await assert.rejects(start(docker), (e) => {
      assert.match(e.message, /no space left on device/);
      assert.match(e.message, /daemon is gone/);
      assert.match(e.message, new RegExp(`own-down q-${HEX}`), 'the hand command is not named');
      return true;
    });
  });

  it('a start that never ends its `up` is stopped at the limit and removes its project', async () => {
    const docker = fakeDocker({ up: 'hang' });
    await assert.rejects(start(docker, 'q', { limits: SHORT_LIMITS }), (e) => {
      assert.match(e.message, /no answer|did not|limit/i);
      assert.match(e.message, new RegExp(`own-down q-${HEX}`), 'a stopped `up` does not name the command that removes the database by hand');
      assert.match(e.message, /may still come up/, 'a stopped `up` does not say the database may still come up');
      return true;
    });
    assert.equal(docker.of('up')[0].aborted(), true, 'the hung `up` was not stopped');
    assert.equal(docker.of('down').length, 1);
    assert.equal(docker.of('down')[0].project, ownProject(`q-${HEX}`));
  });

  it('an `up` that failed by itself, with the removal done, does not claim the database may still come up', async () => {
    const docker = fakeDocker({ up: new Error('exited 1\nno such image') });
    await assert.rejects(start(docker), (e) => !/may still come up|own-down/.test(e.message));
  });

  it('an interrupt stops the `up` in flight, and the project is removed only AFTER the `up` has settled, once', async () => {
    const docker = fakeDocker({ up: (c) => up.answer(c) });
    const up = stoppableUp(docker);
    const sig = fakeSignals();
    const l = lines();
    const started = stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, printError: l.printError, random: () => HEX, limits: { ...SHORT_LIMITS, up: LONG_SAFETY_LIMIT_MS } });
    const outcome = started.then(() => 'started', (e) => e);
    try {
      await until(() => docker.of('up').length === 1);
      assert.equal(sig.handlers.length, 1, 'the start registered no interrupt handler');
      await sig.handlers[0]('SIGINT');
      assert.equal(docker.of('up')[0].aborted(), true, 'the interrupt did not stop the `up` in flight: it would go on and bring the database up after the removal');
      const upSettled = docker.events.indexOf('up settled');
      const down = docker.events.indexOf('down');
      assert.ok(upSettled >= 0 && down >= 0, `events: ${docker.events.join(', ')}`);
      assert.ok(upSettled < down, `the project was removed before the \`up\` had settled: ${docker.events.join(', ')}`);
      assert.equal(docker.of('down').length, 1, 'the interrupt did not remove the project exactly once');
      assert.equal(docker.of('down')[0].project, ownProject(`q-${HEX}`));
      const error = await outcome;
      assert.ok(error instanceof Error, 'the interrupted start resolved');
      assert.match(error.message, new RegExp(`own-down q-${HEX}`));
      assert.match(error.message, /may still come up/);
      assert.equal(docker.of('down').length, 1, 'the failed `up` removed the project a second time');
      assert.equal(sig.disposed, 1, 'the interrupt handler was left registered');
      assertEveryComposeCall(docker, ownProject(`q-${HEX}`));
    } finally {
      up.release();
      await outcome;
    }
  });

  it('on an interrupt the first line names the hand command, and the container-state report is skipped', async () => {
    const docker = fakeDocker({ up: (c) => up.answer(c) });
    const up = stoppableUp(docker);
    const sig = fakeSignals();
    const l = lines();
    const outcome = stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, printError: l.printError, random: () => HEX, limits: { ...SHORT_LIMITS, up: LONG_SAFETY_LIMIT_MS } })
      .then(() => 'started', (e) => e);
    try {
      await until(() => docker.of('up').length === 1);
      await sig.handlers[0]('SIGHUP');
      assert.match(l.err[0], new RegExp(`own-down q-${HEX}`), `the first line printed is ${JSON.stringify(l.err[0])}`);
      assert.equal(docker.of('ask-ps').length + docker.of('inspect').length, 0, 'the removal on an interrupt was held up by the state report');
      assert.equal(docker.of('down').length, 1);
    } finally {
      up.release();
      await outcome;
    }
  });

  it('an interrupt that arrives after the `up` has finished, during the port read, stops that call and removes the project', async () => {
    const docker = fakeDocker({ port: (c) => up.answer(c) });
    const up = stoppableUp(docker);
    const sig = fakeSignals();
    const outcome = stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, printError: () => {}, random: () => HEX, limits: { ...SHORT_LIMITS, port: LONG_SAFETY_LIMIT_MS } })
      .then(() => 'started', (e) => e);
    try {
      await until(() => docker.of('port').length === 1);
      await sig.handlers[0]('SIGTERM');
      assert.equal(docker.of('port')[0].aborted(), true);
      assert.equal(docker.of('down').length, 1);
      assert.ok((await outcome) instanceof Error);
    } finally {
      up.release();
      await outcome;
    }
  });

  it('a successful start leaves its interrupt handler unregistered and removes nothing', async () => {
    const docker = fakeDocker();
    const sig = fakeSignals();
    await stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, printError: () => {}, random: () => HEX });
    assert.equal(sig.handlers.length, 1);
    assert.equal(sig.disposed, 1, 'the handler of a finished start stays registered and would remove a database that is in use');
    assert.deepEqual(docker.of('down'), []);
  });
});

describe('a call that never ends', () => {
  it('is stopped at its limit and rejects', async () => {
    const docker = fakeDocker({ list: 'hang' });
    await assert.rejects(stack.listOwnDbs({ run: docker.run, limits: SHORT_LIMITS }), /no answer|did not|limit/i);
    assert.equal(docker.calls[0].aborted(), true);
  });

  it('a call given no limit is refused before it is made', async () => {
    const docker = fakeDocker();
    await assert.rejects(stack.callDocker(['ps'], { run: docker.run }), /time limit/);
    await assert.rejects(stack.callDocker(['ps'], { run: docker.run, timeoutMs: 0 }), /time limit/);
    assert.deepEqual(docker.calls, [], 'a call without a limit reached docker');
  });

  it('a call that answers in time is not stopped', async () => {
    const docker = fakeDocker({ list: '' });
    assert.deepEqual(await stack.listOwnDbs({ run: docker.run, limits: SHORT_LIMITS }), []);
    assert.equal(docker.calls[0].aborted(), false);
  });

  it('the shards\' `up` is stopped at its limit too, and the shards are removed', async () => {
    const docker = fakeDocker({ up: 'hang' });
    await assert.rejects(stack.startDbShards(2, { run: docker.run, limits: SHORT_LIMITS }), /did not start/);
    assert.ok(docker.of('up').length === 2 && docker.of('up').every(c => c.aborted()), 'a shard\'s hung `up` was not stopped');
    assert.equal(docker.of('down').filter(c => c.project === stack.dbShardProject(0)).length >= 1, true);
  });

  it('the shards\' `down` is stopped at its limit and never throws', async () => {
    const docker = fakeDocker({ down: 'hang' });
    await stack.stopDbShards([{ index: 0 }], { run: docker.run, limits: SHORT_LIMITS });
    assert.equal(docker.of('down')[0].aborted(), true);
  });
});

describe('listing the own databases', () => {
  it('gives name, state, Docker\'s status text and the published port, and only own databases', async () => {
    const docker = fakeDocker({
      list: [
        psLine({ project: ownProject('a-11111111'), state: 'running', status: 'Up 3 minutes (healthy)', port: 32774 }),
        psLine({ project: ownProject('b-22222222'), state: 'exited', status: 'Exited (137) 2 hours ago', port: null }),
        psLine({ project: 'ythril-test' }),
        psLine({ project: stack.dbShardProject(2), port: 27402 }),
      ].join('\n'),
    });
    const dbs = await stack.listOwnDbs({ run: docker.run });
    assert.deepEqual(dbs.map(d => d.name), ['a-11111111', 'b-22222222']);
    assert.deepEqual(dbs.map(d => d.project), [ownProject('a-11111111'), ownProject('b-22222222')]);
    assert.deepEqual(dbs.map(d => d.state), ['running', 'exited']);
    assert.deepEqual(dbs.map(d => d.status), ['Up 3 minutes (healthy)', 'Exited (137) 2 hours ago']);
    assert.deepEqual(dbs.map(d => d.port), [32774, null]);
  });

  it('is one `docker ps` call, and says nothing of a clock', async () => {
    const docker = fakeDocker({ list: listingOf([ownName(1)]) });
    await stack.listOwnDbs({ run: docker.run });
    assert.equal(docker.calls.length, 1);
    assert.equal(docker.calls[0].argv[0], 'ps');
    assert.ok(docker.calls[0].argv.includes('-a'), 'exited containers are not listed');
  });

  it('refuses a listing it cannot read', async () => {
    await assert.rejects(stack.listOwnDbs({ run: fakeDocker({ list: 'not json' }).run }));
    await assert.rejects(stack.listOwnDbs({ run: fakeDocker({ list: new Error('daemon down') }).run }), /daemon down/);
  });
});

describe('removing an own database', () => {
  it('asks the container\'s state before the `down`, and removes exactly that project with the placeholder port', async () => {
    const name = `q-${HEX}`;
    const docker = fakeDocker({ list: listingOf([name, ownName(2)]) });
    const l = lines();
    await stack.stopOwnDb(name, { run: docker.run, print: l.print, printError: l.printError });
    const order = docker.calls.map(c => c.verb);
    assert.ok(order.indexOf('ask-ps') >= 0 && order.indexOf('ask-ps') < order.indexOf('down'), `state not asked before the down: ${order.join(', ')}`);
    assert.equal(docker.of('down').length, 1);
    assertEveryComposeCall(docker, ownProject(name));
    assert.ok(docker.of('down')[0].argv.includes('--volumes'), 'the database\'s volumes are left');
    assert.ok(l.err.some(x => /container state/.test(x)), 'the state was not printed');
  });

  it('a name that is not an own database\'s shape throws, naming `own-list`, and calls no `down`', async () => {
    for (const bad of ['ythril-test', 'q', `${OWN_PREFIX}q-${HEX}`, 'Q-0123abcd', 'q-xyz', '../q-0123abcd', '']) {
      const docker = fakeDocker({ list: listingOf([`q-${HEX}`]) });
      await assert.rejects(stack.stopOwnDb(bad, { run: docker.run, printError: () => {} }), /own-list/, `${JSON.stringify(bad)} was not refused`);
      assert.deepEqual(docker.of('down'), [], `${JSON.stringify(bad)} reached a down`);
    }
  });

  it('a name with no container throws, naming `own-list`, and calls no `down`', async () => {
    const docker = fakeDocker({ list: listingOf([ownName(3)]) });
    await assert.rejects(stack.stopOwnDb(`q-${HEX}`, { run: docker.run, printError: () => {} }), /own-list/);
    assert.deepEqual(docker.of('down'), []);
    const none = fakeDocker({ list: '' });
    await assert.rejects(stack.stopOwnDb(`q-${HEX}`, { run: none.run, printError: () => {} }), /own-list/);
    assert.deepEqual(none.of('down'), []);
  });

  it('a listing that fails is a refusal, not "no container"', async () => {
    const docker = fakeDocker({ list: new Error('daemon is gone') });
    await assert.rejects(stack.stopOwnDb(`q-${HEX}`, { run: docker.run, printError: () => {} }), /daemon is gone/);
    assert.deepEqual(docker.of('down'), []);
  });

  it('a failing `down` throws with Docker\'s output', async () => {
    const docker = fakeDocker({ list: listingOf([`q-${HEX}`]), down: new Error('removal failed: volume is in use') });
    await assert.rejects(stack.stopOwnDb(`q-${HEX}`, { run: docker.run, printError: () => {} }), /volume is in use/);
  });
});

describe('the command line', () => {
  const cli = (argv, docker, extra = {}) => {
    const l = lines();
    const sig = fakeSignals();
    return stack.cli(argv, { run: docker.run, print: l.print, printError: l.printError, onSignal: sig.onSignal, ...extra }).then(code => ({ code, ...l, sig }));
  };

  it('`own-up q` prints `<name> <port>` alone on its last line, and ends 0', async () => {
    const docker = fakeDocker({ port: '127.0.0.1:32990' });
    const r = await cli(['own-up', 'q'], docker);
    assert.equal(r.code, 0);
    assert.match(r.out.at(-1), /^q-[0-9a-f]{8} 32990$/);
    assert.deepEqual(r.out.filter(x => /32990/.test(x)), [r.out.at(-1)], 'the port is printed on a line other than the last');
    const name = r.out.at(-1).split(' ')[0];
    assertEveryComposeCall(docker, ownProject(name));
  });

  it('`own-up` whose start fails ends non-zero and prints no `<name> <port>` line', async () => {
    const docker = fakeDocker({ up: new Error('exited 1\nboom') });
    const r = await cli(['own-up', 'q'], docker);
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.some(x => /^q-[0-9a-f]{8} \d+$/.test(x)), 'a name and port were printed for a database that did not start');
    assert.ok(r.err.some(x => /boom/.test(x)), 'Docker\'s output was not printed');
  });

  it('`own-list` prints one line per database with its take-down command, and `none` for none', async () => {
    const docker = fakeDocker({ list: [
      psLine({ project: ownProject('a-11111111'), port: 32774 }),
      psLine({ project: ownProject('b-22222222'), state: 'exited', status: 'Exited (0) 1 hour ago', port: null }),
    ].join('\n') });
    const r = await cli(['own-list'], docker);
    assert.equal(r.code, 0);
    assert.equal(r.out.length, 2);
    assert.match(r.out[0], /a-11111111/);
    assert.match(r.out[0], /32774/);
    assert.match(r.out[0], /Up 3 minutes/);
    assert.match(r.out[0], /own-down a-11111111/);
    assert.match(r.out[1], /own-down b-22222222/);
    assert.match(r.out[1], /Exited \(0\) 1 hour ago/);
    const empty = await cli(['own-list'], fakeDocker({ list: '' }));
    assert.equal(empty.code, 0);
    assert.deepEqual(empty.out, ['none']);
  });

  it('`own-list` ends non-zero when the listing fails, and prints no `none`', async () => {
    const r = await cli(['own-list'], fakeDocker({ list: new Error('daemon down') }));
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('none'), 'a listing that failed was printed as none');
  });

  it('`own-down <name>` removes that database and ends 0', async () => {
    const docker = fakeDocker({ list: listingOf([`q-${HEX}`]) });
    const r = await cli(['own-down', `q-${HEX}`], docker);
    assert.equal(r.code, 0);
    assert.equal(docker.of('down').length, 1);
    assertEveryComposeCall(docker, ownProject(`q-${HEX}`));
  });

  const usageErrors = [
    ['`own-up` with no label', ['own-up']],
    ['`own-down` with no name', ['own-down']],
    ['`own-up` with a label that is refused', ['own-up', 'Bad Label']],
    ['an unknown command', ['frobnicate']],
    ['no command', []],
  ];
  for (const [what, argv] of usageErrors) {
    it(`${what} is a usage error: non-zero, the usage on the error line, nothing started or removed`, async () => {
      const docker = fakeDocker();
      const r = await cli(argv, docker);
      assert.notEqual(r.code, 0);
      assert.deepEqual(docker.composeCalls(), [], 'a usage error reached compose');
      assert.ok(r.err.length > 0, 'nothing was said');
    });
  }

  it('the usage text names all five commands', async () => {
    const r = await cli(['frobnicate'], fakeDocker());
    const said = r.err.join('\n');
    for (const command of ['up', 'down', 'own-up', 'own-down', 'own-list']) assert.ok(new RegExp(`(^|[^-\\w])${command}([^-\\w]|$)`).test(said), `the usage does not name ${command}: ${said}`);
  });

  it('`up 3 extra` starts shards 0 to 2 and prints 3 alone on its last line, as before', async () => {
    const docker = fakeDocker();
    const r = await cli(['up', '3', 'extra'], docker);
    assert.equal(r.code, 0);
    assert.equal(r.out.at(-1), '3');
    const upProjects = docker.of('up').map(c => c.project).sort();
    assert.deepEqual(upProjects, [0, 1, 2].map(stack.dbShardProject));
  });

  it('`down 2` removes shards 0 and 1; `down` with no count and `up` with a bad count are errors', async () => {
    const docker = fakeDocker();
    const r = await cli(['down', '2'], docker);
    assert.equal(r.code, 0);
    assert.deepEqual([...new Set(docker.of('down').map(c => c.project))].sort(), [0, 1].map(stack.dbShardProject));
    for (const argv of [['down'], ['down', '0'], ['down', String(DB_SHARDS_MAX + 1)], ['up', '0'], ['up', 'x']]) {
      const bad = fakeDocker();
      const e = await cli(argv, bad);
      assert.notEqual(e.code, 0, `${argv.join(' ')} ended 0`);
      assert.deepEqual(bad.composeCalls(), [], `${argv.join(' ')} reached compose`);
    }
  });
});

describe('the shards', () => {
  it('startDbShards and stopDbShards pass each shard its own project and its own port', async () => {
    const docker = fakeDocker();
    const started = await stack.startDbShards(3, { run: docker.run });
    assert.deepEqual(started, [0, 1, 2].map(index => ({ index, port: dbShardPort(index) })));
    assert.ok(docker.composeCalls().length >= 3);
    for (const c of docker.composeCalls()) {
      const index = [0, 1, 2].find(i => stack.dbShardProject(i) === c.project);
      assert.notEqual(index, undefined, `a compose call names ${c.project}, not a shard's project`);
      assert.equal(c.env[PORT_VARIABLE], String(dbShardPort(index)), `shard ${index}'s ${c.verb} carries port ${c.env[PORT_VARIABLE]}`);
    }
    const stopper = fakeDocker();
    await stack.stopDbShards([{ index: 1 }, { index: 2 }], { run: stopper.run });
    assert.deepEqual(stopper.of('down').map(c => c.project).sort(), [1, 2].map(stack.dbShardProject));
    for (const c of stopper.of('down')) assert.equal(c.env[PORT_VARIABLE], String(dbShardPort(c.project.endsWith('1') ? 1 : 2)));
  });

  it('a shard that fails to start removes every shard and the error names it', async () => {
    const docker = fakeDocker({ up: (c) => (c.project === stack.dbShardProject(1) ? new Error('shard one is broken') : '') });
    await assert.rejects(stack.startDbShards(2, { run: docker.run }), /shard one is broken/);
    const downs = new Set(docker.of('down').map(c => c.project));
    assert.ok(downs.has(stack.dbShardProject(0)) && downs.has(stack.dbShardProject(1)), 'a shard was left running');
  });
});

describe('the projects the listing counts and shows', () => {
  const lookAlikes = [
    psLine({ project: `${OWN_PREFIX}foo` }),
    psLine({ project: `${OWN_PREFIX}q-0123abcd-extra` }),
    psLine({ project: `${OWN_PREFIX}Q-0123abcd` }),
    psLine({ project: OWN_PREFIX }),
  ].join('\n');

  it('a project that only begins with the prefix is neither listed nor counted', async () => {
    const docker = fakeDocker({ list: `${listingOf([ownName(1)])}\n${lookAlikes}` });
    assert.deepEqual((await stack.listOwnDbs({ run: docker.run })).map(d => d.name), [ownName(1)]);
    const nearlyFull = fakeDocker({ list: `${listingOf(Array.from({ length: stack.DB_OWN_MAX - 1 }, (_, i) => ownName(i)))}\n${lookAlikes}` });
    const started = await start(nearlyFull);
    assert.equal(started.name, `q-${HEX}`, 'look-alike projects were counted against the limit');
  });

  it('a project with two containers is one line, the running one', async () => {
    const project = ownProject('a-11111111');
    const docker = fakeDocker({
      list: [
        psLine({ project, id: 'old', state: 'exited', status: 'Exited (0) 2 hours ago', port: null }),
        psLine({ project, id: 'new', state: 'running', status: 'Up 1 minute', port: 32001 }),
      ].join('\n'),
    });
    const dbs = await stack.listOwnDbs({ run: docker.run });
    assert.equal(dbs.length, 1);
    assert.equal(dbs[0].state, 'running');
    assert.equal(dbs[0].port, 32001);
    const full = fakeDocker({ list: `${listingOf(Array.from({ length: stack.DB_OWN_MAX - 1 }, (_, i) => ownName(i)))}\n${psLine({ project: ownProject(ownName(0)), id: 'second' })}` });
    assert.equal((await start(full)).name, `q-${HEX}`, 'a second container of one project was counted as a second database');
  });
});

describe('removing a database whose container is gone', () => {
  const name = `q-${HEX}`;
  const networkLine = JSON.stringify({ ID: 'net-id', Name: `${OWN_PREFIX}${name}_default` });

  it('a project with no container but a network is still taken down', async () => {
    const docker = fakeDocker({ list: '', network: networkLine });
    await stack.stopOwnDb(name, { run: docker.run, printError: () => {} });
    assert.equal(docker.of('down').length, 1);
    assertEveryComposeCall(docker, ownProject(name));
    assert.ok(docker.of('network')[0].argv.join(' ').includes(`com.docker.compose.project=${ownProject(name)}`), 'the networks of another project were asked for');
  });

  it('no container and no network is still "no own database", and no `down` is called', async () => {
    const docker = fakeDocker({ list: '', network: '' });
    await assert.rejects(stack.stopOwnDb(name, { run: docker.run, printError: () => {} }), /own-list/);
    assert.deepEqual(docker.of('down'), []);
  });

  it('a network listing that fails or cannot be read is a refusal, not "no network"', async () => {
    for (const network of [new Error('daemon is gone'), 'not json', '[1]']) {
      const docker = fakeDocker({ list: '', network });
      await assert.rejects(stack.stopOwnDb(name, { run: docker.run, printError: () => {} }));
      assert.deepEqual(docker.of('down'), [], `a network listing of ${network instanceof Error ? network.message : network} reached a down`);
    }
  });

  it('a container found means the networks are not asked for', async () => {
    const docker = fakeDocker({ list: listingOf([name]) });
    await stack.stopOwnDb(name, { run: docker.run, printError: () => {} });
    assert.deepEqual(docker.of('network'), []);
  });
});

/** A `process` that only emits signals and records how it was asked to end. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.exits = [];
  proc.exit = (code) => { proc.exits.push(code); };
  return proc;
}

describe('the interrupt hook of the real process', () => {
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  /** Exit codes a shell reports for each of them: 128 plus the signal's number. */
  const EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

  it('registers all three signals, runs the handler once per signal, and ends the process with the signal\'s code afterwards', async () => {
    for (const signal of SIGNALS) {
      const proc = fakeProcess();
      const seen = [];
      stack.onProcessSignal(async (s) => { seen.push(s); }, proc);
      for (const s of SIGNALS) assert.equal(proc.listenerCount(s), 1, `${s} has no listener`);
      proc.emit(signal);
      await until(() => proc.exits.length === 1);
      assert.deepEqual(seen, [signal]);
      assert.deepEqual(proc.exits, [EXIT_CODE[signal]]);
    }
  });

  it('keeps the listeners while the handler runs, and a second signal neither runs it again nor ends the process', async () => {
    const proc = fakeProcess();
    let finish;
    const seen = [];
    stack.onProcessSignal((s) => { seen.push(s); return new Promise((resolve) => { finish = resolve; }); }, proc);
    proc.emit('SIGINT');
    for (const s of SIGNALS) assert.equal(proc.listenerCount(s), 1, `${s} lost its listener while the removal runs: the next signal would kill it halfway`);
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await new Promise(r => setImmediate(r));
    assert.deepEqual(seen, ['SIGINT'], 'a second signal ran the handler again');
    assert.deepEqual(proc.exits, [], 'a second signal ended the process before the removal finished');
    finish();
    await until(() => proc.exits.length === 1);
    assert.deepEqual(proc.exits, [130]);
  });

  it('a handler that throws still ends the process', async () => {
    const proc = fakeProcess();
    stack.onProcessSignal(async () => { throw new Error('removal failed'); }, proc);
    proc.emit('SIGTERM');
    await until(() => proc.exits.length === 1);
    assert.deepEqual(proc.exits, [143]);
  });

  it('the function it returns removes every listener', () => {
    const proc = fakeProcess();
    const dispose = stack.onProcessSignal(async () => {}, proc);
    dispose();
    for (const s of SIGNALS) assert.equal(proc.listenerCount(s), 0, `${s} keeps a listener`);
  });
});

describe('the real docker run', () => {
  /** A child process that records what was done to it. */
  function fakeChild() {
    const child = new EventEmitter();
    child.destroyed = [];
    for (const name of ['stdout', 'stderr']) {
      child[name] = new EventEmitter();
      child[name].destroy = () => { child.destroyed.push(name); };
    }
    return child;
  }
  const spawnerOf = (child) => { const seen = []; return { seen, spawn: (command, argv, options) => { seen.push({ command, argv, options }); return child; } }; };

  it('on abort destroys the child\'s output pipes, so a compose plugin that outlives docker cannot hold the process open', async () => {
    const child = fakeChild();
    const spawner = spawnerOf(child);
    const controller = new AbortController();
    const run = stack.dockerRun(['compose', 'up'], { env: {}, signal: controller.signal }, spawner.spawn);
    assert.equal(spawner.seen[0].options.signal, controller.signal, 'the signal is not handed to spawn, which kills the child on abort');
    assert.deepEqual(child.destroyed, []);
    controller.abort();
    assert.deepEqual([...child.destroyed].sort(), ['stderr', 'stdout']);
    child.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    await assert.rejects(run, /aborted/);
  });

  it('with the signal already aborted destroys the pipes at once', () => {
    const child = fakeChild();
    const controller = new AbortController();
    controller.abort();
    const run = stack.dockerRun(['ps'], { signal: controller.signal }, spawnerOf(child).spawn);
    run.catch(() => {});
    assert.deepEqual([...child.destroyed].sort(), ['stderr', 'stdout']);
  });

  it('resolves with the output of a call that exits 0, and rejects with it when it exits non-zero', async () => {
    const ok = fakeChild();
    const good = stack.dockerRun(['ps'], {}, spawnerOf(ok).spawn);
    ok.stdout.emit('data', 'out ');
    ok.stderr.emit('data', 'err');
    ok.emit('close', 0);
    assert.equal(await good, 'out err');
    const bad = fakeChild();
    const failed = stack.dockerRun(['ps'], {}, spawnerOf(bad).spawn);
    bad.stderr.emit('data', 'no such container\n');
    bad.emit('close', 3);
    await assert.rejects(failed, /exited 3[^]*no such container/);
    assert.deepEqual(ok.destroyed.concat(bad.destroyed), [], 'a call that was not aborted had its pipes destroyed');
  });
});

describe('the guide\'s recipes stop when `own-up` fails', () => {
  const guide = readFileSync(join(REPO_ROOT, 'docs', 'testing-guide.md'), 'utf8').replace(/\r\n/g, '\n');
  const recipe = (lang) => [...guide.matchAll(new RegExp('```' + lang + '\\n([^]*?)```', 'g'))].map(m => m[1]).find(b => b.includes('own-up'));

  it('there is a recipe in each shell, and it removes the database whatever the run did', () => {
    for (const lang of ['bash', 'powershell']) {
      const text = recipe(lang);
      assert.ok(text, `the guide has no ${lang} recipe that starts an own database`);
      assert.match(text, /own-down/);
      assert.match(text, /YTHRIL_TEST_MONGO_PORT/);
    }
  });

  it('bash: a failed `own-up` or an empty or non-numeric port ends the recipe before the file runs', () => {
    const text = recipe('bash');
    assert.match(text, /pipefail/, 'a failing own-up inside a pipe is read as the exit status of `tail`');
    assert.match(text, /\^\[0-9\]\+\$/, 'the port is not checked to be a number');
    assert.match(text, /exit 1/);
    assert.ok(text.indexOf('exit 1') < text.indexOf('node --test'), 'the check comes after the file runs');
    assert.match(text, /trap .*own-down.* EXIT/, 'the database is not removed when the run fails');
  });

  it('PowerShell: a failed `own-up` or an empty or non-numeric port throws before the file runs, and the removal is in a finally', () => {
    const text = recipe('powershell');
    assert.match(text, /\$LASTEXITCODE/, 'a failed own-up is not noticed');
    assert.match(text, /\\d\+/, 'the port is not checked to be a number');
    assert.match(text, /throw/);
    assert.ok(text.indexOf('throw') < text.indexOf('node --test'), 'the check comes after the file runs');
    assert.match(text, /finally\s*\{[^}]*own-down/, 'the database is not removed when the run fails');
  });
});

describe('the command line as a process', () => {
  const entry = join(REPO_ROOT, 'testing', '_init', 'db-shard-stack.mjs');
  const runEntry = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: testChildEnv() });

  it('a usage error ends the process with 1 and says the usage on stderr, with nothing on stdout', () => {
    for (const args of [['frobnicate'], ['own-up'], ['own-down'], []]) {
      const r = runEntry(...args);
      assert.equal(r.status, 1, `${args.join(' ')} ended ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /own-up <label>/);
      assert.equal(r.stdout, '');
    }
  });
});

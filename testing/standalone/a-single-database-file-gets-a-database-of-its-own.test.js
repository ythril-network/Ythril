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
  const verbOf = (argv) => {
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
    'ask-ps': 'container-id\n',
    inspect: 'name false 0 \n',
    port: '127.0.0.1:32774\n',
    up: '',
    down: '',
  };
  const run = async (argv, options = {}) => {
    const { compose, verb, project } = verbOf(argv);
    const call = { argv, env: options.env, verb, project, compose, aborted: () => options.signal?.aborted === true };
    calls.push(call);
    let answer = answers[verb] ?? defaults[verb] ?? '';
    if (typeof answer === 'function') answer = answer(call);
    if (answer === 'hang') return new Promise(() => {});
    if (answer instanceof Error) throw answer;
    if (answer && typeof answer.then === 'function') return answer;
    return answer;
  };
  const composeCalls = () => calls.filter(c => c.compose);
  const of = (verb) => calls.filter(c => c.verb === verb);
  return { run, calls, composeCalls, of };
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
  return stack.startOwnDb({ label }, { run: docker.run, print: l.print, printError: l.printError, onSignal: fakeSignals().onSignal, random: () => HEX, ...extra });
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
      stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, print: l.print, printError: l.printError, random: () => HEX }),
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
    await assert.rejects(start(docker, 'q', { limits: SHORT_LIMITS }), /no answer|did not|limit/i);
    assert.equal(docker.of('up')[0].aborted(), true, 'the hung `up` was not stopped');
    assert.equal(docker.of('down').length, 1);
    assert.equal(docker.of('down')[0].project, ownProject(`q-${HEX}`));
  });

  it('an interrupt during the start removes the project it made, once, with the state asked first', async () => {
    let release;
    const hung = new Promise((_, reject) => { release = () => reject(new Error('killed by the interrupt')); });
    const docker = fakeDocker({ up: () => hung });
    const sig = fakeSignals();
    const l = lines();
    const started = stack.startOwnDb({ label: 'q' }, { run: docker.run, onSignal: sig.onSignal, print: l.print, printError: l.printError, random: () => HEX });
    for (let i = 0; i < 200 && docker.of('up').length === 0; i++) await new Promise(r => setImmediate(r));
    assert.equal(docker.of('up').length, 1, 'the start never reached its `up`');
    assert.equal(sig.handlers.length, 1, 'the start registered no interrupt handler');
    await sig.handlers[0]('SIGINT');
    assert.equal(docker.of('down').length, 1, 'the interrupt did not remove the project');
    assert.equal(docker.of('down')[0].project, ownProject(`q-${HEX}`));
    const order = docker.calls.map(c => c.verb);
    assert.ok(order.indexOf('ask-ps') >= 0 && order.indexOf('ask-ps') < order.indexOf('down'), `the state is not asked before the down: ${order.join(', ')}`);
    release();
    await assert.rejects(started);
    assert.equal(docker.of('down').length, 1, 'the failed `up` removed the project a second time');
    assert.equal(sig.disposed, 1, 'the interrupt handler was left registered');
    assertEveryComposeCall(docker, ownProject(`q-${HEX}`));
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

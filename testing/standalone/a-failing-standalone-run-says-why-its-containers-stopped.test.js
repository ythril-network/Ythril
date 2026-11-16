/**
 * A failing local standalone run says why its containers stopped, before anything removes them (Q-792 part 6).
 *
 * ## The rule
 *
 * When `run-standalone.mjs` ends with a failed batch, it prints `docker inspect`'s OOMKilled, ExitCode and Error for the
 * containers the run used (the compose projects it names), and for a sharded `-db` run it prints each shard's before
 * `stopDbShards` runs `compose down --volumes`, which removes the evidence. The three fields are the ones CI prints
 * (`.github/actions/dump-test-stack-logs/action.yml`): the format is read from that file, never retyped. Asking Docker
 * is never allowed to stop the run's own cleanup: a hung or throwing inspect still lets `stop` run, and a Docker that
 * does not answer prints `docker not reachable`.
 *
 * ## The failure that bought it
 *
 * An OOM-killed test Mongo made a local run read as dozens of unrelated failures (ECONNREFUSED in every database file).
 * CI had printed container state since main's run 43499981804; a local run printed nothing, and the shard's container was
 * gone by the time anyone looked.
 *
 * Two halves. The behaviour (`container-state.mjs`) is driven with an injected `ask` and `stop`. The wiring (that the runner
 * calls it at the shared failure line and before the shard stop) is read from the runner's source with comments stripped,
 * and proven by planted copies of the runner with each call removed.
 *
 * Run: node --test testing/standalone/a-failing-standalone-run-says-why-its-containers-stopped.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { stripComments } from './_strip-comments.mjs';
import { reportContainerState, reportThenStop } from '../_init/container-state.mjs';

const ACTION = fileURLToPath(new URL('../../.github/actions/dump-test-stack-logs/action.yml', import.meta.url));
const RUNNER = fileURLToPath(new URL('../_init/run-standalone.mjs', import.meta.url));

/** The inspect format CI prints, read by this test's own pattern from the action's run script (comment lines dropped). */
const actionFormat = () => {
  const script = readFileSync(ACTION, 'utf8').split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
  const m = /docker inspect -f '([^']+)'/.exec(script);
  assert.ok(m, 'the dump action no longer runs docker inspect -f with a quoted format');
  return m[1];
};

/** A docker that knows one project holding two containers and answers inspect with CI's line shape. */
const fakeDocker = (calls) => async (argv) => {
  calls.push(argv);
  if (argv[0] === 'ps') return argv.some(a => a.endsWith('=ythril-db-shard-1')) ? 'c1\nc2\n' : '';
  if (argv[0] === 'inspect') return '/ythril-mongo-a OOMKilled=true ExitCode=137 Error=\n/ythril-b OOMKilled=false ExitCode=0 Error=\n';
  throw new Error(`unexpected docker ${argv.join(' ')}`);
};

const collect = () => { const lines = []; return { lines, print: (l) => lines.push(l) }; };

describe('container state is printed with the fields CI prints', () => {
  it('asks docker inspect with the action\'s own format and prints the answer line by line', async () => {
    const calls = [];
    const { lines, print } = collect();
    await reportContainerState({ projects: ['ythril-db-shard-1'], ask: fakeDocker(calls), print });
    const inspect = calls.find(c => c[0] === 'inspect');
    assert.ok(inspect, 'docker inspect was never asked');
    assert.equal(inspect[inspect.indexOf('-f') + 1], actionFormat(), 'the format differs from the CI action\'s');
    assert.deepEqual(inspect.slice(-2), ['c1', 'c2'], 'inspect was not given the project\'s container ids');
    assert.deepEqual(lines.filter(l => /OOMKilled=/.test(l)), [
      '/ythril-mongo-a OOMKilled=true ExitCode=137 Error=',
      '/ythril-b OOMKilled=false ExitCode=0 Error=',
    ]);
  });

  it('finds the containers by the compose project label, with an argument array and no shell', async () => {
    const calls = [];
    await reportContainerState({ projects: ['ythril-test'], ask: fakeDocker(calls), print: () => {} });
    const ps = calls.find(c => c[0] === 'ps');
    assert.ok(Array.isArray(ps) && ps.includes('-aq'), 'running containers only would miss the one that exited');
    assert.ok(ps.includes('label=com.docker.compose.project=ythril-test'));
  });

  it('refuses a format that would print more than the three fields', async () => {
    const calls = [];
    const { lines, print } = collect();
    await reportContainerState({
      projects: ['ythril-db-shard-1'], ask: fakeDocker(calls), print,
      format: '{{.Name}} {{.Config.Env}} OOMKilled={{.State.OOMKilled}}',
    });
    assert.equal(calls.some(c => c[0] === 'inspect'), false, 'inspect ran with a format that reads the container environment');
    assert.equal(lines.some(l => /OOMKilled=true/.test(l)), false);
  });

  it('says docker is not reachable when it cannot ask, and never throws', async () => {
    const { lines, print } = collect();
    await reportContainerState({ projects: ['ythril-test'], ask: async () => { throw new Error('spawn docker ENOENT'); }, print });
    assert.ok(lines.some(l => /docker not reachable/.test(l)), `no 'docker not reachable' in: ${lines.join(' | ')}`);
    assert.equal(lines.some(l => /ENOENT/.test(l)), false, 'a raw spawn error is not a container-state line');
  });

  it('says so when the project has no container left, rather than printing nothing', async () => {
    const { lines, print } = collect();
    await reportContainerState({ projects: ['ythril-db-shard-9'], ask: fakeDocker([]), print });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ythril-db-shard-9/);
  });
});

describe('a failing run reads the state before it removes the containers, and the removal always happens', () => {
  const hung = () => new Promise(() => {});

  it('inspect runs before stop when the run failed', async () => {
    const order = [];
    const ask = async (argv) => { order.push(`ask:${argv[0]}`); return argv[0] === 'ps' ? 'c1' : '/x OOMKilled=false ExitCode=0 Error=\n'; };
    await reportThenStop({ failed: true, projects: ['p'], ask, print: () => {}, stop: async () => { order.push('stop'); } });
    assert.deepEqual(order, ['ask:ps', 'ask:inspect', 'stop']);
  });

  it('a passing run asks docker nothing and still stops', async () => {
    const order = [];
    const ask = async (argv) => { order.push(`ask:${argv[0]}`); return ''; };
    await reportThenStop({ failed: false, projects: ['p'], ask, print: () => {}, stop: async () => { order.push('stop'); } });
    assert.deepEqual(order, ['stop']);
  });

  it('an inspect that never answers is given up on, and stop runs', async () => {
    let stopped = false;
    const { lines, print } = collect();
    await reportThenStop({ failed: true, projects: ['p'], ask: hung, print, timeoutMs: 40, stop: async () => { stopped = true; } });
    assert.equal(stopped, true);
    assert.ok(lines.some(l => /docker not reachable/.test(l)));
  });

  // The case above passed locally and failed in CI ("Promise resolution is still pending but the event loop has already
  // resolved"): the bound's timer was unref'd, and only other handles in a busy process kept the loop alive. A fresh
  // process with nothing else alive is the honest test of a bound that must hold the run until it answers.
  it('in a process with nothing else alive, a hung inspect is still given up on and stop runs', () => {
    const mod = new URL('../_init/container-state.mjs', import.meta.url).href;
    const script = `import { reportThenStop } from ${JSON.stringify(mod)};
      await reportThenStop({ failed: true, projects: ['p'], ask: () => new Promise(() => {}), print: () => {}, timeoutMs: 40, stop: async () => { console.log('stopped'); } });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000, env: testChildEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stopped/);
  });

  it('an inspect that throws, and a print that throws, still let stop run', async () => {
    let stopped = 0;
    await reportThenStop({ failed: true, projects: ['p'], ask: async () => { throw new Error('boom'); }, print: () => {}, stop: async () => { stopped++; } });
    await reportThenStop({
      failed: true, projects: ['p'], ask: async (argv) => (argv[0] === 'ps' ? 'c1' : '/x OOMKilled=false ExitCode=0 Error=\n'),
      print: () => { throw new Error('stderr closed'); }, stop: async () => { stopped++; },
    });
    assert.equal(stopped, 2);
  });

  it('a stop that fails is the caller\'s to see: the error is not swallowed', async () => {
    await assert.rejects(reportThenStop({ failed: false, projects: [], ask: hung, print: () => {}, stop: async () => { throw new Error('down failed'); } }), /down failed/);
  });
});

/**
 * What the runner must do, read from its source with comments stripped: the shared failure line prints the stack's state
 * before it exits, and the sharded run hands its `stop` to `reportThenStop` instead of calling it bare.
 */
function wiringProblems(source) {
  const src = stripComments(source);
  const problems = [];
  if (!/import\s*\{[^}]*\breportContainerState\b[^}]*\}\s*from\s*'\.\/container-state\.mjs'/.test(src)) problems.push('reportContainerState is not imported from ./container-state.mjs');
  if (!/import\s*\{[^}]*\breportThenStop\b[^}]*\}\s*from\s*'\.\/container-state\.mjs'/.test(src)) problems.push('reportThenStop is not imported from ./container-state.mjs');

  const fn = /async function runDbSharded\b[\s\S]*?\n\}/.exec(src);
  if (!fn) problems.push('runDbSharded not found');
  else {
    const fin = /finally\s*\{([\s\S]*)\}\s*$/.exec(fn[0]);
    if (!fin) problems.push('runDbSharded has no finally');
    else {
      if (!/reportThenStop\s*\(/.test(fin[1])) problems.push('runDbSharded\'s finally does not call reportThenStop');
      if (/(^|[^.\w])await stop\(\)/.test(fin[1])) problems.push('runDbSharded\'s finally still calls stop() bare, past the state report');
      if (!/ythril-db-shard-|dbShardProject/.test(fn[0])) problems.push('runDbSharded never names the shard compose projects');
    }
  }

  const exit = /if \(failed > 0\) \{([\s\S]*?)\n\}/.exec(src);
  if (!exit) problems.push('the shared failure line (if (failed > 0)) not found');
  else {
    const at = exit[1].search(/reportContainerState\s*\(/);
    const out = exit[1].search(/process\.exit\(1\)/);
    if (at === -1) problems.push('the shared failure line does not print container state');
    else if (out !== -1 && at > out) problems.push('the shared failure line exits before it prints container state');
  }
  return problems;
}

describe('run-standalone.mjs is wired to print the state on every failing path', () => {
  const source = readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout and an LF one read alike

  it('the runner as it stands has no wiring problem', () => {
    assert.deepEqual(wiringProblems(source), []);
  });

  it('planted copies of the runner are refused: no call at the failure line, a bare stop, a call only in a comment', () => {
    const noReport = source.replace(/await reportContainerState\([^;]*;/, '');
    assert.ok(noReport !== source, 'the plant did not change the runner');
    assert.ok(wiringProblems(noReport).some(p => /shared failure line/.test(p)), 'a failure line with no report was accepted');

    const bareStop = source.replace(/await reportThenStop\([\s\S]*?\}\);\n/, 'await stop();\n');
    assert.ok(bareStop !== source, 'the bare-stop plant did not change the runner');
    assert.ok(wiringProblems(bareStop).some(p => /finally/.test(p)), 'a bare stop in the finally was accepted');

    const commented = source.replace(/await reportContainerState\(/, '// await reportContainerState(');
    assert.ok(wiringProblems(commented).some(p => /shared failure line/.test(p)), 'a call that is only in a comment was accepted');
  });
});

/**
 * The test stack's take-down, on real containers: a held container keeps running with the file it wrote, the other container and its volume go,
 * a start is refused while one is held, and with no hold both go.
 *
 * ## What it proves that the offline file cannot
 *
 * `the-test-stack-take-down-leaves-what-another-holds.test.js` pins the hold rule and the plan over a stub of Docker. This file runs the module's
 * act (`stackDown`) against a real engine and reads what survived: that `docker rm` and `docker volume rm` of the listed names leave a running
 * container and its volume alone, that compose's own labels are what the listing reads, and that a network a kept container is attached to is no failure.
 *
 * ## Why it cannot reach the real stack
 *
 * `stackDown` takes its projects as parameters; this file gives it one scratch project of its own, with names no stack of this repository has
 * (`ythril-q922-stackdown-<pid>-<time>`), and refuses to run when that name is `ythril-test` or `testing`, or when a container it would create carries
 * a name the test stack's compose file pins. The two services run `sleep` on the Mongo image the repository already pins, so no image is added.
 * It cleans up in every case, and reads nothing from the real stack's holds directory: the holds are a scratch directory it writes.
 *
 * ## Opt-in, never skipped
 *
 * It starts containers, so it is registered only when `YTHRIL_TEST_STACK_DOWN_DOCKER=1`. Absent, not skipped: a skipped test is refused by the CI
 * aggregator. The always-registered part is the guard that the names it would use stay away from the real stack.
 *
 * Run: YTHRIL_TEST_STACK_DOWN_DOCKER=1 node --test testing/standalone/the-test-stack-take-down-keeps-a-held-container-docker.test.js
 * (books Docker memory on a machine with a booking tool: about 2 GB, a minute).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stackDown, DEFAULT_PROJECTS, DEFAULT_COMPOSE_FILE } from '../_init/stack-down.mjs';

export const OPT_IN = 'YTHRIL_TEST_STACK_DOWN_DOCKER';

const COMPOSE_TEXT = readFileSync(join(REPO_ROOT, DEFAULT_COMPOSE_FILE), 'utf8');
/** The Mongo image the test stack pins, read from its compose file: the one image this file starts. */
const MONGO_IMAGE = /^\s+image:\s*(mongodb\/mongodb-atlas-local\S+)/m.exec(COMPOSE_TEXT)?.[1];
/** Every container name the real test stack pins. */
const REAL_CONTAINER_NAMES = [...COMPOSE_TEXT.matchAll(/^\s+container_name:\s*(\S+)/gm)].map((m) => m[1]);

/** The names of one scratch stack: a project and its two containers, none of which the real stack can have. */
export function scratchNames(stamp = `${process.pid}-${Date.now().toString(36)}`) {
  const project = `ythril-q922-stackdown-${stamp}`;
  return { project, keep: `${project}-keep`, go: `${project}-go` };
}

/** The reasons a set of scratch names would reach the real stack; empty when it cannot. */
export function reachesRealStack({ project, keep, go }, real = REAL_CONTAINER_NAMES) {
  const why = [];
  if (DEFAULT_PROJECTS.includes(project)) why.push(`the project ${project} is a real one`);
  for (const name of [keep, go]) if (real.includes(name)) why.push(`the container ${name} is one the test stack pins`);
  if (project === '') why.push('the project has no name');
  return why;
}

describe('the Docker take-down test stays away from the real stack', () => {
  it('reads the Mongo image and the real container names out of the compose file (a read that found none guards nothing)', () => {
    assert.match(MONGO_IMAGE ?? '', /@sha256:[0-9a-f]{64}$/, 'the image is pinned by digest');
    assert.ok(REAL_CONTAINER_NAMES.includes('ythril-mongo-a') && REAL_CONTAINER_NAMES.length >= 8, REAL_CONTAINER_NAMES.join(', '));
  });

  it('its scratch names are unique and are not the real stack\'s', () => {
    const a = scratchNames();
    assert.deepEqual(reachesRealStack(a), []);
    assert.notEqual(scratchNames('1-a').project, scratchNames('1-b').project);
    assert.match(a.keep, /q922/);
  });

  it('refuses the real project names and the real container names', () => {
    assert.equal(reachesRealStack({ project: 'ythril-test', keep: 'x', go: 'y' }).length, 1);
    assert.equal(reachesRealStack({ project: 'testing', keep: 'x', go: 'y' }).length, 1);
    assert.equal(reachesRealStack({ project: 'p', keep: 'ythril-mongo-a', go: 'y' }).length, 1);
    assert.equal(reachesRealStack({ project: 'p', keep: 'x', go: 'ythril-a' }).length, 1);
  });
});

/** `docker <args>`, an argument array and no shell, a timeout; `{ status, stdout, stderr }`. */
function docker(args, timeout = 120_000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** Is there a container (any state) or a volume of exactly this name? The filter matches part of a name, so the lines are compared whole. */
const exists = (kind, name) => {
  const args = kind === 'volume'
    ? ['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}']
    : ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'];
  return docker(args).stdout.split('\n').includes(name);
};
const running = (name) => docker(['inspect', '-f', '{{.State.Running}}', name]).stdout === 'true';

if (process.env[OPT_IN] === '1') {
  describe('live: a held container survives the take-down on real containers', () => {
    const names = scratchNames();
    const work = mkdtempSync(join(tmpdir(), 'q922-stackdown-'));
    const composeFile = join(work, 'compose.yml');
    const holdsDir = join(work, 'holds');
    const emptyHolds = join(work, 'no-holds');
    const configsDir = join(work, 'configs');
    const instances = [{ id: 'a', container: names.go }, { id: 'b', container: names.keep }];
    const volumeOf = (service) => `${names.project}_${service}data`;
    const holdFile = join(holdsDir, 'hold.json');

    const service = (container, vol) => `  ${container.endsWith('keep') ? 'keep' : 'go'}:
    image: ${MONGO_IMAGE}
    container_name: ${container}
    user: "0:0"
    entrypoint: ["sleep", "3600"]
    healthcheck:
      disable: true
    mem_limit: 64m
    stop_grace_period: 1s
    volumes:
      - ${vol}:/marker
`;

    /** `stackDown` against the scratch project, its output collected. */
    function takeDown(holds, extra = {}) {
      const lines = [];
      const code = stackDown({ projects: [names.project], composeFile, holdsDir: holds, configsDir, instances, log: (l) => lines.push(l), error: (l) => lines.push(l), ...extra });
      return { code, text: lines.join('\n') };
    }

    const configFiles = (x) => readdirSync(join(configsDir, x));
    const resetConfigs = () => { for (const x of ['a', 'b']) { mkdirSync(join(configsDir, x), { recursive: true }); writeFileSync(join(configsDir, x, 'config.json'), '{}'); } };
    const up = () => docker(['compose', '-p', names.project, '-f', composeFile, 'up', '-d'], 300_000);
    const cleanUp = () => {
      assert.deepEqual(reachesRealStack(names), []);
      docker(['compose', '-p', names.project, '-f', composeFile, 'down', '-v', '--remove-orphans'], 300_000);
      for (const c of [names.keep, names.go]) docker(['rm', '-f', '-v', c]);
      for (const v of [volumeOf('keep'), volumeOf('go')]) docker(['volume', 'rm', '-f', v]);
    };

    before(() => {
      assert.deepEqual(reachesRealStack(names), [], 'the scratch names reach the real stack: not starting anything');
      assert.ok(MONGO_IMAGE, 'no pinned Mongo image found in the compose file');
      writeFileSync(composeFile, `services:\n${service(names.keep, 'keepdata')}${service(names.go, 'godata')}volumes:\n  keepdata: {}\n  godata: {}\n`);
      mkdirSync(holdsDir); mkdirSync(emptyHolds);
      assert.equal(docker(['info', '--format', '{{.ServerVersion}}']).status, 0, 'the Docker engine does not answer');
      const started = up();
      assert.equal(started.status, 0, started.stderr);
      for (const c of [names.keep, names.go]) {
        const wrote = docker(['exec', c, 'sh', '-c', 'echo written-by-the-test > /marker/file']);
        assert.equal(wrote.status, 0, `${c}: ${wrote.stderr}`);
      }
      writeFileSync(holdFile, JSON.stringify({ id: 'q922', pid: process.pid, label: 'q922/docker-test', startedAt: Date.now(), expiresAt: Date.now() + 3_600_000, containers: [names.keep] }));
      resetConfigs();
    });
    after(() => { try { cleanUp(); } finally { rmSync(work, { recursive: true, force: true }); } });

    it('a start is refused while one container is held: exit 1, the holder named, nothing removed, nothing wiped', { timeout: 300_000 }, () => {
      const r = takeDown(holdsDir, { forStart: true });
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, /q922\/docker-test/);
      assert.match(r.text, /test:down:all/);
      assert.ok(running(names.keep) && running(names.go), 'both containers still run');
      assert.ok(exists('volume', volumeOf('keep')) && exists('volume', volumeOf('go')), 'both volumes remain');
      assert.deepEqual([configFiles('a'), configFiles('b')], [['config.json'], ['config.json']]);
    });

    it('a take-down leaves the held container running with the file it wrote, and removes the other with its volume', { timeout: 300_000 }, () => {
      const r = takeDown(holdsDir);
      assert.equal(r.code, 0, r.text);
      assert.match(r.text, new RegExp(`kept ${names.keep}.*q922/docker-test`));
      assert.ok(running(names.keep), 'the held container still runs');
      assert.equal(docker(['exec', names.keep, 'cat', '/marker/file']).stdout, 'written-by-the-test');
      assert.ok(exists('volume', volumeOf('keep')), 'its volume remains');
      assert.ok(!exists('container', names.go), 'the other container is gone');
      assert.ok(!exists('volume', volumeOf('go')), 'its volume is gone');
      assert.deepEqual(configFiles('a'), [], 'the instance whose container went has its config wiped');
      assert.deepEqual(configFiles('b'), ['config.json'], 'the kept instance keeps its config');
    });

    it('with no hold, both containers and both volumes go', { timeout: 300_000 }, () => {
      const started = up();
      assert.equal(started.status, 0, started.stderr);
      assert.ok(running(names.keep) && running(names.go), 'the stack starts again beside the kept container');
      resetConfigs();
      const r = takeDown(emptyHolds);
      assert.equal(r.code, 0, r.text);
      for (const c of [names.keep, names.go]) assert.ok(!exists('container', c), `${c} is gone`);
      for (const v of ['keep', 'go']) assert.ok(!exists('volume', volumeOf(v)), `${v}'s volume is gone`);
      assert.deepEqual([configFiles('a'), configFiles('b')], [[], []]);
    });
  });
}

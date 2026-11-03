/**
 * A script that brings the test stack up first takes down BOTH compose projects the stack's file can have been started as.
 *
 * ## What happened
 *
 * The test stack's file pins container names (`ythril-mongo-a`, `ythril-a`, ...). A container name is global to the Docker
 * daemon, so the stack can be up under only one project at a time. `npm run test:up` took down `-p ythril-test` and started
 * `-p ythril-test`; a stack an earlier run had started WITHOUT `-p` belongs to the default project (named for the directory,
 * `testing`), is not in `ythril-test`, and so was not taken down: the `up` failed with "container name ... is already in use by
 * project testing", far from its cause. `test:down` already took down both. Bundle-231 found it when a test-writing agent's
 * database run held `ythril-mongo-a` under the default project.
 *
 * ## The rule
 *
 * Every package script, and every tracked shell script, that runs `docker compose ... up` on `testing/docker-compose.test.yml`
 * has, BEFORE that `up`, a `down` of the `ythril-test` project and a `down` of the default project (no `-p`), both on the same
 * file. `npm run <script>` counts as the commands of that script, so a script may call `test:down` instead of spelling both.
 * What is not covered, on purpose: the CI jobs. Each starts on a fresh runner, where no earlier project exists to collide with.
 *
 * Run: node --test testing/standalone/a-script-that-starts-the-test-stack-first-downs-both-projects.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellCommands } from '../_shared/ci-workflow.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

const TEST_COMPOSE = 'testing/docker-compose.test.yml';
const TEST_PROJECT = 'ythril-test';
const OPTS_WITH_VALUE = new Set(['-p', '--project-name', '-f', '--file', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel']);

const unquote = (w) => w.replace(/^(['"])(.*)\1$/, '$2');

/** One command read as a `docker compose` call: `{ verb, project, files }`, or null when it is not one. */
export function composeCall(command) {
  const words = command.split(/\s+/).filter(Boolean).map(unquote);
  const at = words.findIndex((w, i) => (w === 'docker' && words[i + 1] === 'compose') || w === 'docker-compose');
  if (at < 0) return null;
  let i = at + (words[at] === 'docker' ? 2 : 1);
  let project = null;
  const files = [];
  for (; i < words.length && words[i].startsWith('-'); i++) {
    const [flag, inline] = words[i].split(/=(.*)/s);
    const value = inline ?? (OPTS_WITH_VALUE.has(flag) ? words[++i] : undefined);
    if (flag === '-p' || flag === '--project-name') project = value ?? null;
    if (flag === '-f' || flag === '--file') files.push((value ?? '').replace(/^\.\//, ''));
  }
  return { verb: words[i] ?? '', project, files };
}

/** The commands of a script in order, each `npm run <name>` replaced by that script's own commands (depth-bounded). */
export function expand(script, scripts, depth = 0) {
  const out = [];
  for (const command of shellCommands(script)) {
    const run = /^npm\s+run\s+([\w:.-]+)/.exec(command);
    if (run && scripts[run[1]] !== undefined && depth < 5) out.push(...expand(scripts[run[1]], scripts, depth + 1));
    else out.push(command);
  }
  return out;
}

/** What is wrong with one script's start of the test stack. Empty when it starts none, or starts it after downing both projects. */
export function startViolations(name, script, scripts = {}) {
  const commands = expand(script, scripts);
  const calls = commands.map(composeCall);
  const onTest = (c) => c !== null && c.files.includes(TEST_COMPOSE);
  const firstUp = calls.findIndex((c) => onTest(c) && c.verb === 'up');
  if (firstUp < 0) return [];
  const before = calls.slice(0, firstUp).filter(onTest).filter((c) => c.verb === 'down');
  const v = [];
  if (!before.some((c) => c.project === TEST_PROJECT)) v.push(`${name}: starts the test stack without first taking down the \`${TEST_PROJECT}\` project`);
  if (!before.some((c) => c.project === null)) v.push(`${name}: starts the test stack without first taking down the default project (a \`down\` with no \`-p\`), which a stack started without \`-p\` belongs to`);
  return v;
}

const packageScripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
const SHELL_FILES = trackedSources('scripts', { ext: ['.sh'], floor: 1 });

describe('a script that starts the test stack first takes down both projects', () => {
  it('the scan found the package scripts that start the stack (a gate that found none proves nothing)', () => {
    const starters = Object.entries(packageScripts).filter(([name, s]) => expand(s, packageScripts).some((c) => { const k = composeCall(c); return k && k.verb === 'up' && k.files.includes(TEST_COMPOSE); }) && /^test:up/.test(name));
    assert.ok(starters.length >= 2, `expected test:up and test:up:rebuild, found ${starters.map(([n]) => n).join(', ') || 'none'}`);
  });

  it('every package script that starts the test stack downs both projects first', () => {
    const found = Object.entries(packageScripts).flatMap(([name, s]) => startViolations(`package.json "${name}"`, s, packageScripts));
    assert.deepEqual(found, [], found.join('\n'));
  });

  it('every tracked shell script that starts the test stack downs both projects first', () => {
    const found = SHELL_FILES.flatMap((f) => startViolations(f, readFileSync(join(REPO_ROOT, f), 'utf8').replace(/^\s*#.*$/gm, '')));
    assert.deepEqual(found, [], found.join('\n'));
  });
});

describe('the gate itself', () => {
  const UP = `docker compose -p ${TEST_PROJECT} -f ${TEST_COMPOSE} up -d`;
  const DOWN_P = `docker compose -p ${TEST_PROJECT} -f ${TEST_COMPOSE} down -v --remove-orphans`;
  const DOWN_DEFAULT = `docker compose -f ${TEST_COMPOSE} down --remove-orphans`;

  it('both downs before the up is clean, in either order', () => {
    assert.deepEqual(startViolations('a', `${DOWN_DEFAULT} && ${DOWN_P} && ${UP}`), []);
    assert.deepEqual(startViolations('a', `${DOWN_P} && ${DOWN_DEFAULT} && ${UP}`), []);
  });

  it('a script that starts nothing is clean', () => {
    assert.deepEqual(startViolations('a', `${DOWN_P}`), []);
    assert.deepEqual(startViolations('a', `docker compose -f ${TEST_COMPOSE} config --images`), []);
  });

  it('flags the old test:up (only the named project is taken down)', () => {
    const found = startViolations('a', `${DOWN_P} && node testing/_init/reset-test-configs.mjs && ${UP}`);
    assert.equal(found.length, 1);
    assert.match(found[0], /default project/);
  });

  it('flags a start with no down, and one with only the default down', () => {
    assert.equal(startViolations('a', UP).length, 2);
    const found = startViolations('a', `${DOWN_DEFAULT} && ${UP}`);
    assert.equal(found.length, 1);
    assert.match(found[0], /ythril-test/);
  });

  it('flags a down that comes AFTER the up, and a down of another compose file', () => {
    assert.equal(startViolations('a', `${UP} && ${DOWN_P} && ${DOWN_DEFAULT}`).length, 2);
    assert.equal(startViolations('a', `docker compose -f docker-compose.yml down && docker compose -p ${TEST_PROJECT} -f docker-compose.yml down && ${UP}`).length, 2);
  });

  it('reads `npm run test:down` as both downs, and the project from either spelling of the flag', () => {
    const scripts = { 'test:down': `${DOWN_P} && ${DOWN_DEFAULT}` };
    assert.deepEqual(startViolations('a', `npm run test:down && ${UP}`, scripts), []);
    assert.deepEqual(startViolations('a', `docker compose --project-name=${TEST_PROJECT} --file ${TEST_COMPOSE} down && ${DOWN_DEFAULT} && docker compose --project-name ${TEST_PROJECT} -f ${TEST_COMPOSE} up`), []);
  });
});

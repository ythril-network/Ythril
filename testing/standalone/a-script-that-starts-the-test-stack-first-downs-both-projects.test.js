/**
 * A script that brings the test stack up first calls the one take-down, which leaves what another session holds, and nothing else takes the stack down.
 *
 * ## What happened
 *
 * The test stack's file pins container names (`ythril-mongo-a`, `ythril-a`, ...). A container name is global to the Docker
 * daemon, so the stack can be up under only one project at a time. `npm run test:up` took down `-p ythril-test` and started
 * `-p ythril-test`; a stack an earlier run had started WITHOUT `-p` belongs to the default project (named for the directory,
 * `testing`), is not in `ythril-test`, and so was not taken down: the `up` failed with "container name ... is already in use by
 * project testing", far from its cause (bundle-231). The fix spelled both `down`s in each script.
 *
 * Q-922 then found the second half: those `down -v` calls removed `ythril-mongo-a`, with its data, while another session held it, and a `test:up`
 * started beside a held stack put two sessions on one database. The `down`s now live in ONE module, `testing/_init/stack-down.mjs`, which reads
 * the holds (a directory of booking files, `YTHRIL_TEST_STACK_HOLDS_DIR`), leaves what is held and refuses a start while anything is held.
 *
 * ## The rule
 *
 * - Every package script, and every tracked shell script, that runs `docker compose ... up` on `testing/docker-compose.test.yml` calls
 *   `node testing/_init/stack-down.mjs --for-start` BEFORE that `up`, and not with `--ignore-holds`. `npm run <script>` counts as the commands of that
 *   script. What is not covered, on purpose: the CI jobs, each of which starts on a fresh runner with no earlier project and no holder.
 * - The module's default projects are `ythril-test` and `testing` (the default project, named with `-p` so no environment variable can aim the
 *   take-down at another project): the two names a stack of this file can have been started under.
 * - No package script, tracked `.sh` or `.ps1` file or workflow file spells a compose `down` on the test stack's file, except the files in
 *   `a-script-that-starts-the-test-stack-first-downs-both-projects.allow.json`, each with a reason and a review date. A spelled `down` is a take-down that
 *   does not ask the holds. What the text cannot see is a `.mjs` that builds its compose arguments as an array: the module's docblock is the guard there.
 *
 * Run: node --test testing/standalone/a-script-that-starts-the-test-stack-first-downs-both-projects.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellCommands } from '../_shared/ci-workflow.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { DEFAULT_PROJECTS } from '../_init/stack-down.mjs';

const TEST_COMPOSE = 'testing/docker-compose.test.yml';
const STACK_DOWN = 'testing/_init/stack-down.mjs';
const OPTS_WITH_VALUE = new Set(['-p', '--project-name', '-f', '--file', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel']);
const ALLOW_FILE = new URL('./a-script-that-starts-the-test-stack-first-downs-both-projects.allow.json', import.meta.url);

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

/** One command read as a call of the take-down module: `{ forStart, ignoreHolds }`, or null when it is not one. */
export function stackDownCall(command) {
  const words = command.split(/\s+/).filter(Boolean).map(unquote).map((w) => w.replace(/^\.\//, ''));
  const at = words.indexOf(STACK_DOWN);
  if (at < 0 || words[at - 1] !== 'node') return null;
  const flags = words.slice(at + 1);
  return { forStart: flags.includes('--for-start'), ignoreHolds: flags.includes('--ignore-holds') };
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

/** What is wrong with one script's start of the test stack. Empty when it starts none, or starts it after the take-down module's `--for-start`. */
export function startViolations(name, script, scripts = {}) {
  const commands = expand(script, scripts);
  const firstUp = commands.findIndex((command) => { const c = composeCall(command); return c !== null && c.files.includes(TEST_COMPOSE) && c.verb === 'up'; });
  if (firstUp < 0) return [];
  const before = commands.slice(0, firstUp).map(stackDownCall).filter((c) => c !== null);
  const v = [];
  if (!before.some((c) => c.forStart)) v.push(`${name}: starts the test stack without first calling \`node ${STACK_DOWN} --for-start\`, which takes the stack down, leaves what another session holds and refuses a start beside a held stack`);
  if (before.some((c) => c.ignoreHolds)) v.push(`${name}: starts the test stack after a take-down that ignores holds (\`--ignore-holds\` is for the holder itself, \`npm run test:down:all\`)`);
  return v;
}

const DOWN_ON_TEST_STACK = /docker(?:\s+|-)compose\b.*\bdown\b/;
const NAMES_TEST_COMPOSE = /docker-compose\.test\.yml/;

/**
 * The lines of one text that spell a compose `down` in a file that names the test stack's compose file: `[{ line, text }]`. A full-line comment is not read
 * (a comment that explains a take-down is not one), and the line number is the original's.
 */
export function downSpellings(text) {
  if (!NAMES_TEST_COMPOSE.test(text)) return [];
  return text.split(/\r?\n/)
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter(({ text: t }) => t !== '' && !t.startsWith('#') && DOWN_ON_TEST_STACK.test(t));
}

/** The same question of a package script: it names the test file and spells a compose `down`. */
export function scriptSpellsDown(script) {
  return NAMES_TEST_COMPOSE.test(script) && shellCommands(script).some((c) => { const k = composeCall(c); return k !== null && k.verb === 'down'; });
}

/** Allowlist entries that are not usable as written: no reason, no valid review date, a date gone by, or a file that spells no `down` any more. */
export function allowProblems(entries, { today = new Date(), spells = () => true } = {}) {
  const problems = [];
  for (const e of entries) {
    if (typeof e.file !== 'string' || e.file === '') problems.push('an entry has no file');
    else if (typeof e.reason !== 'string' || e.reason.trim().length < 20) problems.push(`${e.file}: no reason (at least a sentence)`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '') || Number.isNaN(Date.parse(e.reviewBy))) problems.push(`${e.file}: reviewBy is not a date`);
    else if (new Date(e.reviewBy) <= today) problems.push(`${e.file}: reviewBy ${e.reviewBy} has passed, so the exception is reviewed again or removed`);
    else if (!spells(e.file)) problems.push(`${e.file}: spells no compose down on the test stack any more, so the exception is stale`);
  }
  return problems;
}

const packageScripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
const SHELL_FILES = trackedSources('scripts', { ext: ['.sh'], floor: 1 });
const SCRIPT_FILES = trackedSources('.', { ext: ['.sh', '.ps1'], floor: 5 });
const WORKFLOW_FILES = trackedSources('.github', { ext: ['.yml', '.yaml'], floor: 3 });
const ALLOW = JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).entries;
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

describe('a script that starts the test stack first calls the take-down module', () => {
  it('the scan found the package scripts that start the stack (a gate that found none proves nothing)', () => {
    const starters = Object.entries(packageScripts).filter(([name, s]) => expand(s, packageScripts).some((c) => { const k = composeCall(c); return k && k.verb === 'up' && k.files.includes(TEST_COMPOSE); }) && /^test:up/.test(name));
    assert.ok(starters.length >= 2, `expected test:up and test:up:rebuild, found ${starters.map(([n]) => n).join(', ') || 'none'}`);
  });

  it('every package script that starts the test stack calls the module with --for-start first', () => {
    const found = Object.entries(packageScripts).flatMap(([name, s]) => startViolations(`package.json "${name}"`, s, packageScripts));
    assert.deepEqual(found, [], found.join('\n'));
  });

  it('every tracked shell script that starts the test stack calls the module with --for-start first', () => {
    const found = SHELL_FILES.flatMap((f) => startViolations(f, read(f).replace(/^\s*#.*$/gm, '')));
    assert.deepEqual(found, [], found.join('\n'));
  });

  it('the module\'s default projects are the two a stack of this file can have been started under: ythril-test, and the default project named explicitly', () => {
    assert.deepEqual([...DEFAULT_PROJECTS].sort(), ['testing', 'ythril-test']);
  });
});

describe('nothing but the module takes the test stack down', () => {
  it('no package script spells a compose down on the test stack\'s file', () => {
    const found = Object.entries(packageScripts).filter(([, s]) => scriptSpellsDown(s)).map(([n]) => `package.json "${n}"`);
    assert.deepEqual(found, [], `${found.join(', ')}: a compose down spelled here does not ask the holds; call node ${STACK_DOWN} instead`);
  });

  it('no tracked .sh or .ps1 file, and no workflow file, spells one, but the allowlist\'s', () => {
    const allowed = new Set(ALLOW.map((e) => e.file));
    const found = [...SCRIPT_FILES, ...WORKFLOW_FILES].filter((f) => !allowed.has(f))
      .flatMap((f) => downSpellings(read(f)).map(({ line, text }) => `${f}:${line}: ${text}`));
    assert.deepEqual(found, [], `a compose down spelled here does not ask the holds; call node ${STACK_DOWN} instead, or name the file in the allowlist with a reason:\n${found.join('\n')}`);
  });

  it('the scan reads the files that could spell one (the machine-freeing script is one, and is allowlisted)', () => {
    assert.ok(SCRIPT_FILES.includes('scripts/machine-free.ps1'));
    assert.ok(WORKFLOW_FILES.includes('.github/workflows/ci.yml'));
    assert.ok(downSpellings(read('scripts/machine-free.ps1')).length >= 1, 'the allowlisted file is read as spelling a down: the scan would see the same line anywhere');
  });

  it('every allowlist entry has a reason, a review date still to come, and a file that still spells a down', () => {
    const problems = allowProblems(ALLOW, { spells: (f) => downSpellings(read(f)).length > 0 });
    assert.deepEqual(problems, [], problems.join('\n'));
    console.log(`take-down allowlist: ${ALLOW.length} exception(s)`);
  });
});

describe('the gate itself', () => {
  const UP = `docker compose -p ythril-test -f ${TEST_COMPOSE} up -d`;
  const DOWN_P = `docker compose -p ythril-test -f ${TEST_COMPOSE} down -v --remove-orphans`;
  const DOWN_DEFAULT = `docker compose -f ${TEST_COMPOSE} down -v --remove-orphans`;
  const MODULE_START = `node ${STACK_DOWN} --for-start`;

  it('the module with --for-start before the up is clean, whatever else runs between', () => {
    assert.deepEqual(startViolations('a', `${MODULE_START} && node testing/_init/reset-test-configs.mjs && ${UP}`), []);
    assert.deepEqual(startViolations('a', `${MODULE_START} && ${UP}`), []);
  });

  it('a script that starts nothing is clean', () => {
    assert.deepEqual(startViolations('a', `node ${STACK_DOWN}`), []);
    assert.deepEqual(startViolations('a', `docker compose -f ${TEST_COMPOSE} config --images`), []);
  });

  it('flags the old test:up (both downs spelled, no module call)', () => {
    const found = startViolations('a', `${DOWN_DEFAULT} && ${DOWN_P} && node testing/_init/reset-test-configs.mjs && ${UP}`);
    assert.equal(found.length, 1);
    assert.match(found[0], /stack-down\.mjs --for-start/);
  });

  it('flags a start with no take-down at all', () => {
    assert.equal(startViolations('a', UP).length, 1);
  });

  it('flags a module call without --for-start, one after the up, and one that ignores holds', () => {
    assert.equal(startViolations('a', `node ${STACK_DOWN} && ${UP}`).length, 1, 'a plain take-down before a start does not refuse a held stack');
    assert.equal(startViolations('a', `${UP} && ${MODULE_START}`).length, 1);
    const found = startViolations('a', `node ${STACK_DOWN} --ignore-holds --for-start && ${UP}`);
    assert.equal(found.length, 1);
    assert.match(found[0], /ignores holds/);
  });

  it('does not read the module from another command that merely names it', () => {
    assert.equal(startViolations('a', `echo ${STACK_DOWN} --for-start && ${UP}`).length, 1);
    assert.equal(startViolations('a', `node other.mjs ${STACK_DOWN} --for-start && ${UP}`).length, 1);
  });

  it('reads `npm run test:down:all`-style calls through npm run, and the module path with a leading ./', () => {
    const scripts = { 'test:guard': MODULE_START };
    assert.deepEqual(startViolations('a', `npm run test:guard && ${UP}`, scripts), []);
    assert.deepEqual(startViolations('a', `node ./${STACK_DOWN} --for-start && ${UP}`), []);
    assert.equal(startViolations('a', `npm run test:guard && ${UP}`, { 'test:guard': `node ${STACK_DOWN}` }).length, 1);
  });

  it('a compose project and file are read from either spelling of the flags', () => {
    assert.deepEqual(composeCall(`docker compose --project-name=ythril-test --file ${TEST_COMPOSE} down`), { verb: 'down', project: 'ythril-test', files: [TEST_COMPOSE] });
  });

  it('flags a package script that spells a down on the test stack, the old test:down among them, and not one that takes down another file', () => {
    assert.equal(scriptSpellsDown(`${DOWN_P} && ${DOWN_DEFAULT}`), true);
    assert.equal(scriptSpellsDown(`docker compose -f ${TEST_COMPOSE} down --remove-orphans`), true);
    assert.equal(scriptSpellsDown(`node ${STACK_DOWN}`), false);
    assert.equal(scriptSpellsDown('docker compose down -v'), false);
    assert.equal(scriptSpellsDown(`docker compose -f ${TEST_COMPOSE} up -d`), false);
  });

  it('flags a .ps1 or .sh line that spells a down, with its original line number, and reads no comment', () => {
    const ps1 = ['# a take-down of the stack: docker compose -p ythril-test -f testing/docker-compose.test.yml down -v', "$compose = Join-Path $repo 'testing\\docker-compose.test.yml'", '  docker compose -p ythril-test -f $compose down -v --remove-orphans'].join('\r\n');
    assert.deepEqual(downSpellings(ps1), [{ line: 3, text: 'docker compose -p ythril-test -f $compose down -v --remove-orphans' }]);
    const sh = `echo hi\n  docker-compose -f ${TEST_COMPOSE} down\n`;
    assert.deepEqual(downSpellings(sh), [{ line: 2, text: `docker-compose -f ${TEST_COMPOSE} down` }]);
    assert.deepEqual(downSpellings(`# docker compose -f ${TEST_COMPOSE} down\n`), []);
  });

  it('a file that does not name the test stack\'s compose file, or spells no down, is clean', () => {
    assert.deepEqual(downSpellings('docker compose -f docker-compose.yml down -v'), []);
    assert.deepEqual(downSpellings(`docker compose -f ${TEST_COMPOSE} up -d --wait`), []);
  });

  it('flags an allowlist entry with no reason, a bad or past review date, or a file that no longer spells a down', () => {
    const ok = { file: 'a.ps1', reason: 'frees the whole machine on purpose and ends every hold', reviewBy: '2027-05-19' };
    const today = new Date('2026-11-19');
    assert.deepEqual(allowProblems([ok], { today }), []);
    assert.equal(allowProblems([{ ...ok, reason: '' }], { today }).length, 1);
    assert.equal(allowProblems([{ ...ok, reviewBy: 'soon' }], { today }).length, 1);
    assert.equal(allowProblems([{ ...ok, reviewBy: '2026-11-19' }], { today }).length, 1);
    assert.equal(allowProblems([ok], { today, spells: () => false }).length, 1);
    assert.equal(allowProblems([{ reason: ok.reason, reviewBy: ok.reviewBy }], { today }).length, 1);
  });
});

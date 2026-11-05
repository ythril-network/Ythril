/**
 * The published image carries no `typescript`: the production install omits development dependencies, and the publish workflow asks the BUILT image that
 * `node_modules/typescript` is absent (Q-687, design v3 item 13, legal lens S2).
 *
 * ## The defect this prevents
 *
 * The schema package's from-typescript entry reads TypeScript source with the caller's own `typescript`; the package declares it an optional peer and ships none of it
 * (`schema/NOTICE` says so). That sentence is true of the image only while nothing installs the compiler there. Only one line keeps it out today: the
 * `prod-deps` stage's `npm ci ... --omit=dev` (`Dockerfile`), because `typescript` is `devOptional` in the lock. A change that made it a `dependency`
 * of the server, dropped the flag, or let npm install the optional peer would put an Apache-2.0 work (Microsoft) in the image with no NOTICE heading, and no gate
 * would say so: the NOTICE gates skip the peer by design. The same thing happened to the licence files once (2.2.5 shipped with neither), and the answer is the
 * same: the instruction is held here without Docker, and the EFFECT is asked of the built image, in the publish workflow, where an image exists.
 *
 * ## What is held
 *
 * - The Dockerfile's `prod-deps` stage installs with `--omit=dev` for the server and schema workspaces, and nothing in the Dockerfile installs `typescript`.
 * - `typescript` is a development dependency of the schema package and of no production manifest (`server/package.json` lists it under neither `dependencies`
 *   nor `optionalDependencies`; `schema/package.json` under neither `dependencies` nor `optionalDependencies`).
 * - `publish.yml` has a step named "Verify ..." that runs `docker run ... "test ! -d /app/node_modules/typescript"` against the pushed image, and it comes BEFORE the
 *   step that announces the release (an announcement of an unverified image is worse than none).
 * - The reader is proven on planted workflows: the check in a comment only, on another path, with `-s` (present) instead of `! -d` (absent), after the announcement,
 *   and with no `docker run` are each refused.
 *
 * Run: node --test testing/standalone/the-published-image-carries-no-typescript.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobEntries, loadWorkflow, parseWorkflow, shellOf, stepsOf } from '../_shared/ci-workflow.mjs';

const read = (p) => readFileSync(p, 'utf8');

/** Every step of a parsed workflow, its jobs in file order. */
const workflowSteps = (doc) => jobEntries(doc).flatMap(({ job }) => stepsOf(job));

/** The paths of the image a step asserts ABSENT: `docker run ... "test ! -d /app/<path>"` (or `-e`), on one command line. */
const absentPaths = (script) => [...script.matchAll(/docker run\b[^\n]*?\btest\s+!\s+-[de]\s+(\/app\/[^\s"';&|]+)/g)].map(m => m[1]);

/** Whether the parsed workflow verifies `path` absent in a "Verify" step that precedes the release announcement (`shellOf` drops comment lines). */
function verifiesAbsent(doc, path) {
  const steps = workflowSteps(doc);
  const named = (s, re) => re.test(String(s.name ?? ''));
  const verify = steps.findIndex(s => named(s, /^Verify\b/) && absentPaths(shellOf(s)).includes(path));
  const announce = steps.findIndex(s => named(s, /\bRelease\b/) && named(s, /^Create\b/));
  return verify >= 0 && (announce < 0 || verify < announce);
}

const TS_PATH = '/app/node_modules/typescript';

describe('the reader this gate stands on (planted workflows)', () => {
  const step = (name, body) => `      - name: ${name}\n        run: |\n${body}\n`;
  const planted = (...steps) => parseWorkflow(`on: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps.join('')}`, 'planted');
  const check = `          docker run --rm --entrypoint sh "$IMAGE" -c "test ! -d ${TS_PATH}"`;

  it('accepts the check in a Verify step before the announcement', () => {
    assert.equal(verifiesAbsent(planted(step('Verify the image carries no typescript', check), step('Create the GitHub Release from the CHANGELOG', '          echo go')), TS_PATH), true);
  });

  it('refuses a comment-only check, another path, the wrong test, no docker run, and a check after the announcement', () => {
    assert.equal(verifiesAbsent(planted(step('Verify x', `          # ${check.trim()}\n          echo hi`)), TS_PATH), false, 'a comment is not a check');
    assert.equal(verifiesAbsent(planted(step('Verify x', check.replace('typescript', 'zod'))), TS_PATH), false, 'another path');
    assert.equal(verifiesAbsent(planted(step('Verify x', check.replace('test ! -d', 'test -s'))), TS_PATH), false, 'a presence test is the opposite check');
    assert.equal(verifiesAbsent(planted(step('Verify x', `          test ! -d ${TS_PATH}`)), TS_PATH), false, 'no docker run asks nothing of the image');
    assert.equal(verifiesAbsent(planted(step('Create the GitHub Release', '          echo go'), step('Verify x', check)), TS_PATH), false, 'after the announcement');
    assert.equal(verifiesAbsent(planted(step('Build x', check)), TS_PATH), false, 'not a Verify step');
  });
});

describe('the image carries no typescript', () => {
  it('the production install omits development dependencies, and nothing installs typescript in the Dockerfile', () => {
    const dockerfile = read('Dockerfile');
    const at = dockerfile.indexOf('AS prod-deps');
    assert.ok(at > 0, 'the Dockerfile has no prod-deps stage');
    const stage = dockerfile.slice(at).split(/^FROM\b/m)[0];
    assert.match(stage, /^RUN npm ci\b[^\n]*--workspace=schema[^\n]*--omit=dev|^RUN npm ci\b[^\n]*--omit=dev[^\n]*--workspace=schema/m,
      'the prod-deps install of the server and schema workspaces does not pass --omit=dev');
    const installs = dockerfile.split(/\r?\n/).filter(l => !/^\s*#/.test(l) && /\bnpm (?:i|install|add)\b[^\n]*\btypescript\b/.test(l));
    assert.deepEqual(installs, [], 'the Dockerfile installs typescript');
  });

  it('typescript is a development dependency only: in no production dependency list of the server or the schema package', () => {
    for (const manifest of ['server/package.json', 'schema/package.json']) {
      const json = JSON.parse(read(manifest));
      for (const field of ['dependencies', 'optionalDependencies']) {
        assert.ok(!('typescript' in (json[field] ?? {})) && !('typescript-6' in (json[field] ?? {})), `${manifest} lists typescript under ${field}: the image would install it`);
      }
    }
    assert.ok('typescript' in (JSON.parse(read('schema/package.json')).devDependencies ?? {}), 'schema/package.json lost its typescript devDependency');
  });

  it('publish.yml asks the pushed image that node_modules/typescript is absent, in a Verify step before the announcement', () => {
    const wf = loadWorkflow('.github/workflows/publish.yml');
    assert.ok(workflowSteps(wf).length >= 8, 'the workflow was read as fewer than eight steps: the reader is broken');
    assert.ok(verifiesAbsent(wf, TS_PATH),
      `.github/workflows/publish.yml has no "Verify ..." step running docker run ... "test ! -d ${TS_PATH}" ahead of the release announcement: the licence sentence in schema/NOTICE (the compiler is the caller's own, never installed) is unchecked against the image`);
  });
});

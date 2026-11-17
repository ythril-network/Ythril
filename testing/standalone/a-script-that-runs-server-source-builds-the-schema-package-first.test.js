/**
 * Every script that runs a workspace's TypeScript source through `tsx` builds the schema package first, and the text that says so is true (Q-685, SO1).
 *
 * ## What it prevents
 *
 * The server imports the schema package by name, and that name resolves only to `schema/dist`, which is gitignored. `npm run
 * local-connector:dev -w server` had no pre-hook, so from a fresh clone it failed at startup on `util/log.ts`'s import of the package,
 * while `docs/workstation-mode-guide.md` said no build step was needed and the connector's own header said `util/log.ts` had no imports.
 * `dev` had its `predev`; the second `tsx` script was written without one. The rule is over every script, so a third one is covered.
 *
 * ## The rule
 *
 * - In every tracked `package.json` whose workspace depends on the schema package, each script that runs `tsx` has a `pre<name>` script that
 *   builds the package (`npm run build` with `--workspace=` the package's name or its directory).
 * - A comment in the local connector that says `util/log.ts` has no imports is true: the module it names imports nothing.
 * - The workstation guide does not call running the connector from source a no-build-step affair.
 *
 * Run: node --test testing/standalone/a-script-that-runs-server-source-builds-the-schema-package-first.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { SCHEMA_PACKAGE_NAME } from './_relative-specifier.mjs';

const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

/** The `tsx` scripts of `scripts` with no `pre<name>` step that builds the schema package. */
function tsxScriptsWithoutSchemaBuild(scripts, schemaDir = 'schema') {
  const builds = (body = '') => /\bnpm\s+run\s+build\b/.test(body)
    && (body.includes(`--workspace=${SCHEMA_PACKAGE_NAME}`) || body.includes(`-w ${SCHEMA_PACKAGE_NAME}`)
      || body.includes(`--workspace=${schemaDir}`) || body.includes(`-w ${schemaDir}`));
  return Object.entries(scripts)
    .filter(([name, body]) => /\btsx\b/.test(body) && !builds(scripts[`pre${name}`]))
    .map(([name]) => name);
}

const manifests = () => trackedSources('.', { ext: ['package.json'], floor: 4 })
  .filter(f => (f === 'package.json' || f.endsWith('/package.json')) && !f.includes('node_modules/'))
  .map(file => ({ file, json: JSON.parse(read(file)) }));

describe('a tsx script of a workspace that imports the schema package builds it first', () => {
  const dependents = () => manifests().filter(m => SCHEMA_PACKAGE_NAME in { ...m.json.dependencies, ...m.json.devDependencies });

  it('the scan finds the server and at least one tsx script (it cannot pass by reading nothing)', () => {
    const server = dependents().find(m => m.file === 'server/package.json');
    assert.ok(server, 'server/package.json depends on the schema package');
    assert.ok(Object.values(server.json.scripts).filter(b => /\btsx\b/.test(b)).length >= 2, 'the server has its dev and connector tsx scripts');
  });

  it('every tsx script has a pre-hook that builds the package', () => {
    const found = dependents().flatMap(m => tsxScriptsWithoutSchemaBuild(m.json.scripts ?? {}, 'schema').map(n => `${m.file} "${n}"`));
    assert.deepEqual(found, [], `these run source that imports ${SCHEMA_PACKAGE_NAME}, which resolves only to the gitignored schema/dist; add a "pre<name>" that runs npm run build -w ${SCHEMA_PACKAGE_NAME}`);
  });

  it('fails on a planted copy: the real scripts with one pre-hook removed, and with one that does not build', () => {
    const real = JSON.parse(read('server/package.json')).scripts;
    assert.deepEqual(tsxScriptsWithoutSchemaBuild(real), [], 'the real scripts are clean');
    const noHook = { ...real };
    delete noHook.predev;
    assert.deepEqual(tsxScriptsWithoutSchemaBuild(noHook), ['dev']);
    assert.deepEqual(tsxScriptsWithoutSchemaBuild({ ...real, predev: 'echo built' }), ['dev']);
  });
});

describe('what is written about the local connector is true', () => {
  it('a comment that says util/log.ts has no imports of its own is read against util/log.ts', () => {
    const connector = read('server/src/local-agent-connector/index.ts');
    const log = read('server/src/util/log.ts');
    const claims = /util\/log\.ts`? has no imports/.test(connector);
    const imports = /^\s*import\b/m.test(log);
    assert.ok(!(claims && imports), 'local-agent-connector/index.ts says util/log.ts has no imports, and util/log.ts has some (the schema package among them)');
  });

  it('the workstation guide does not tell a fresh clone that running the connector from source needs no build', () => {
    const guide = read('docs/workstation-mode-guide.md');
    const lines = guide.split('\n');
    const at = lines.findIndex(l => l.includes('local-connector:dev'));
    assert.ok(at > 0, 'the guide names the dev script');
    // The sentence that introduces the command: the nearest line above its code fence that is neither blank nor a fence.
    let intro = at - 1;
    while (intro > 0 && (!lines[intro].trim() || lines[intro].startsWith('```'))) intro--;
    assert.doesNotMatch(lines[intro], /no build step/i, 'the dev script builds the schema package first: say that');
  });
});

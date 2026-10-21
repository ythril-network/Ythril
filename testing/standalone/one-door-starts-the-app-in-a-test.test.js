/**
 * A test starts the application in-process through one helper, so its teardown stops what the app started (`Q-570`).
 *
 * ## The defect it prevents
 *
 * `createApp()` starts the config watcher, and a reload it triggers re-arms the cron schedulers. Twenty-two test files and
 * fixtures imported `server/dist/app.js` directly, and each tore down by closing its server and its database, none by stopping
 * the watcher or the schedulers. A reload that re-armed the sync cron during or after that teardown left node-cron's timers
 * holding the test process, and CI's database job ran into its 30-minute limit and was cancelled (PR #1511, PR #1523).
 *
 * The teardown is now one function, `testing/_shared/in-process-app.mjs` (`listenApp()` for a served app, `appRouter()` for a
 * router a test calls without a server), whose `close()` stops the watcher, waits out a reload in flight, closes cron arming
 * and stops the schedulers through the server's own `closeScheduling()`, the same step the shutdown handler takes. A test that
 * imports the app itself has its own teardown again, which is the copy this gate refuses.
 *
 * ## What it holds, derived
 *
 * Every tracked `.js`/`.mjs` file under `testing/` is parsed, and every module specifier it imports (static `import … from`,
 * and `import('…')` with a literal) that resolves to `server/dist/app.js` is a finding, except in the helper itself. A floor on
 * the files that use the helper keeps the gate from passing over a tree where nothing starts an app at all.
 *
 * ## Seen red
 *
 * By hand, put back by hand: on the base (22 direct importers); then one direct `import('../../server/dist/app.js')` added back
 * to a converted test, and one static import added to a fixture.
 *
 * Run: node --test testing/standalone/one-door-starts-the-app-in-a-test.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { parseSource, ts, lineOf } from '../_shared/syntax-tree.mjs';

const HELPER = 'testing/_shared/in-process-app.mjs';
const APP = 'server/dist/app.js';
const HELPER_USERS_FLOOR = 15;

const files = trackedSources('testing', { ext: ['.js', '.mjs'], floor: 300, untracked: true });

/** Every module specifier `file` imports, with its line: static imports, re-exports and literal dynamic imports. */
function specifiersOf(file) {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const sf = parseSource(file, text);
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text, line: lineOf(sf, node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      out.push({ spec: node.arguments[0].text, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** A relative specifier resolved against the importing file, repo-relative with forward slashes; a bare one stays as written. */
const resolveFrom = (file, spec) => spec.startsWith('.') ? posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), spec)) : spec;

const imports = new Map(files.map(f => [f, specifiersOf(f).map(s => ({ ...s, target: resolveFrom(f, s.spec) }))]));

describe('the application is started in a test only through the in-process helper', () => {
  it('no other testing file imports server/dist/app.js', () => {
    const direct = [...imports].flatMap(([file, specs]) => file === HELPER ? []
      : specs.filter(s => s.target === APP).map(s => `${file}:${s.line}`));
    assert.deepEqual(direct, [], 'these files start the app themselves, so their teardown leaves the config watcher and the cron '
      + `schedulers running; use listenApp() or appRouter() from ${HELPER}:\n  ${direct.join('\n  ')}`);
  });

  it(`the helper exists, imports the app, and at least ${HELPER_USERS_FLOOR} files use it`, () => {
    assert.ok(imports.has(HELPER), `${HELPER} is not a tracked file`);
    assert.ok(imports.get(HELPER).some(s => s.target === APP), `${HELPER} does not import ${APP}: the gate would hold nothing`);
    const users = [...imports].filter(([file, specs]) => file !== HELPER && specs.some(s => s.target === HELPER)).map(([f]) => f);
    assert.ok(users.length >= HELPER_USERS_FLOOR,
      `only ${users.length} files use ${HELPER}; the in-process app doors moved elsewhere or the scan is broken`);
  });
});

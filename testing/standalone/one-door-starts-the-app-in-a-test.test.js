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
 * the files that use the helper keeps the gate from passing over a tree where nothing starts an app at all. The helper is also the one
 * place the app's server is created, so it is held to apply the product's `configureConnections` to it before it listens: a server that
 * keeps Node's 5 s keep-alive resets a request a busy process sends on an idle connection (bundle-348).
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
import { stripComments } from './_strip-comments.mjs';

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

  it('the helper gives the server it creates for the app the product\'s connection settings, before it listens', () => {
    // Only the helper may create the app's server (the case above), so this is the one place the setting can be dropped. A server that keeps
    // Node's 5 s keep-alive closes an idle connection a busy process then reuses (Q-73; the store-failure gate's resets, bundle-348).
    const text = stripComments(readFileSync(join(REPO_ROOT, HELPER), 'utf8'));
    assert.match(text, /import\(\s*['"][^'"]*server\/dist\/http-connections\.js['"]\s*\)/, `${HELPER} does not load the product's http-connections module`);
    const create = text.search(/http\.createServer\(\s*createApp\(\)\s*\)/);
    const apply = text.search(/configureConnections\(\s*httpServer\s*\)/);
    const listen = text.search(/listenOnLoopback\(\s*httpServer\s*\)/);
    assert.ok(create > -1 && apply > create && listen > apply,
      `${HELPER} must create the app's server, apply configureConnections to it, and only then listen (positions ${create}, ${apply}, ${listen})`);
    // And the router helper's server (`listenRouterApp`) is the second place a test server for the product's routers is made.
    assert.equal((text.match(/configureConnections\(\s*httpServer\s*\)/g) ?? []).length, 2,
      `${HELPER} applies configureConnections to the server of listenApp and of listenRouterApp: one call for each`);
  });

  it(`the helper exists, imports the app, and at least ${HELPER_USERS_FLOOR} files use it`, () => {
    assert.ok(imports.has(HELPER), `${HELPER} is not a tracked file`);
    assert.ok(imports.get(HELPER).some(s => s.target === APP), `${HELPER} does not import ${APP}: the gate would hold nothing`);
    const users = [...imports].filter(([file, specs]) => file !== HELPER && specs.some(s => s.target === HELPER)).map(([f]) => f);
    assert.ok(users.length >= HELPER_USERS_FLOOR,
      `only ${users.length} files use ${HELPER}; the in-process app doors moved elsewhere or the scan is broken`);
  });
});

// ── a router a test serves: the other spelling of the same server ─────────────────────────────────────────────────────────────

/**
 * Files that serve an `express()` of their own with `createServer(app)` or `app.listen`, each for a reason the helper cannot meet: it listens
 * on loopback only, and these bind a LAN address (the SSRF guards the code under test calls through refuse loopback). None of them serves the
 * product's routers as the subject of the test; each is a scripted peer or a proxy in front of one.
 */
const OWN_LISTENER_EXCEPTIONS = new Map([
  ['testing/standalone/_pull-door.mjs', 'a fake peer the sync code pulls from, bound to a LAN address because the SSRF guards refuse loopback'],
  ['testing/standalone/_file-act-doors.mjs', 'a fake peer that records pushed tombstones, bound to the private LAN address because the SSRF guards refuse loopback'],
  ['testing/standalone/a-large-peer-push-goes-chunked-db.test.js', 'a recording proxy in front of a peer, bound to every interface because the push reaches a peer only by its LAN address'],
]);
const ROUTER_HELPER_USERS_FLOOR = 8;

/**
 * The servers `text` makes by hand for an express app it built: `createServer(app)` and `app.listen(...)`, where `app` is a name declared
 * from `express()` in the same file. A server for a function literal, a stub's handler or a `net` server is not one: it serves no router.
 * Returns `[{ line, how }]`.
 */
function handMadeRouterServers(file, text) {
  const sf = parseSource(file, text);
  const apps = new Set();
  const found = [];
  const named = (node) => ts.isIdentifier(node) && apps.has(node.text);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'express') apps.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const find = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      if (calleeName === 'createServer' && node.arguments.length > 0 && named(node.arguments[0])) found.push({ line: lineOf(sf, node), how: 'createServer(app)' });
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'listen' && named(callee.expression)) found.push({ line: lineOf(sf, node), how: 'app.listen(...)' });
    }
    ts.forEachChild(node, find);
  };
  find(sf);
  return found;
}

describe('a test serves an express app of its own only through the router helper', () => {
  const scanned = new Map(files.filter(f => f !== HELPER).map(f => [f, handMadeRouterServers(f, readFileSync(join(REPO_ROOT, f), 'utf8'))]));

  it('no testing file makes its own server for an express app, except the listed ones', () => {
    const own = [...scanned].filter(([f, hits]) => hits.length > 0 && !OWN_LISTENER_EXCEPTIONS.has(f))
      .flatMap(([f, hits]) => hits.map(h => `${f}:${h.line} ${h.how}`));
    assert.deepEqual(own, [], `these files serve an express app with Node's default 5 s keep-alive, so an idle connection a busy process reuses is reset; `
      + `use listenRouterApp(app) from ${HELPER}, or list the file in OWN_LISTENER_EXCEPTIONS with its reason:\n  ${own.join('\n  ')}`);
  });

  it('every listed exception still makes such a server (a stale exception hides a file the rule would hold)', () => {
    const stale = [...OWN_LISTENER_EXCEPTIONS.keys()].filter(f => !(scanned.get(f)?.length > 0));
    assert.deepEqual(stale, [], `these listed files no longer make their own server for an express app: ${stale.join(', ')}`);
  });

  it(`at least ${ROUTER_HELPER_USERS_FLOOR} files serve their app through listenRouterApp`, () => {
    const users = [...imports].filter(([file, specs]) => file !== HELPER && specs.some(s => s.target === HELPER)
      && readFileSync(join(REPO_ROOT, file), 'utf8').includes('listenRouterApp(')).map(([f]) => f);
    assert.ok(users.length >= ROUTER_HELPER_USERS_FLOOR, `only ${users.length} files call listenRouterApp: the router servers moved elsewhere or the scan is broken`);
  });

  describe('planted, each seen found or left alone', () => {
    const rows = [
      ['createServer over a test-built app', "const app = express();\nconst s = await listenOnLoopback(http.createServer(app));", 1],
      ['app.listen on a test-built app', "const app = express();\nconst s = app.listen(0, '127.0.0.1');", 1],
      ['the same app through the helper', "const app = express();\nconst s = await listenRouterApp(app);", 0],
      ['a stub server for a handler literal', "const s = await listenOnLoopback(http.createServer((req, res) => res.end('ok')));", 0],
      ['createServer over a name that is not an express app', "const handler = makeHandler();\nconst s = http.createServer(handler);", 0],
      ['the call named in a string', "const text = 'http.createServer(app)';\nconst app = express();", 0],
    ];
    for (const [name, text, count] of rows) {
      it(name, () => assert.equal(handMadeRouterServers('planted.mjs', text).length, count));
    }
  });
});

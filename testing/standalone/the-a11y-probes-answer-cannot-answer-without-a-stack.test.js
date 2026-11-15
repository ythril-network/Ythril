/**
 * The three accessibility probes answer "cannot answer" when they have nothing to ask, and read the routes and the themes from the code.
 *
 * ## The failure this prevents (Q-792)
 *
 * The accessibility lens names three checks that run axe-core on Ythril's pages (`check-i-a11y-contrast-both-themes`,
 * `check-i-a11y-form-label-association`, `check-i-accessibility-i18n-deep-automated-scan`). Ythril had no probe for any of them, so project-check
 * answered every one "cannot answer" and the lens was never run. The probes now live in `tools/flow-checks/` over `_axe.mjs`. Each answers
 * on its last stdout line, `holds:`, `violated:` or `cannot answer:`, with exit 0, 1 or 2.
 *
 * ## What is pinned here, with no browser and no stack
 *
 * - A probe that cannot load playwright and axe-core, or cannot reach the base URL, exits 2 with `cannot answer:`. It never exits 0 about a
 *   page it did not scan (the check that is "made" by a probe that found nothing to run is the failure this whole ticket is about).
 * - The route list is DERIVED from `client/src/app/app.routes.ts`: nested children joined, redirects, the `**` catch-all, `setup` and
 *   `oidc-callback` skipped. The deep scan asserts its scanned count equals that derived count, so a route added to the router is scanned or the
 *   probe says why not. The derivation is checked against planted router sources whose answer is written out by hand, and the real file against
 *   a count taken a second, independent way.
 * - Theme detection reads the client's styles with comments stripped: a `prefers-color-scheme` media query or a theme selector means both
 *   schemes are scanned; none means one scan, said as "one theme". A commented-out query must not count.
 * - No module the test imports loads playwright at the top (a static import would make this test need a browser install).
 *
 * The real run of each probe against a running instance is not here: it needs a stack and a browser, so it is run by hand with `--modules`.
 *
 * Run: node --test testing/standalone/the-a11y-probes-answer-cannot-answer-without-a-stack.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { deriveRoutes, detectThemes, readRoutes, readClientStyleSources, stripSourceComments } from '../../tools/flow-checks/_axe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBES = [
  'check-i-a11y-contrast-both-themes',
  'check-i-a11y-form-label-association',
  'check-i-accessibility-i18n-deep-automated-scan',
];
const probePath = (name) => join(HERE, '..', '..', 'tools', 'flow-checks', `${name}.mjs`);

/** A child environment with neither the module folder nor a token inherited from whoever runs this test. */
function cleanEnv(extra = {}) {
  const base = { ...process.env };
  delete base.AXE_MODULES;
  delete base.YTHRIL_TOKEN;
  return testChildEnv(extra, base);
}

/** Run a probe as project-check does: a child process, its stdout read whole, its exit code kept. Async, so a server in this process can answer it. */
function runProbe(name, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath(name), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`probe ${name} did not finish in 60 s; stdout: ${stdout}`)); }, 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      resolve({ code, stdout, stderr, last: lines[lines.length - 1] ?? '' });
    });
  });
}

describe('the probes answer cannot answer when they cannot ask', () => {
  let live;
  let scratch;
  let stubModules;

  before(async () => {
    live = await listenOnLoopback(http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); }));
    scratch = mkdtempSync(join(tmpdir(), 'a11y-probes-'));
    // A modules folder whose packages load but cannot drive a browser: enough to get past the "modules present" step and reach the liveness one.
    stubModules = join(scratch, 'node_modules');
    for (const pkg of ['playwright', '@axe-core/playwright']) {
      mkdirSync(join(stubModules, pkg), { recursive: true });
      writeFileSync(join(stubModules, pkg, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0', main: 'index.js' }));
      writeFileSync(join(stubModules, pkg, 'index.js'), 'module.exports = { chromium: { launch() { throw new Error("stub: no browser"); } }, AxeBuilder: class {} };\n');
    }
  });

  after(async () => {
    await live.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const name of PROBES) {
    it(`${name} exits 2 with "cannot answer:" when no modules folder is given`, async () => {
      const r = await runProbe(name, ['--base-url', live.url], cleanEnv());
      assert.equal(r.code, 2, `stdout: ${r.stdout}`);
      assert.match(r.last, /^cannot answer: .*(--modules|AXE_MODULES)/);
    });

    it(`${name} exits 2 when the modules folder holds neither package`, async () => {
      // Beside the scratch folder, not inside it: a folder under `scratch` would find the stub packages in its parent's node_modules.
      const empty = mkdtempSync(join(tmpdir(), 'a11y-empty-'));
      try {
        const r = await runProbe(name, ['--base-url', live.url, '--modules', empty], cleanEnv());
        assert.equal(r.code, 2, `stdout: ${r.stdout}`);
        assert.match(r.last, /^cannot answer: .*playwright/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it(`${name} reads the modules folder from AXE_MODULES too`, async () => {
      const port = await closedLoopbackPort();
      const r = await runProbe(name, ['--base-url', `http://127.0.0.1:${port}`], cleanEnv({ AXE_MODULES: stubModules }));
      assert.equal(r.code, 2, `stdout: ${r.stdout}`);
      // Past the modules step: the answer is about the URL, not the folder.
      assert.match(r.last, /^cannot answer: .*(does not answer|not answer)/);
    });

    it(`${name} exits 2 when the base URL does not answer within the liveness wait`, async () => {
      const port = await closedLoopbackPort();
      const r = await runProbe(name, ['--base-url', `http://127.0.0.1:${port}`, '--modules', stubModules], cleanEnv());
      assert.equal(r.code, 2, `stdout: ${r.stdout}`);
      assert.match(r.last, /^cannot answer: .*does not answer/);
    });

    it(`${name} exits 2 when no base URL is given`, async () => {
      const r = await runProbe(name, ['--modules', stubModules], cleanEnv());
      assert.equal(r.code, 2, `stdout: ${r.stdout}`);
      assert.match(r.last, /^cannot answer: .*--base-url/);
    });

    it(`${name} never prints a token it was given`, async () => {
      const secret = 'ythril_planted-secret-token-value-0123456789';
      const port = await closedLoopbackPort();
      const r = await runProbe(name, ['--base-url', `http://127.0.0.1:${port}`, '--modules', stubModules], cleanEnv({ YTHRIL_TOKEN: secret }));
      assert.equal(r.code, 2);
      assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'the token reached the probe output');
    });
  }
});

describe('route derivation reads the router, not a list', () => {
  const PLANTED = `
    import { Routes } from '@angular/router';
    // { path: 'commented-out', loadComponent: () => import('./x') },
    /* { path: 'also-commented', loadComponent: () => import('./y') }, */
    export const routes: Routes = guardEveryPage([
      { path: 'setup', canActivate: [setupGuard], loadComponent: () => import('./setup') },
      { path: 'login', title: 'a, b', loadComponent: () => import('./login') },
      { path: 'oidc-callback', loadComponent: () => import('./cb') },
      {
        path: '',
        loadComponent: () => import('./shell'),
        children: [
          { path: '', redirectTo: 'home', pathMatch: 'full' },
          { path: 'home', loadComponent: () => import('./home') },
          {
            path: 'area',
            loadComponent: () => import('./area'),
            children: [
              { path: '', redirectTo: 'one', pathMatch: 'full' },
              { path: 'one', loadComponent: () => import('./one') },
              { path: 'two/deep', loadComponent: () => import('./two') },
              { path: 'old', redirectTo: 'one', pathMatch: 'full' },
            ],
          },
          { path: 'gone', redirectTo: '/home', pathMatch: 'full' },
        ],
      },
      { path: '**', redirectTo: '' },
    ]);
  `;

  it('joins nested children and lists only pages, from a router written out by hand', () => {
    const { routes, skipped } = deriveRoutes(PLANTED);
    assert.deepEqual(routes, ['login', 'home', 'area/one', 'area/two/deep']);
    assert.deepEqual(skipped, { redirect: 4, wildcard: 1, setup: 1, oidcCallback: 1, layout: 2 });
  });

  it('does not let a comment add a route', () => {
    const { routes } = deriveRoutes(PLANTED);
    assert.ok(!routes.includes('commented-out') && !routes.includes('also-commented'));
  });

  it('reads a router whose strings hold `//` and braces', () => {
    const text = `export const routes = [ { path: 'a', title: 'x // y {', loadComponent: () => import('./a') }, { path: 'b', loadComponent: () => import('http://h/b') } ];`;
    assert.deepEqual(deriveRoutes(text).routes, ['a', 'b']);
  });

  it('refuses a source with no routes array rather than answering an empty list', () => {
    assert.throws(() => deriveRoutes('export const nothing = 1;'), /routes/i);
  });

  it('keeps a URL in a string when it strips comments', () => {
    assert.match(stripSourceComments(`const u = 'http://x.test/a'; // note`), /http:\/\/x\.test\/a/);
    assert.ok(!stripSourceComments(`const u = 1; // note`).includes('note'));
  });

  it('on the real router: the pages, none of the skipped kinds, and the count a second way agrees', () => {
    const source = readFileSync(join(REPO_ROOT, 'client/src/app/app.routes.ts'), 'utf8');
    const { routes, skipped } = readRoutes();
    for (const wanted of ['login', 'brain', 'files/conflicts', 'settings/tokens', 'settings/media-processing']) {
      assert.ok(routes.includes(wanted), `${wanted} is a page the router serves`);
    }
    for (const unwanted of ['setup', 'oidc-callback', '**', 'settings/models', 'settings/duplicates', '', 'settings']) {
      assert.ok(!routes.includes(unwanted), `${JSON.stringify(unwanted)} is not a page to scan`);
    }
    assert.ok(routes.length >= 10, `the router derives only ${routes.length} routes`);
    // Second way: every page and layout carries one loadComponent; take away the layouts, setup and the callback.
    const loaders = (stripComments(source).match(/loadComponent:/g) ?? []).length;
    assert.equal(routes.length, loaders - skipped.layout - skipped.setup - skipped.oidcCallback);
  });
});

describe('theme detection reads the styles with comments stripped', () => {
  it('a prefers-color-scheme media query means more than one scheme', () => {
    const r = detectThemes([{ file: 'a.scss', text: '@media (prefers-color-scheme: dark) { body { color: white; } }' }]);
    assert.equal(r.schemed, true);
    assert.ok(r.evidence.length > 0);
  });

  for (const selector of ["[data-theme='dark'] body {}", '[data-bs-theme="dark"] a {}', ':root.dark { --c: #000; }', 'html.theme-dark a {}']) {
    it(`a theme selector (${selector}) means more than one scheme`, () => {
      assert.equal(detectThemes([{ file: 'a.scss', text: selector }]).schemed, true);
    });
  }

  it('a query that is only commented out does not count', () => {
    const text = '/* @media (prefers-color-scheme: dark) { a {} } */\n// [data-theme="dark"] a {}\nbody { color: black; }';
    assert.equal(detectThemes([{ file: 'a.scss', text }]).schemed, false);
  });

  it('the planted positive control is seen, then the same text commented out is not', () => {
    const live = '@media (prefers-color-scheme: dark) { body { color: white; } }';
    assert.equal(detectThemes([{ file: 'a.css', text: live }]).schemed, true);
    assert.equal(detectThemes([{ file: 'a.css', text: `/*${live}*/` }]).schemed, false);
  });

  it('a stylesheet with no scheme rule says one theme', () => {
    const r = detectThemes([{ file: 'a.scss', text: 'body { color: #111; background: #fff; }' }]);
    assert.equal(r.schemed, false);
    assert.deepEqual(r.evidence, []);
  });

  it('refuses an empty listing rather than reporting one theme about nothing', () => {
    assert.throws(() => detectThemes([]), /no style/i);
  });

  it('the client styles it reads on the real tree are a scan, not an empty list', () => {
    const files = readClientStyleSources();
    assert.ok(files.length >= 20, `only ${files.length} client style files were read`);
    assert.ok(files.some((f) => f.file.endsWith('styles.scss')));
    assert.equal(typeof detectThemes(files).schemed, 'boolean');
  });
});

describe('no module the unit tests import loads playwright up front', () => {
  it('the probes and their module name playwright only through createRequire or a dynamic load', () => {
    const files = readTrackedSources('tools/flow-checks', { ext: ['.mjs'], floor: 4 });
    assert.ok(files.some((f) => f.file.endsWith('_axe.mjs')));
    for (const { file, text } of files) {
      const code = stripComments(text);
      assert.ok(!/^\s*import[^;]*from\s*['"](?:@axe-core\/)?playwright['"]/m.test(code), `${file} imports playwright at the top`);
      assert.ok(!/^\s*import\s*['"](?:@axe-core\/)?playwright['"]/m.test(code), `${file} imports playwright at the top`);
    }
  });
});

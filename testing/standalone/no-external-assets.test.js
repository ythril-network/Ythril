/**
 * The UI serves its own assets, and says whose they are.
 *
 * ## The failure this exists for — found by the Legal & Compliance audit lens
 *
 * `client/src/index.html` carried three lines fetching the Inter typeface from a public font CDN on every page
 * load:
 *
 *     <link rel="preconnect" href="https://fonts.googleapis.com" />
 *     <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
 *     <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap" … />
 *
 * Three problems, and the licence one is the least of them:
 *
 *  1. **It told a third party who was looking.** Every load of a SELF-HOSTED admin UI sent the operator's IP to a
 *     CDN. There was no CSP `font-src` to stop it, and `Referrer-Policy: no-referrer` hides the referring page,
 *     not the address.
 *  2. **It broke the offline promise the rest of the build keeps.** The image pre-downloads the embedding model
 *     *"so the container starts offline"*, and ships the docs because an air-gapped instance has *"no route to
 *     github.com"* — and then the UI asked the internet for its font.
 *  3. **The font was neither bundled nor attributed**, so the OFL notice it requires was absent.
 *
 * ## Why the existing NOTICE gate could not catch it
 *
 * `notice-coverage.test.js` walks the two workspaces' `dependencies`. A typeface fetched from a URL is not a
 * dependency, and neither is one checked in as four `.woff2` files — so a whole class of shipped, licensed
 * material sat outside every check. That is the gap this closes, in both directions: nothing is fetched from a
 * remote host, and anything vendored is attributed.
 *
 * Run: node --test testing/standalone/no-external-assets.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix, extname } from 'node:path';
import { requireInput } from '../_shared/absent-input.mjs';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Files the browser is handed directly, plus the global stylesheet that can pull in more. */
const CLIENT_ENTRYPOINTS = ['client/src/index.html', 'client/src/styles.scss'];

/**
 * A remote reference in a place that would make the BROWSER fetch something.
 *
 * Deliberately not "any http URL": a link in prose or a comment costs nothing, and a gate that flags those gets
 * silenced. This matches the shapes that actually issue a request — `src=`, `href=`, `url(…)` and `@import`.
 */
const REMOTE_FETCH = [
  /\bsrc\s*=\s*["']https?:\/\//i,
  /\bhref\s*=\s*["']https?:\/\//i,
  /\brel\s*=\s*["']preconnect["']/i,
  /\brel\s*=\s*["']dns-prefetch["']/i,
  /url\(\s*["']?https?:\/\//i,
  /@import\s+(?:url\()?["']https?:\/\//i,
];

/** Everything under a directory, recursively, as repo-relative posix paths. */
function walk(dir) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = posix.join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

describe('the client fetches no asset from a remote host', () => {
  it('found the entrypoints — the check has something to read', () => {
    for (const f of CLIENT_ENTRYPOINTS) {
      assert.ok(existsSync(join(ROOT, f)), `${f} is missing`);
      assert.ok(read(f).length > 200, `${f} looks empty`);
    }
  });

  it('index.html and the global stylesheet request nothing remote', () => {
    const bad = [];
    for (const f of CLIENT_ENTRYPOINTS) {
      read(f).split(/\r?\n/).forEach((line, i) => {
        // A comment cannot issue a request. Prose about the old links is the whole reason this fix is
        // understandable later, so it must not be what trips the gate.
        const code = line.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const re of REMOTE_FETCH) {
          if (re.test(code)) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 110)}`);
        }
      });
    }
    assert.deepEqual(bad, [], 'these make the browser fetch from a remote host. On a self-hosted admin UI that '
      + 'discloses every operator\'s IP to a third party, and on an air-gapped install it simply fails:\n  '
      + bad.join('\n  '));
  });

  it('a production build ships no remote asset reference either', (t) => {
    // The source being clean is not quite the same as the OUTPUT being clean — a build step could reintroduce one,
    // and an HTML comment survives the build (which is why the explanation for this fix lives in the SCSS).
    const dist = 'client/dist/browser/index.html';
    // No build to read: a skip on a laptop (the source checks above still ran), a FAILURE on CI. It used to return
    // quietly, so a job that never built the client passed the one check that reads what actually ships.
    if (!requireInput(t, existsSync(join(ROOT, dist)), `there is no built ${dist} to read`,
      'Run `npm run build:client` in the job that runs this file: the built index.html is what this case reads.')) return;
    const html = read(dist);
    for (const re of REMOTE_FETCH) {
      assert.ok(!re.test(html), `the built index.html still matches ${re}`);
    }
  });
});

describe('every vendored client asset is attributed', () => {
  const VENDORED = walk('client/src/assets');
  const notice = read('NOTICE');

  /** Binary/licensable asset extensions. Text like JSON translations is our own work. */
  const LICENSABLE = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

  it('found the vendored assets — the walk still works', () => {
    const licensable = VENDORED.filter(f => LICENSABLE.has(extname(f).toLowerCase()));
    assert.ok(licensable.length >= 4, `expected the bundled font files, found ${licensable.length}`);
    assert.ok(licensable.some(f => f.endsWith('.woff2')), 'no WOFF2 among the vendored assets');
  });

  it('the bundled typeface is named, licensed and sourced in NOTICE', () => {
    // Named, because the OFL requires the notice; sourced, because "which upstream release" is the only way to
    // refresh the files or answer a licence question later.
    assert.match(notice, /### Inter \(typeface\)/, 'NOTICE has no entry for the bundled typeface');
    assert.match(notice, /SIL Open Font License 1\.1/, 'the licence is not named');
    assert.match(notice, /@fontsource\/inter \d+\.\d+\.\d+/, 'the upstream release the files came from is not recorded');
    assert.match(notice, /client\/src\/assets\/fonts/, 'NOTICE does not say where in the tree the files are');
  });

  it('the provenance is recorded where a maintainer will look', () => {
    const deps = read('docs/dependencies.md');
    assert.match(deps, /## Vendored client assets/,
      'docs/dependencies.md has no section for assets that are not npm dependencies — the class the coverage test '
      + 'cannot see');
    assert.match(deps, /@fontsource\/inter/, 'the refresh path for the font files is not written down');
  });

  it('the CSP enforces it server-side', () => {
    // The source being clean is a promise; `font-src 'self'` is the enforcement. Without it, the next stray link
    // works exactly as the old one did.
    //
    // Matched inside the HEADER VALUE, not anywhere in the file. A first version matched the whole file and so was
    // satisfied by the comment above the directive explaining why the directive exists — a mutation test removing
    // the real thing left the gate green. The same fault as a doc link whose prose satisfies its own checker.
    const app = read('server/src/app.ts');
    const csp = app.match(/`frame-ancestors[^`]*`/);
    assert.ok(csp, 'could not find the CSP header value in server/src/app.ts');
    assert.match(csp[0], /font-src 'self'/, "the CSP header must carry font-src 'self'");
  });

  it('every place that quotes the CSP quotes the SAME one', () => {
    // Adding the directive broke an integration test that pins the header by equality — correctly, and it also
    // turned up THREE docs pages quoting the full policy verbatim. A header that is written out in five places
    // drifts in four of them, and a reader who checks the docs against a running instance finds a mismatch and
    // does not know which is wrong.
    //
    // So the source is the source, and everything that quotes it must quote it whole and identically.
    const app = read('server/src/app.ts');
    const directives = app.match(/`frame-ancestors \$\{frameAncestorsDirective\(\)\}([^`]*)`/);
    assert.ok(directives, 'could not parse the CSP directive tail from server/src/app.ts');
    const tail = directives[1].trim();           // "; object-src 'none'; base-uri 'self'; font-src 'self'"
    assert.ok(tail.length > 20, `the parsed CSP tail looks wrong: ${JSON.stringify(tail)}`);

    const quoters = [
      'testing/integration/setup.test.js',
      'docs/integration-guide/02-hosting.md',
      'docs/integration-guide/15-about-and-embedding.md',
      'docs/integration-guide/17-quotas-pagination-oidc.md',
    ];
    const stale = [];
    for (const f of quoters) {
      const text = read(f);
      // Each quoter writes `frame-ancestors …` followed by the same directive tail. Normalise whitespace only.
      if (!text.replace(/\s+/g, ' ').includes(tail.replace(/\s+/g, ' '))) stale.push(f);
    }
    assert.deepEqual(stale, [], 'these quote the CSP but not the current directive set. The header in '
      + `server/src/app.ts ends with:\n  ${tail}\n\nStale:\n  ${stale.join('\n  ')}`);
  });
});

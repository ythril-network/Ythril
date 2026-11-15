/**
 * The one module under the three accessibility probes: it loads axe-core through Playwright from a folder outside the repository, scans the
 * client's routes against a running Ythril, and answers `holds:`, `violated:` or `cannot answer:`.
 *
 * ## What it prevents (Q-792)
 *
 * The accessibility lens names three checks that run axe-core on Ythril's pages. Ythril had no probe for any of them, so project-check answered
 * every one "cannot answer" and the lens was never run. These probes make the three checks real, and keep the three answers honest:
 *
 * - **Never a pass about nothing.** No module folder, no base URL, a base URL that does not answer within 5 s, a browser that does not start, a
 *   route that lands on another page (the login page, when no token was given) are all "cannot answer" (exit 2). A violation found on the pages
 *   that WERE reached is still "violated": a defect is a defect whatever else could not be reached.
 * - **The routes are the router's.** `client/src/app/app.routes.ts` is read (not listed here): nested children are joined, redirects, the `**`
 *   catch-all, `setup` and `oidc-callback` are skipped, and a layout route (one with children) is not a page. A new route is scanned without
 *   an edit here, and the deep scan asserts its scanned count equals the derived count.
 * - **The themes are the styles'.** A `prefers-color-scheme` media query or a theme selector in the client's styles (comments stripped) means
 *   both colour schemes are scanned and the computed page colours must differ between them; none means one scan, said as "one theme".
 * - **The token is never shown.** It comes from `YTHRIL_TOKEN` only, is written as `localStorage.ythril_token` (the key
 *   `client/src/app/core/auth.service.ts` reads) only on a page whose origin is the base URL's origin, and is redacted from every line printed.
 *
 * ## Licence
 *
 * axe-core is MPL-2.0 and `docs/contribution-guide.md` keeps copyleft out of the application dependency tree, so neither it nor
 * `@axe-core/playwright` nor `playwright` is in any package.json. They are loaded with `createRequire` from `--modules <folder>` or the
 * `AXE_MODULES` environment variable, and a missing folder is exit 2.
 *
 * ## Run
 *
 *     node tools/flow-checks/check-i-accessibility-i18n-deep-automated-scan.mjs --base-url http://127.0.0.1:3200 --modules <folder>
 *
 * with `YTHRIL_TOKEN` in the environment for the routes behind sign-in. Browsers come from `PLAYWRIGHT_BROWSERS_PATH`. Nothing at the top of this
 * file loads playwright, so the unit test imports it without a browser installed.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The probe could not read what it needs: it answers `cannot answer:` (exit 2), never a verdict. */
export class CannotAnswer extends Error {}

/** The key the client reads its token from (`client/src/app/core/auth.service.ts`). */
export const TOKEN_STORAGE_KEY = 'ythril_token';

/** How long the base URL has to answer before the probe gives up. */
export const LIVENESS_MS = 5_000;

const PAGE_LOAD_MS = 20_000;
const SETTLE_MS = 8_000;
const ANALYZE_MS = 60_000;

/* ───────────────────────────── comments ───────────────────────────── */

/**
 * Comments out, every comment character replaced by a space so offsets and lines stay. String-aware (single, double and template quotes), so a
 * `'//'` or a `'/*'` inside a string is code; a `//` right after a colon (an unquoted `url(http://...)`) is not a comment.
 */
export function stripSourceComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (two === '//' && text[i - 1] !== ':') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = n;
      out += blank(text.slice(i, j));
      i = j;
    } else if (two === '/*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      out += blank(text.slice(i, j));
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/* ───────────────────────────── routes ───────────────────────────── */

/** Where the router lives, found from this file and not from the caller's cwd. */
export const ROUTES_FILE = join(REPO_ROOT, 'client', 'src', 'app', 'app.routes.ts');

/** Split the contents of a bracket group opened at `open` on its top-level commas; returns the pieces and the index after the closing bracket. */
function splitGroup(code, open) {
  const pieces = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        pieces.push(code.slice(start, i));
        return { pieces: pieces.map((p) => p.trim()).filter(Boolean), end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      pieces.push(code.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  throw new CannotAnswer('the routes array is not closed: the router file could not be read');
}

/** The properties of one `{ ... }` route object, as { key: value text }. */
function routeProperties(element) {
  const { pieces } = splitGroup(element, 0);
  const props = {};
  for (const piece of pieces) {
    const m = /^(\w+)\s*(?::([\s\S]*))?$/.exec(piece);
    if (m) props[m[1]] = (m[2] ?? '').trim();
  }
  return props;
}

const unquote = (s) => {
  const m = /^(['"`])([\s\S]*)\1$/.exec(s ?? '');
  return m ? m[2] : null;
};

/**
 * The pages the router serves, read from its source.
 *
 * @param {string} text the text of `app.routes.ts`
 * @returns {{ routes: string[], skipped: { redirect: number, wildcard: number, setup: number, oidcCallback: number, layout: number } }}
 *   `routes` are paths without a leading slash, nested children joined; `skipped` counts each kind left out
 */
export function deriveRoutes(text) {
  const code = stripSourceComments(text);
  const decl = /\broutes\s*(?::\s*Routes\s*)?=\s*/.exec(code);
  if (!decl) throw new CannotAnswer('no routes array found in the router file');
  const open = code.indexOf('[', decl.index + decl[0].length);
  if (open === -1) throw new CannotAnswer('no routes array found in the router file');
  const routes = [];
  const skipped = { redirect: 0, wildcard: 0, setup: 0, oidcCallback: 0, layout: 0 };

  const walk = (arrayOpen, prefix, source) => {
    for (const element of splitGroup(source, arrayOpen).pieces) {
      if (!element.startsWith('{')) throw new CannotAnswer(`a route entry the reader does not understand: ${element.slice(0, 40)}`);
      const props = routeProperties(element);
      if ('loadChildren' in props) throw new CannotAnswer('the router uses loadChildren, which this reader does not follow: its routes would be missed');
      const segment = unquote(props.path) ?? '';
      const full = [prefix, segment].filter(Boolean).join('/');
      if (segment === '**') skipped.wildcard += 1;
      else if ('redirectTo' in props) skipped.redirect += 1;
      else if (full === 'setup') skipped.setup += 1;
      else if (full === 'oidc-callback') skipped.oidcCallback += 1;
      else if ('children' in props) {
        skipped.layout += 1;
        walk(0, full, props.children);
      } else routes.push(full);
    }
  };
  walk(open, '', code);
  if (routes.length === 0) throw new CannotAnswer('the router file derives no routes');
  return { routes, skipped };
}

/** The real router's pages. */
export function readRoutes() {
  return deriveRoutes(readFileSync(ROUTES_FILE, 'utf8'));
}

/* ───────────────────────────── themes ───────────────────────────── */

const SCHEME_PATTERNS = [
  { name: 'a prefers-color-scheme media query', re: /@media[^{;]*prefers-color-scheme/ },
  { name: 'a [data-theme] selector', re: /\[\s*data-(?:bs-)?theme\b/ },
  { name: 'a root or body dark/light class', re: /(?::root|html|body)\.(?:theme-)?(?:dark|light)\b/ },
  { name: 'a theme-dark or theme-light class', re: /\.theme-(?:dark|light)\b/ },
  { name: 'a dark-mode or dark-theme class', re: /\.(?:dark|light)-(?:theme|mode)\b/ },
];

/**
 * Does the client style itself for more than one colour scheme?
 *
 * @param {{ file: string, text: string }[]} files the client's style sources
 * @returns {{ schemed: boolean, evidence: string[] }} `evidence` names the file and the kind of rule found
 */
export function detectThemes(files) {
  if (!Array.isArray(files) || files.length === 0) throw new CannotAnswer('no style files were read: one theme would be a claim about nothing');
  const evidence = [];
  for (const { file, text } of files) {
    const code = stripSourceComments(text);
    for (const { name, re } of SCHEME_PATTERNS) if (re.test(code)) evidence.push(`${file}: ${name}`);
  }
  return { schemed: evidence.length > 0, evidence };
}

/** The client's tracked stylesheets and TypeScript (inline component styles), read through git so an ignored file is not scanned. */
export function readClientStyleSources(root = REPO_ROOT) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', 'client/src'], { cwd: root, timeout: 10_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new CannotAnswer(`git could not list client/src: ${String(e.message).split('\n')[0]}`);
  }
  const files = listed.split('\0').filter((f) => /\.(?:scss|sass|css|ts)$/.test(f) && !f.endsWith('.d.ts'));
  if (files.length < 20) throw new CannotAnswer(`only ${files.length} client style or source files were listed: the scan is broken`);
  return files.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
}

/* ───────────────────────────── arguments, modules, liveness ───────────────────────────── */

/** `--base-url` and `--modules` (also `--flag=value`), the module folder from `AXE_MODULES`, the token from `YTHRIL_TOKEN` only. */
export function parseFlags(argv, env) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(base-url|modules)(?:=(.*))?$/.exec(argv[i]);
    if (m) flags[m[1]] = m[2] ?? argv[++i];
  }
  return {
    baseUrl: flags['base-url'] || '',
    modules: flags.modules || env.AXE_MODULES || '',
    token: env.YTHRIL_TOKEN || '',
  };
}

/** playwright and @axe-core/playwright from `dir` (a node_modules folder, or the folder that holds one). */
export function loadModules(dir) {
  if (!dir) throw new CannotAnswer('no modules folder: pass --modules <folder holding playwright and @axe-core/playwright> or set AXE_MODULES');
  const req = createRequire(join(resolve(dir), 'noop.js'));
  try {
    const { chromium } = req('playwright');
    const axe = req('@axe-core/playwright');
    const AxeBuilder = axe.AxeBuilder ?? axe.default;
    if (!chromium || !AxeBuilder) throw new Error('the packages loaded but export no chromium or AxeBuilder');
    return { chromium, AxeBuilder };
  } catch (e) {
    throw new CannotAnswer(`playwright and @axe-core/playwright cannot be loaded from ${resolve(dir)}: ${String(e.message).split('\n')[0]}`);
  }
}

/** Any HTTP answer within {@link LIVENESS_MS} counts as alive; no answer is exit 2. */
export async function assertAlive(baseUrl) {
  try {
    await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(LIVENESS_MS) });
  } catch (e) {
    throw new CannotAnswer(`${baseUrl} does not answer within ${LIVENESS_MS / 1000} s (${e.cause?.code ?? e.name})`);
  }
}

const withTimeout = (promise, ms, what) => new Promise((resolveP, rejectP) => {
  const timer = setTimeout(() => rejectP(new CannotAnswer(`${what} took longer than ${ms / 1000} s`)), ms);
  promise.then((v) => { clearTimeout(timer); resolveP(v); }, (e) => { clearTimeout(timer); rejectP(e); });
});

/* ───────────────────────────── scanning ───────────────────────────── */

/**
 * Visit every route in each scheme and run `analyze(page)` on the ones that were reached.
 *
 * @param {object} ctx from {@link axeProbe}
 * @param {{ schemes: string[], analyze: (page: object) => Promise<object> }} how
 * @returns {Promise<{ scans: {route: string, scheme: string, result: object}[], unreached: {route: string, scheme: string, landed: string}[], colours: Record<string, string> }>}
 *   `unreached` are routes whose URL ended elsewhere (the login page, without a token); `colours` is the body's computed colour and background per scheme
 */
export async function scanPages(ctx, { schemes, analyze }) {
  let browser;
  try {
    browser = await ctx.modules.chromium.launch();
  } catch (e) {
    throw new CannotAnswer(`the browser did not start: ${String(e.message).split('\n')[0]} (PLAYWRIGHT_BROWSERS_PATH names where the browsers are)`);
  }
  const scans = [];
  const unreached = [];
  const colours = {};
  try {
    for (const scheme of schemes) {
      const context = await browser.newContext({ colorScheme: scheme });
      if (ctx.token) {
        // The origin test runs in the page: a redirect to another host never gets the token.
        await context.addInitScript(({ origin, token, key }) => {
          if (location.origin === origin) {
            try { localStorage.setItem(key, token); } catch { /* storage blocked: the page then asks for sign-in */ }
          }
        }, { origin: ctx.origin, token: ctx.token, key: TOKEN_STORAGE_KEY });
      }
      try {
        for (const route of ctx.routes) {
          const page = await context.newPage();
          try {
            await page.goto(`${ctx.origin}/${route}`, { waitUntil: 'load', timeout: PAGE_LOAD_MS });
            await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
            await page.waitForTimeout(300);
            const landed = new URL(page.url()).pathname.replace(/\/+$/, '');
            if (landed !== `/${route}`) {
              unreached.push({ route, scheme, landed: landed || '/' });
              continue;
            }
            if (!(scheme in colours)) {
              colours[scheme] = await page.evaluate(() => {
                const s = getComputedStyle(document.body);
                return `${s.color} on ${s.backgroundColor}`;
              });
            }
            scans.push({ route, scheme, result: await withTimeout(analyze(page), ANALYZE_MS, `axe on /${route}`) });
          } finally {
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { scans, unreached, colours };
}

/** One printed line per violation: scheme, route, rule, impact, node count and the first target. */
export function violationLines(scans, only = null) {
  const lines = [];
  for (const { route, scheme, result } of scans) {
    for (const v of result.violations ?? []) {
      if (only && !only.includes(v.id)) continue;
      const first = v.nodes?.[0]?.target?.join(' ') ?? '';
      lines.push(`violation [${scheme}] /${route}: ${v.id} (${v.impact ?? 'n/a'}) ${v.nodes?.length ?? 0} node(s), first ${first.slice(0, 120)}`);
    }
  }
  return lines;
}

/**
 * An `analyze` for {@link scanPages}: axe on the page as `configure` sets it up, trimmed to what is reported (rule, impact, targets), plus the
 * strings `extra(page)` returns, each one a violation of its own.
 *
 * @param {object} ctx from {@link axeProbe}
 * @param {(builder: object) => object} configure `builder.withRules([...])` or `.withTags([...])`
 * @param {(page: object) => Promise<string[]>} [extra]
 */
export function axeAnalyzer(ctx, configure, extra = async () => []) {
  return async (page) => {
    const r = await configure(new ctx.modules.AxeBuilder({ page })).analyze();
    return {
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => ({ target: n.target })) })),
      incomplete: r.incomplete.length,
      passes: r.passes.length,
      extraViolations: await extra(page),
    };
  };
}

/**
 * The verdict a scan earns. A violation is "violated" whatever else could not be reached; "holds" needs every route scanned in every scheme.
 *
 * @param {object} ctx from {@link axeProbe}
 * @param {Awaited<ReturnType<typeof scanPages>>} scanned
 * @param {{ what: string }} how `what` names what was asked, for the verdict text
 */
export function judgeScan(ctx, scanned, { what }) {
  const { scans, unreached, colours } = scanned;
  const lines = violationLines(scans);
  for (const { route, scheme, result } of scans) {
    for (const s of result.extraViolations ?? []) lines.push(`violation [${scheme}] /${route}: ${s}`);
  }
  const problem = sameColoursProblem(colours, ctx.schemes);
  if (problem) lines.push(`violation: ${problem}`);
  const total = ctx.routes.length * ctx.schemes.length;
  const missed = unreachedClause(unreached, total, Boolean(ctx.token));
  const themesSaid = ctx.themes.schemed ? 'light and dark' : 'one theme';
  if (lines.length > 0) {
    const counts = {};
    for (const l of lines) {
      const key = /: ([\w-]+) \(/.exec(l)?.[1] ?? (l.startsWith('violation:') ? 'scheme' : 'markup');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(', ');
    return { verdict: 'violated', text: `${lines.length} violation(s) in ${what} (${summary}) over ${scans.length} of ${total} route scan(s), ${themesSaid}${missed ? `; ${missed}` : ''}`, lines };
  }
  if (scans.length !== total || missed) {
    throw new CannotAnswer(`${what} scanned ${scans.length} of ${total} route scan(s) (${ctx.routes.length} routes derived from the router, ${ctx.themes.schemed ? 2 : 1} scheme(s))${missed ? `: ${missed}` : ''}`);
  }
  const incomplete = scans.reduce((n, s) => n + (s.result.incomplete ?? 0), 0);
  return { verdict: 'holds', text: `${what} found nothing on ${ctx.routes.length} route(s), ${themesSaid} (${incomplete} item(s) axe could not decide)`, lines: [] };
}

/** Say why some routes were not reached, in one clause. */
export function unreachedClause(unreached, total, hasToken) {
  if (unreached.length === 0) return '';
  const landed = [...new Set(unreached.map((u) => u.landed))].join(', ');
  return `${unreached.length} of ${total} route scan(s) did not reach their page (landed on ${landed}${hasToken ? '' : '; no YTHRIL_TOKEN was given'})`;
}

/**
 * Do the two schemes paint the page differently? Both colour readings are the body's computed colour and background.
 * @returns {string|null} a sentence when they are the same, null when they differ
 */
export function sameColoursProblem(colours, schemes) {
  if (schemes.length < 2) return null;
  const seen = schemes.map((s) => colours[s]);
  if (seen.some((c) => c === undefined)) return null;
  return seen.every((c) => c === seen[0]) ? `the styles declare a colour scheme rule but the page paints the same in ${schemes.join(' and ')} (${seen[0]})` : null;
}

/* ───────────────────────────── the probe frame ───────────────────────────── */

/**
 * Run a probe: arguments, modules, liveness, routes, themes, then `answer(ctx)`, and print the verdict as the last stdout line.
 *
 * @param {(ctx: object) => Promise<{ verdict: 'holds'|'violated', text: string, lines?: string[] }>} answer
 *   throws {@link CannotAnswer} for what it could not ask; `lines` are printed before the verdict line
 *   `ctx` = { origin, modules, token, routes, skipped, themes: { schemed, evidence }, schemes, say }
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [io]
 */
export async function axeProbe(answer, { argv = process.argv.slice(2), env = process.env } = {}) {
  const { baseUrl, modules, token } = parseFlags(argv, env);
  const redact = (s) => (token ? String(s).split(token).join('[token]') : String(s));
  const say = (line) => process.stdout.write(`${redact(line)}\n`);
  let kind = 'cannot answer';
  let code = 2;
  let text = '';
  try {
    if (!baseUrl) throw new CannotAnswer('no --base-url: say which running Ythril to scan');
    let origin;
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http');
      origin = u.origin;
    } catch {
      throw new CannotAnswer(`--base-url is not an http(s) URL: ${redact(baseUrl)}`);
    }
    const loaded = loadModules(modules);
    await assertAlive(origin);
    const { routes, skipped } = readRoutes();
    const themes = detectThemes(readClientStyleSources());
    const schemes = themes.schemed ? ['light', 'dark'] : ['light'];
    const verdict = await answer({ origin, modules: loaded, token, routes, skipped, themes, schemes, say });
    for (const line of verdict.lines ?? []) say(line);
    kind = verdict.verdict;
    code = kind === 'holds' ? 0 : 1;
    text = verdict.text;
  } catch (e) {
    text = e instanceof CannotAnswer ? e.message : `the probe failed before it could ask: ${e?.message ?? e}`;
  }
  await new Promise((done) => process.stdout.write(`${redact(`${kind}: ${text}`)}\n`, done));
  process.exit(code);
}

/**
 * The nine deep-lens flow-check probes that need no stack decide from the repository, and a planted copy of each defect fails them.
 *
 * ## The failure this prevents (Q-917, YF-123)
 *
 * `check-i-security-deep-guards-fail-closed`, `check-i-integration-deep-parameters-match-both-doors`, `check-i-performance-deep-caps-match-both-doors`,
 * `check-i-testing-visual-regression`, `check-i-ux-deep-route-set-derived`, `check-i-docs-deep-pages-older-than-their-code`,
 * `check-i-accessibility-i18n-deep-untranslated-and-unused`, `check-i-performance-client-bundle-and-rendering` and
 * `check-i-observability-measurement-records-carry-their-context` are named by the loop's audit lenses. Ythril had a placeholder for each, so
 * `project-check.mjs` answered "cannot answer" and each was judged by reading, every bundle. Each is decided by the code after all (the design of
 * Q-917 sorted them out of the checks that need a stack), and a probe now answers it:
 *
 * - guards fail closed: every guard of the server's `auth/` folder (derived from its declarations) is called with an empty, a missing and an
 *   undefined policy and denies.
 * - parameters and caps match: a tool and its route take the same keys, requiredness, enums, defaults, floors and caps.
 * - visual regression: an image-comparing test exists and its list covers every route of the router.
 * - route set derived: a browser sweep reads its routes from the router, never a written list.
 * - pages older than their code: a page whose code moved after it did was read.
 * - i18n: untranslated and unused keys stay at or under a recorded ceiling.
 * - bundle and rendering: budgets exist and are met, pages load lazily, a search box that asks is debounced.
 * - measurement records: every store declares outcome, scope, layout version, re-run key and an end marker.
 *
 * Each rule is proven on a planted copy of the defect taken from the repository's own data (a real route's keys with one taken out, a real
 * guard stubbed to fail open, a real router with an eager page, a real sweep with its list, a real store's schema with a field dropped), and on
 * the real repository, which must answer without "cannot answer". Nothing here names a route, a tool or a key of the repository: each is picked
 * from the registries and the files, so this file is not itself a test that names a surface for the contract-tests probe.
 *
 * The probes of the first three read the build (`server/dist`): run `npm run build:server` first. The bundle probe measures `client/dist` when a
 * client build exists and says "cannot answer" when it does not; both answers are asserted.
 *
 * Run: node --test testing/standalone/the-deep-flow-probes-decide-from-the-code.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { REPO_ROOT, isTestFile } from './_sources.mjs';
import { readRoutes } from '../../tools/flow-checks/_axe.mjs';
import { allowFileFor, readAllow } from '../../tools/flow-checks/_allow.mjs';
import * as ux from '../../tools/flow-checks/check-i-ux-deep-route-set-derived.mjs';
import * as visual from '../../tools/flow-checks/check-i-testing-visual-regression.mjs';
import * as docs from '../../tools/flow-checks/check-i-docs-deep-pages-older-than-their-code.mjs';
import * as i18n from '../../tools/flow-checks/check-i-accessibility-i18n-deep-untranslated-and-unused.mjs';
import * as bundle from '../../tools/flow-checks/check-i-performance-client-bundle-and-rendering.mjs';
import * as measure from '../../tools/flow-checks/check-i-observability-measurement-records-carry-their-context.mjs';
import * as params from '../../tools/flow-checks/check-i-integration-deep-parameters-match-both-doors.mjs';
import * as caps from '../../tools/flow-checks/check-i-performance-deep-caps-match-both-doors.mjs';
import * as guards from '../../tools/flow-checks/check-i-security-deep-guards-fail-closed.mjs';
import * as doorPairs from '../../tools/flow-checks/_door-pairs.mjs';
import { attributeFindings, keyFindings, CAP_KEYS, FLOOR_KEYS } from '../../tools/flow-checks/_door-pairs.mjs';

const TODAY = '2026-11-18';
const sound = (id) => ({ id, reason: 'a reason of more than twenty characters', reviewBy: '2027-02-17' });
const allowOf = (mod) => readAllow(allowFileFor(mod));
const probe = (name) => join(REPO_ROOT, 'tools', 'flow-checks', `${name}.mjs`);
const run = (name, args = []) => {
  const r = spawnSync(process.execPath, [probe(name), ...args], { encoding: 'utf8', env: testChildEnv({}, process.env), cwd: REPO_ROOT, timeout: 240_000 });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { code: r.status, last: lines[lines.length - 1] };
};
const decideOf = (mod, ...args) => mod.decide(...args);

describe('every probe of the group answers on the repository', () => {
  for (const name of [
    'check-i-security-deep-guards-fail-closed', 'check-i-integration-deep-parameters-match-both-doors', 'check-i-performance-deep-caps-match-both-doors',
    'check-i-testing-visual-regression', 'check-i-ux-deep-route-set-derived', 'check-i-accessibility-i18n-deep-untranslated-and-unused',
    'check-i-observability-measurement-records-carry-their-context',
  ]) {
    it(`${name} holds`, () => {
      const r = run(name);
      assert.equal(r.code, 0, r.last);
      assert.match(r.last, /^holds: /);
    });
  }

  it('check-i-docs-deep-pages-older-than-their-code cannot answer without a read list, holds with the stale pages in it, and is violated with an empty one', () => {
    const none = run('check-i-docs-deep-pages-older-than-their-code');
    assert.equal(none.code, 2, none.last);
    assert.match(none.last, /^cannot answer: \d+ page\(s\) are older than their code and the run named no read list/);
    const dir = mkdtempSync(join(tmpdir(), 'b343-docs-'));
    try {
      const { stale } = docs.realInput();
      writeFileSync(join(dir, 'read.txt'), stale.map((s) => s.page).join('\n'));
      const full = run('check-i-docs-deep-pages-older-than-their-code', ['--read', join(dir, 'read.txt')]);
      assert.equal(full.code, 0, full.last);
      assert.match(full.last, /^holds: every page older than its code was read/);
      writeFileSync(join(dir, 'empty.txt'), '');
      const empty = run('check-i-docs-deep-pages-older-than-their-code', ['--read', join(dir, 'empty.txt')]);
      assert.equal(empty.code, 1, empty.last);
      assert.ok(empty.last.includes(stale[0].page), empty.last);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('check-i-performance-client-bundle-and-rendering answers from the client build when there is one, and cannot answer, naming the build command, when there is not', () => {
    const r = run('check-i-performance-client-bundle-and-rendering');
    const built = bundle.realInput().dist !== null;
    if (built) {
      assert.equal(r.code, 0, r.last);
      assert.match(r.last, /^holds: /);
    } else {
      assert.equal(r.code, 2, r.last);
      assert.match(r.last, /^cannot answer: no client build to measure: run npm run build:client/);
    }
  });
});

describe('check-i-ux-deep-route-set-derived', () => {
  const input = ux.realInput();
  const allow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-ux-deep-route-set-derived.mjs'));
  const listOf = (routes, n) => `const PAGES = [${routes.slice(0, n).map((r) => `'/${r}'`).join(', ')}];\nfor (const p of PAGES) await page.goto(BASE + p);\n`;

  it('holds on the repository with the sweeps it excepts, and says how many routes the router serves', () => {
    const v = decideOf(ux, input, allow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${input.routes.length} routes derived from the router`));
  });

  it('is violated by a sweep the repository holds, with no exception (its own written list)', () => {
    const v = decideOf(ux, input, [], TODAY);
    assert.equal(v.holds, false);
    for (const e of allow) assert.ok(v.reason.includes(e.id), `${e.id}: ${v.reason}`);
  });

  it('is violated when a new script drives the browser over a written list of the router\'s routes, and holds when it reads the router', () => {
    const planted = [...input.scripts, { file: 'testing/planted-sweep.mjs', text: listOf(input.routes, 4) }];
    const v = decideOf(ux, { ...input, scripts: planted }, allow, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /testing\/planted-sweep\.mjs/);
    const derived = [...input.scripts, { file: 'testing/planted-sweep.mjs', text: `${listOf(input.routes, 4)}const routes = readRoutes().routes;\n` }];
    assert.equal(decideOf(ux, { ...input, scripts: derived }, allow, TODAY).holds, true);
  });

  it('is not a list when the script names fewer routes than the floor, or names paths the router does not serve', () => {
    const two = [...input.scripts, { file: 'testing/planted-sweep.mjs', text: listOf(input.routes, ux.LIST_FLOOR - 1) }];
    assert.equal(decideOf(ux, { ...input, scripts: two }, allow, TODAY).holds, true);
    const strangers = [...input.scripts, { file: 'testing/planted-sweep.mjs', text: `const PAGES = ['/no-such-1', '/no-such-2', '/no-such-3', '/no-such-4'];\nawait page.goto(x);\n` }];
    assert.equal(decideOf(ux, { ...input, scripts: strangers }, allow, TODAY).holds, true);
  });

  it('refuses a router it could not read and a listing with no browser script (cannot answer, never a pass)', () => {
    assert.throws(() => decideOf(ux, { ...input, routes: input.routes.slice(0, 3) }, allow, TODAY), /router/);
    assert.throws(() => decideOf(ux, { ...input, scripts: input.scripts.filter((s) => !/\.goto\(/.test(s.text)) }, allow, TODAY), /no tracked script drives the client/);
  });

  it('refuses an exception with no reason, past its date, or that excuses nothing', () => {
    const [first] = allow;
    assert.equal(decideOf(ux, input, [{ id: first.id, reviewBy: '2027-02-17' }, ...allow.slice(1)], TODAY).holds, false);
    assert.match(decideOf(ux, input, [{ ...first, reviewBy: '2026-01-01' }, ...allow.slice(1)], TODAY).reason, /past its reviewBy/);
    assert.match(decideOf(ux, input, [...allow, sound('testing/no-such-sweep.mjs')], TODAY).reason, /excuses nothing/);
  });
});

describe('check-i-testing-visual-regression', () => {
  const input = visual.realInput();
  const allow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-testing-visual-regression.mjs'));
  const coverTest = (routes) => `import { test, expect } from '@playwright/test';\n${routes.map((r) => `test('/${r}', async ({ page }) => { await page.goto('/${r}'); await expect(page).toHaveScreenshot(); });`).join('\n')}\n`;

  it('reports the missing config as one finding, excused on the repository, and says how many routes the router serves', () => {
    const open = decideOf(visual, input, [], TODAY);
    assert.equal(open.holds, false);
    assert.match(open.reason, /no tracked test compares a screenshot with a baseline/);
    const v = decideOf(visual, input, allow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${input.routes.length} routes derived from the router, 1 exception`));
  });

  it('is violated for each route no visual test names, once a config exists (a visual test over all routes but one)', () => {
    const last = input.routes[input.routes.length - 1];
    const sources = [...input.sources, { file: 'e2e/visual.spec.ts', text: coverTest(input.routes.slice(0, -1)) }];
    const v = decideOf(visual, { ...input, sources }, [], TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, new RegExp(`no visual test covers the route /${last}\\b`));
    assert.match(v.reason, /1 gap\(s\)/);
  });

  it('holds when the visual tests name every route, or read the router', () => {
    const all = [...input.sources, { file: 'e2e/visual.spec.ts', text: coverTest(input.routes) }];
    assert.equal(decideOf(visual, { ...input, sources: all }, [], TODAY).holds, true);
    const reads = [...input.sources, { file: 'e2e/visual.spec.ts', text: `${coverTest([input.routes[0]])}const all = readRoutes().routes;\n` }];
    assert.equal(decideOf(visual, { ...input, sources: reads }, [], TODAY).holds, true);
  });

  it('counts a visual-regression dependency or a snapshot folder as a config, so every route is then uncovered', () => {
    const dep = [...input.sources, { file: 'package.json', text: '{ "devDependencies": { "@percy/cli": "1.0.0" } }' }];
    const v = decideOf(visual, { ...input, sources: dep }, [], TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, new RegExp(`${input.routes.length} gap\\(s\\)`));
    const folder = decideOf(visual, { ...input, allFiles: [...input.allFiles, 'e2e/home.spec.ts-snapshots/a.png'] }, [], TODAY);
    assert.match(folder.reason, new RegExp(`${input.routes.length} gap\\(s\\)`));
  });

  it('does not take a mention of the matcher in a comment for a visual test', () => {
    const sources = [...input.sources, { file: 'e2e/notes.spec.ts', text: '// toHaveScreenshot() is what we should use\n/* pixelmatch( a, b ) */\n' }];
    assert.match(decideOf(visual, { ...input, sources }, [], TODAY).reason, /no tracked test compares a screenshot/);
  });

  it('refuses an exception for a config that now exists (it excuses nothing), and an unread router', () => {
    const sources = [...input.sources, { file: 'e2e/visual.spec.ts', text: coverTest(input.routes) }];
    assert.match(decideOf(visual, { ...input, sources }, allow, TODAY).reason, /excuses nothing/);
    assert.throws(() => decideOf(visual, { ...input, routes: [] }, allow, TODAY), /router/);
    assert.equal(decideOf(visual, input, [{ id: allow[0].id, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideOf(visual, input, [{ ...allow[0], reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
  });
});

describe('check-i-docs-deep-pages-older-than-their-code', () => {
  const { pages, world } = docs.realWorld();
  const sourceMap = docs.sourcesOfPages(pages, world);

  it('reads what a page names: a route it prints is the file that mounts it, a tool in backticks its tool file, a tracked path itself', () => {
    const withRoute = [...sourceMap].find(([, s]) => [...s].some((f) => [...world.routeFiles.values()].includes(f)));
    assert.ok(withRoute, 'no page names a route the server mounts');
    const withTool = [...sourceMap].find(([, s]) => [...s].some((f) => [...world.tools.values()].includes(f)));
    assert.ok(withTool, 'no page names a tool');
    assert.ok([...sourceMap.values()].filter((s) => s.size).length >= 5);
    for (const [, s] of sourceMap) for (const f of s) assert.ok(!f.endsWith('.md') && !isTestFile(f), `${f} is not the code a page describes`);
  });

  it('is violated when a real page is older than the file it names, unless it was read (the real page and source with planted dates)', () => {
    const [page, sources] = [...sourceMap].find(([, s]) => s.size);
    const [source] = sources;
    const dates = new Map([[page, '2026-01-01'], [source, '2026-06-01']]);
    const stale = docs.stalePages(new Map([[page, sources]]), dates);
    assert.deepEqual(stale.map((s) => s.page), [page]);
    const input = { stale, pages: pages.length, withSource: 9 };
    const v = docs.decide(input, new Set());
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(page), v.reason);
    assert.equal(docs.decide(input, new Set([page])).holds, true);
    assert.throws(() => docs.decide(input, null), /--read/);
  });

  it('holds when the page is as new as, or newer than, its code, and for a page with no dated source', () => {
    const [page, sources] = [...sourceMap].find(([, s]) => s.size);
    const [source] = sources;
    assert.deepEqual(docs.stalePages(new Map([[page, sources]]), new Map([[page, '2026-06-01'], [source, '2026-06-01']])), []);
    assert.deepEqual(docs.stalePages(new Map([[page, sources]]), new Map([[page, '2026-07-01'], [source, '2026-06-01']])), []);
    assert.deepEqual(docs.stalePages(new Map([[page, sources]]), new Map([[page, '2026-01-01']])), []);
  });

  it('dates a file by its newest commit from one git log pass, newest first', () => {
    const dates = docs.lastCommitDates('@2026-03-01\nfoo.md\nbar.ts\n\n@2026-02-01\nfoo.md\n\n@2026-01-01\nbaz.ts\n');
    assert.equal(dates.get('foo.md'), '2026-03-01');
    assert.equal(dates.get('bar.ts'), '2026-03-01');
    assert.equal(dates.get('baz.ts'), '2026-01-01');
  });

  it('cannot answer when the pages or their sources were not read', () => {
    assert.throws(() => docs.decide({ stale: [], pages: 3, withSource: 9 }, null), /documentation pages/);
    assert.throws(() => docs.decide({ stale: [], pages: 60, withSource: 1 }, null), /name a route, tool or file/);
  });
});

describe('check-i-accessibility-i18n-deep-untranslated-and-unused', () => {
  const input = i18n.realInput();
  const ceilings = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-accessibility-i18n-deep-untranslated-and-unused.mjs'));
  const others = Object.keys(input.dicts).filter((l) => l !== input.source);
  const withDict = (locale, change) => ({ ...input, dicts: { ...input.dicts, [locale]: change({ ...input.dicts[locale] }) } });
  const translatedKey = (locale) => Object.keys(input.dicts[locale]).find((k) => input.dicts[locale][k] !== input.dicts[input.source][k] && /\p{L}/u.test(input.dicts[input.source][k]));

  it('reads the source locale from the client configuration and the locales from the files', () => {
    assert.equal(input.source, 'en');
    assert.ok(others.length >= 2, `only ${others.length} other locale(s)`);
    assert.equal(i18n.sourceLocale("providers: [{ defaultLang: 'xx', availableLangs: ['xx'] }]"), 'xx');
    assert.throws(() => i18n.sourceLocale('nothing here'), /defaultLang/);
  });

  it('holds at the recorded ceilings, and is violated with none (the repository holds all three lists)', () => {
    assert.equal(decideOf(i18n, input, ceilings, TODAY).holds, true);
    const open = decideOf(i18n, input, [], TODAY);
    assert.equal(open.holds, false);
    for (const l of others) assert.match(open.reason, new RegExp(`key\\(s\\) of ${l} equal the ${input.source} wording`));
    assert.match(open.reason, /no client file refers to/);
  });

  it('is violated when a translated key is copied back to the source wording (the real German key with the English value)', () => {
    const l = others[0];
    const k = translatedKey(l);
    const v = decideOf(i18n, withDict(l, (d) => { d[k] = input.dicts[input.source][k]; return d; }), ceilings, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, new RegExp(`of ${l} equal the ${input.source} wording`));
    assert.match(v.reason, /over its ceiling/);
  });

  it('is violated when a source key no client file refers to is added, and holds when one does (quoted, by a built prefix, or as a plural base)', () => {
    const add = (extra, key) => ({ ...withDict(input.source, (d) => { d[key] = 'Planted wording'; return d; }), texts: [...input.texts, extra] });
    assert.equal(decideOf(i18n, add('const x = 1;', 'zz.planted.title'), ceilings, TODAY).holds, false);
    assert.equal(decideOf(i18n, add("t('zz.planted.title')", 'zz.planted.title'), ceilings, TODAY).holds, true);
    assert.equal(decideOf(i18n, add("const k = 'zz.kind.' + kind;", 'zz.kind.alpha'), ceilings, TODAY).holds, true);
    assert.equal(decideOf(i18n, add("t('zz.count')", 'zz.count.other'), ceilings, TODAY).holds, true);
    assert.equal(decideOf(i18n, add('// t(\'zz.planted.title\') is gone', 'zz.planted.title'), ceilings, TODAY).holds, false);
  });

  it('counts a key under a refusal prefix as used, and still names a key nothing looks up (bundle-270 H7)', () => {
    // The client looks a refusal up as `<prefix>.<code>` for whatever code the server sends (`refusalText`), so no file spells the key: the
    // prefixes are read from the client by the module its own spec reads them with, and every key under one is reached.
    assert.ok(input.refusalPrefixes.length >= 4, `refusal prefixes read: ${input.refusalPrefixes}`);
    assert.ok(input.refusalPrefixes.includes('files.refusal') && input.refusalPrefixes.includes('data.refusal'), String(input.refusalPrefixes));
    const plant = (key) => withDict(input.source, (d) => { d[key] = 'Planted wording'; return d; });
    const known = Object.keys(input.dicts[input.source]).find((k) => k.startsWith('files.refusal.space_being_'));
    assert.ok(known, 'the dictionary words a write-closed code under files.refusal');
    assert.equal(decideOf(i18n, plant(`${input.refusalPrefixes[0]}.space_being_planted`), ceilings, TODAY).holds, true);
    assert.equal(decideOf(i18n, plant('zz.planted.space_being_planted'), ceilings, TODAY).holds, false, 'a key under no prefix is still named');
    assert.equal(decideOf(i18n, plant('zz.refusal.space_being_planted'), ceilings, TODAY).holds, false, 'a prefix is read from the client, not guessed from a name');
    assert.equal(i18n.unusedKeys({ [known]: 'x' }, ['const nothing = 1;'], []).length, 1, 'with no prefix read, the key the client builds at run time is named');
    assert.deepEqual(i18n.unusedKeys({ [known]: 'x' }, ['const nothing = 1;'], ['files.refusal']), []);
  });

  it('cannot answer when no refusal prefix was read from the client', () => {
    assert.throws(() => decideOf(i18n, { ...input, refusalPrefixes: [] }, ceilings, TODAY), /refusal prefixes/);
  });

  it('does not count a value with no letter as untranslated, and does count one that equals the source after trimming', () => {
    assert.deepEqual(i18n.untranslatedKeys({ a: '{{n}}', b: '-', c: 'Open' }, { a: '{{n}}', b: '-', c: ' Open ' }), ['c']);
  });

  it('flattens a nested dictionary to dotted keys', () => {
    assert.deepEqual(i18n.flatten({ a: { b: 'x', c: { d: 'y' } }, e: 'z', f: 3 }), { 'a.b': 'x', 'a.c.d': 'y', e: 'z' });
  });

  it('says a ceiling above its count is slack (the owner lowers it), and refuses a ceiling with no reason or one for a list that is empty', () => {
    const slack = ceilings.map((c) => ({ ...c, max: c.max + 5 }));
    const v = decideOf(i18n, input, slack, TODAY);
    assert.equal(v.holds, true);
    assert.match(v.reason, /lower the ceiling/);
    assert.equal(decideOf(i18n, input, [{ ...ceilings[0], reason: '' }, ...ceilings.slice(1)], TODAY).holds, false);
    assert.match(decideOf(i18n, input, [...ceilings, { ...sound('untranslated:xx'), max: 3 }], TODAY).reason, /limits a measure that is 0 or no longer exists/);
  });

  it('cannot answer for a dictionary or a client that was not read', () => {
    assert.throws(() => decideOf(i18n, { ...input, texts: input.texts.slice(0, 3) }, ceilings, TODAY), /client sources/);
    assert.throws(() => decideOf(i18n, { ...input, dicts: { [input.source]: input.dicts[input.source] } }, ceilings, TODAY), /one locale/);
  });
});

describe('check-i-performance-client-bundle-and-rendering', () => {
  const input = bundle.realInput();
  const angularJson = readFileSync(join(REPO_ROOT, 'client', 'angular.json'), 'utf8');
  const withoutBudget = (type) => {
    const json = JSON.parse(angularJson);
    const build = Object.values(json.projects)[0].architect.build;
    const conf = build.configurations[build.defaultConfiguration];
    conf.budgets = conf.budgets.filter((b) => b.type !== type);
    return bundle.budgetsOf(JSON.stringify(json));
  };
  // `total` bytes of initial scripts in chunks no file of which is itself over the `any` budget, and a ten-byte stylesheet: the initial size is total + 10.
  const fakeDist = (total, extra) => {
    const files = [];
    for (let left = total, i = 0; left > 0; i += 1) { const bytes = Math.min(1_000_000, left); files.push({ file: `main-${i}.js`, bytes }); left -= bytes; }
    files.push({ file: 'styles-X.css', bytes: 10 });
    return { files: [...files, ...extra], initial: files.map((f) => f.file) };
  };

  it('reads the budgets of the default build configuration and refuses one that names none', () => {
    assert.ok(input.budgets.length >= 3, 'the production build carries budgets');
    assert.equal(bundle.budgetsOf(angularJson).name, input.name);
    assert.throws(() => bundle.budgetsOf('{"projects":{"a":{"architect":{"build":{"options":{}}}}}}'), /defaultConfiguration/);
  });

  it('is violated when the build has no initial budget, or none for a component\'s styles (the real budgets with one taken out)', () => {
    assert.deepEqual(bundle.budgetFindings(input.budgets, input.name), []);
    const noInitial = withoutBudget('initial');
    assert.deepEqual(bundle.budgetFindings(noInitial.budgets, noInitial.name).map((f) => f.id), ['budgets']);
    const noStyles = withoutBudget('anyComponentStyle');
    assert.deepEqual(bundle.budgetFindings(noStyles.budgets, noStyles.name).map((f) => f.id), ['budgets component styles']);
  });

  it('is violated when the built initial bundle is one byte over its hard limit, and holds at the limit (the real limit)', () => {
    const initial = input.budgets.find((b) => b.type === 'initial');
    const limit = bundle.bytesOf(initial.maximumError);
    assert.deepEqual(bundle.sizeFindings(input.budgets, fakeDist(limit - 10, [])), []);
    assert.deepEqual(bundle.sizeFindings(input.budgets, fakeDist(limit - 9, [])).map((f) => f.id), ['size initial']);
    const any = input.budgets.find((b) => b.type === 'any');
    const big = bundle.bytesOf(any.maximumError) + 1;
    assert.ok(bundle.sizeFindings(input.budgets, fakeDist(10, [{ file: 'chunk-Y.js', bytes: big }])).some((f) => f.id === 'size any'));
  });

  it('reads sizes as Angular does (1024-based) and refuses a size it does not understand', () => {
    assert.equal(bundle.bytesOf('1MB'), 1024 * 1024);
    assert.equal(bundle.bytesOf('500kb'), 512_000);
    assert.throws(() => bundle.bytesOf('lots'), /budget size/);
  });

  it('is violated when the router holds a page eagerly: a component: route, and a static import of a page (the real router with each added)', () => {
    assert.deepEqual(bundle.eagerRoutes(input.routerText), []);
    const eager = bundle.eagerRoutes(input.routerText.replace(/\{\s*path:\s*'tokens',/, "{ path: 'tokens', component: TokensComponent,"));
    assert.deepEqual(eager.map((f) => f.id), ['route tokens']);
    const imported = bundle.eagerRoutes(`import { TokensComponent } from './pages/settings/tokens.component';\n${input.routerText}`);
    assert.deepEqual(imported.map((f) => f.id), ['import TokensComponent']);
    assert.deepEqual(bundle.eagerRoutes(`// import { X } from './pages/x';\n// { path: 'x', component: X }\n${input.routerText}`), []);
  });

  it('is violated when a search box that asks has no debounce reaching it (a real component with its debounce forms taken out)', () => {
    const asking = input.sources.filter((s) => bundle.searchBoxes(s.text).some((b) => b.asks));
    assert.ok(asking.length >= 3, `only ${asking.length} component(s) hold a search box that asks`);
    assert.deepEqual(bundle.undebouncedSearches(input.sources), []);
    const strip = (t) => t.replace(/\b(debounceTime|debounce|setTimeout|latestWins)\s*\(/g, 'noop(');
    const found = bundle.undebouncedSearches(input.sources.map((s) => ({ ...s, text: strip(s.text) }))).map((f) => f.id);
    for (const s of asking) assert.ok(found.includes(`search ${s.file}`), `${s.file} kept passing with no debounce`);
  });

  it('does not count a debounce named in a comment, nor a search box that only sets a local signal', () => {
    const box = (handler) => `<input type="search" [ngModel]="q()" (ngModelChange)="${handler}" />`;
    const src = (body) => [{ file: 'client/src/app/x.component.ts', text: body }];
    assert.equal(bundle.undebouncedSearches(src(`template: \`${box('load($event)')}\`; // debounceTime( is the plan`)).length, 1);
    assert.equal(bundle.undebouncedSearches(src(`template: \`${box('q.set($event)')}\`;`)).length, 0);
    assert.equal(bundle.undebouncedSearches(src(`template: \`${box('load($event)')}\`; x.pipe(debounceTime(300));`)).length, 0);
  });

  it('cannot answer without a build, and holds or is violated on the real tree when there is one', () => {
    if (input.dist === null) {
      assert.throws(() => decideOf(bundle, input, allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-performance-client-bundle-and-rendering.mjs')), TODAY), /npm run build:client/);
    } else {
      const v = decideOf(bundle, input, allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-performance-client-bundle-and-rendering.mjs')), TODAY);
      assert.equal(v.holds, true, v.reason);
    }
    const planted = { ...input, dist: fakeDist(1, []) };
    assert.equal(decideOf(bundle, planted, [], TODAY).holds, true);
    assert.throws(() => decideOf(bundle, { ...planted, sources: planted.sources.slice(0, 5) }, [], TODAY), /client sources/);
  });

  it('refuses an exception with no reason, and one that excuses nothing', () => {
    const planted = { ...input, dist: fakeDist(1, []) };
    assert.match(decideOf(bundle, planted, [sound('route nowhere')], TODAY).reason, /excuses nothing/);
    assert.equal(decideOf(bundle, planted, [{ id: 'route nowhere', reviewBy: '2027-02-17' }], TODAY).holds, false);
  });
});

describe('check-i-observability-measurement-records-carry-their-context', () => {
  let input;
  before(async () => { input = await measure.realInput(undefined); });
  const allow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-observability-measurement-records-carry-their-context.mjs'));
  const store = () => input.exportedSpecs.find((s) => s.spec.schema.outcome && s.spec.schema.scope && s.spec.schema.formatVersion);
  const without = (spec, field) => { const schema = { ...spec.schema }; delete schema[field]; return { ...spec, schema }; };
  const ids = (spec) => measure.storeFindings(spec).map((f) => f.id);
  const type = () => store().spec.type;

  it('finds the stores the declaring module exports and holds with the exceptions the repository records', () => {
    assert.ok(input.exportedSpecs.length >= 3);
    assert.ok(input.exportedSpecs.every((s) => input.registry.includes(s.spec)));
    const v = decideOf(measure, input, allow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${input.exportedSpecs.length} store\\(s\\), ${allow.length} exception\\(s\\) used`));
  });

  it('is violated by the stores the repository holds that lack a field, with no exception', () => {
    const v = decideOf(measure, input, [], TODAY);
    assert.equal(v.holds, false);
    for (const e of allow) assert.ok(v.reason.includes(e.id.split(' :: ')[0]), `${e.id}: ${v.reason}`);
  });

  it('is violated when a complete store loses outcome, scope, layout version, re-run key or its end marker (the real schema with one field out)', () => {
    const real = store().spec;
    assert.deepEqual(ids(real), [], 'the reference store must be complete');
    assert.deepEqual(ids(without(real, 'outcome')).filter((i) => i.endsWith(':: outcome')), [`${type()} :: outcome`]);
    assert.deepEqual(ids(without(real, 'scope')), [`${type()} :: scope`]);
    assert.deepEqual(ids(without(real, 'formatVersion')), [`${type()} :: layout version`]);
    assert.deepEqual(ids(without(real, 'recordKey')), [`${type()} :: re-run key`]);
    const noEnd = { ...real, schema: { ...real.schema, outcome: { ...real.schema.outcome, values: real.schema.outcome.values.filter((v) => v !== 'incomplete') } } };
    assert.deepEqual(ids(noEnd), [`${type()} :: end marker`]);
  });

  it('accepts an end field in place of an incomplete outcome, and a recordKey only when it is a required string', () => {
    const real = store().spec;
    const noEnd = { ...real, schema: { ...real.schema, outcome: { ...real.schema.outcome, values: ['passed'] } } };
    assert.equal(ids(noEnd).length, 1);
    assert.deepEqual(ids({ ...noEnd, schema: { ...noEnd.schema, endedAt: { type: 'string', required: true } } }), []);
    assert.deepEqual(ids({ ...real, schema: { ...real.schema, recordKey: { type: 'string', required: false } } }), [`${type()} :: re-run key`]);
  });

  it('is violated for a store written outside the list the recorders read (a real spec taken out of the registry)', () => {
    const v = decideOf(measure, { ...input, registry: input.registry.slice(1) }, allow, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /is declared and is not in TELEMETRY_SPECS/);
  });

  it('is scoped by the diff: only a store whose spec a changed file names is asked', () => {
    const [first, ...rest] = input.exportedSpecs;
    const files = new Map(input.exportedSpecs.map((s) => [s.name, [`file-of-${s.name}.mjs`]]));
    const filesHolding = (name) => files.get(name) ?? [];
    const one = measure.measurementFindings({ ...input, changed: new Set([`file-of-${first.name}.mjs`]), filesHolding });
    assert.equal(one.stores, 1);
    assert.ok(one.findings.every((f) => f.id.startsWith(`${first.spec.type} :: `)));
    const none = measure.measurementFindings({ ...input, changed: new Set(['unrelated.txt']), filesHolding });
    assert.deepEqual(none, { findings: [], stores: 0 });
    assert.equal(measure.measurementFindings({ ...input, changed: null, filesHolding }).stores, rest.length + 1);
  });

  it('refuses an exception with no reason, and one that excuses nothing', () => {
    assert.equal(decideOf(measure, input, [{ id: allow[0].id, reviewBy: '2027-02-17' }, ...allow.slice(1)], TODAY).holds, false);
    assert.match(decideOf(measure, input, [...allow, sound('Nothing :: outcome')], TODAY).reason, /excuses nothing/);
  });

  it('cannot answer when the declaring module yields too few stores', () => {
    assert.throws(() => decideOf(measure, { ...input, exportedSpecs: input.exportedSpecs.slice(0, 1) }, allow, TODAY), /measurement store/);
  });
});

describe('the door-parity probes (parameters and caps)', () => {
  let pInput;
  let cInput;
  before(async () => { pInput = await params.realInput(); cInput = await caps.realInput(); });
  const pAllow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-integration-deep-parameters-match-both-doors.mjs'));
  const cAllow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-performance-deep-caps-match-both-doors.mjs'));

  /** A real capability pair with a parameter both doors have, and the two schemas with that parameter replaced by a node of one shape. */
  const shared = (pairs) => {
    for (const p of pairs.filter((x) => !x.delegation && x.schemas.length)) {
      for (const [param, node] of Object.entries(p.toolSchema.properties ?? {})) {
        if (param === 'space' || param in cInput.boundByField || !p.schemas[0].schema.properties?.[param]) continue;
        return { p, param, node };
      }
    }
    throw new Error('no capability pair has a parameter both doors take');
  };
  /** The pair with the parameter set to `toolNode` on the tool and `routeNode` on the route's first schema, and `required` as given. */
  const planted = (p, param, toolNode, routeNode, required = [false, false]) => ({
    ...p,
    toolSchema: { ...p.toolSchema, properties: { ...p.toolSchema.properties, [param]: toolNode }, required: required[0] ? [param] : [] },
    schemas: [{ ...p.schemas[0], schema: { ...p.schemas[0].schema, properties: { ...p.schemas[0].schema.properties, [param]: routeNode }, required: required[1] ? [param] : [] } }],
  });
  const attr = (pairs, attrs) => attributeFindings(pairs, attrs, cInput.boundByField).findings.map((f) => f.id);

  it('pairs a tool and its route from the code: enough tools read, enough capability pairs resolved, some delegating', () => {
    assert.ok(pInput.pairs.length >= 40);
    assert.ok(pInput.capPairs.length >= 60);
    assert.ok(pInput.capPairs.filter((p) => p.delegation).length >= 3);
    assert.ok(pInput.capPairs.filter((p) => p.schemas.length).length >= 15);
    assert.deepEqual(pInput.stale, []);
  });

  it('holds on the repository with the sanctioned differences, and says how many exceptions it used', () => {
    const v = decideOf(params, pInput, pAllow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${pAllow.length} exception\\(s\\) used`));
    const c = decideOf(caps, cInput, cAllow, TODAY);
    assert.equal(c.holds, true, c.reason);
  });

  it('is violated by the sanctioned differences the repository holds when they are not excepted', () => {
    const v = decideOf(params, pInput, [], TODAY);
    assert.equal(v.holds, false);
    for (const e of pAllow) assert.ok(v.reason.includes(e.id.split('.')[0].split(':')[0]), `${e.id}: ${v.reason}`);
  });

  it('is violated when a route drops a key its tool declares (a real route with that key taken out)', () => {
    const pair = pInput.pairs.find((p) => p.routes.length && p.routes.every((r) => r.keys) && p.declared.some((k) => p.routes.some((r) => r.keys.includes(k)) && p.routes.length === 1));
    assert.ok(pair, 'no tool has one readable route that accepts one of its keys');
    const key = pair.declared.find((k) => pair.routes[0].keys.includes(k));
    const before = keyFindings(pInput.pairs).findings.map((f) => f.id);
    const dropped = pInput.pairs.map((p) => (p === pair ? { ...p, routes: [{ ...p.routes[0], keys: p.routes[0].keys.filter((k) => k !== key) }] } : p));
    const after = keyFindings(dropped).findings.map((f) => f.id);
    assert.ok(!before.includes(`${pair.tool}:${key}`));
    assert.ok(after.includes(`${pair.tool}:${key}`), after.join(', '));
  });

  it('is violated when a route accepts a key its tool does not declare (a real route with one more key)', () => {
    const pair = pInput.pairs.find((p) => p.routes.some((r) => r.keys));
    const more = pInput.pairs.map((p) => (p === pair ? { ...p, routes: p.routes.map((r) => (r.keys ? { ...r, keys: [...r.keys, 'plantedKey'] } : r)) } : p));
    assert.ok(keyFindings(more).findings.some((f) => f.id === `${pair.tool}:plantedKey`));
  });

  it('does not compare a route that cannot be read or hands its body to the tool, and counts it', () => {
    const [pair] = pInput.pairs.filter((p) => p.routes.length);
    const unread = keyFindings([{ ...pair, routes: [{ method: 'POST', route: '/x', unresolved: 'by hand' }] }]);
    assert.deepEqual(unread.findings, []);
    assert.equal(unread.unreadable, 1);
    const delegating = keyFindings([{ ...pair, routes: [{ method: 'POST', route: '/x', delegatesTo: pair.tool }] }]);
    assert.equal(delegating.delegating, 1);
  });

  for (const a of CAP_KEYS) {
    it(`caps: is violated when the tool's ${a} and the route's differ by one (a real pair, the parameter given one cap on each door)`, () => {
      const { p, param, node } = shared(cInput.capPairs);
      const same = { ...node, [a]: 10 };
      assert.deepEqual(attr([planted(p, param, same, same)], CAP_KEYS), [], 'equal caps must agree');
      assert.deepEqual(attr([planted(p, param, { ...same, [a]: 11 }, same)], CAP_KEYS), [`${p.tool}:${param}.${a}`]);
      assert.deepEqual(attr([planted(p, param, same, { ...same, [a]: 9 })], CAP_KEYS), [`${p.tool}:${param}.${a}`]);
    });
  }

  for (const a of FLOOR_KEYS) {
    it(`parameters: is violated when the tool's ${a} and the route's differ, and the cap probe does not see it`, () => {
      const { p, param, node } = shared(pInput.capPairs);
      const same = { ...node, [a]: 1 };
      assert.deepEqual(attr([planted(p, param, same, same)], params.SHAPE_ATTRIBUTES), []);
      assert.deepEqual(attr([planted(p, param, { ...same, [a]: 2 }, same)], params.SHAPE_ATTRIBUTES), [`${p.tool}:${param}.${a}`]);
      assert.deepEqual(attr([planted(p, param, { ...same, [a]: 2 }, same)], CAP_KEYS), []);
    });
  }

  it('parameters: is violated when requiredness, an enum or a stated default differs, and not when only one door states a default', () => {
    const { p, param, node } = shared(pInput.capPairs);
    const plain = { ...node };
    delete plain.enum; delete plain.default;
    assert.deepEqual(attr([planted(p, param, plain, plain, [true, false])], params.SHAPE_ATTRIBUTES), [`${p.tool}:${param}.required`]);
    assert.deepEqual(attr([planted(p, param, { ...plain, enum: ['a', 'b'] }, { ...plain, enum: ['a', 'c'] })], params.SHAPE_ATTRIBUTES), [`${p.tool}:${param}.enum`]);
    assert.deepEqual(attr([planted(p, param, { ...plain, default: 1 }, { ...plain, default: 2 })], params.SHAPE_ATTRIBUTES), [`${p.tool}:${param}.default`]);
    assert.deepEqual(attr([planted(p, param, { ...plain, default: 1 }, plain)], params.SHAPE_ATTRIBUTES), []);
  });

  it('a union of two schemas compares by its loosest branch, and an exclusive integer bound as the next inclusive one', () => {
    const { p, param } = shared(cInput.capPairs);
    const union = { anyOf: [{ type: 'integer', maximum: 5 }, { type: 'integer', maximum: 9 }] };
    assert.deepEqual(attr([planted(p, param, union, { type: 'integer', maximum: 9 })], CAP_KEYS), []);
    assert.deepEqual(attr([planted(p, param, { type: 'integer', exclusiveMaximum: 10 }, { type: 'integer', maximum: 9 })], CAP_KEYS), []);
    assert.deepEqual(attr([planted(p, param, { type: 'integer', exclusiveMaximum: 10 }, { type: 'integer', maximum: 10 })], CAP_KEYS), [`${p.tool}:${param}.maximum`]);
  });

  it('a route that hands its body to the tool agrees by construction and is counted, never compared', () => {
    const { p, param, node } = shared(cInput.capPairs);
    const same = { ...node, maximum: 10 };
    const delegating = { ...planted(p, param, { ...same, maximum: 11 }, same), delegation: { tool: p.tool } };
    const r = attributeFindings([delegating], CAP_KEYS, cInput.boundByField);
    assert.deepEqual(r.findings, []);
    assert.equal(r.delegating, 1);
  });

  it('a scalar schema a helper deep in the call graph parses with is no route\'s body schema; an object schema is (bundle-269)', () => {
    assert.equal(typeof doorPairs.bodySchemasIn, 'function', '_door-pairs.mjs exports no bodySchemasIn: what a route\'s schema is has no one reading');
    const zods = new Map([
      ['PlantedBodyZ', { name: 'PlantedBodyZ', schema: { type: 'object', properties: { limit: { type: 'integer', maximum: 10 } } } }],
      ['PlantedPrefixZ', { name: 'PlantedPrefixZ', schema: { type: 'string', maxLength: 50 } }],
    ]);
    const handler = 'const parsed = PlantedBodyZ.safeParse(req.body);';
    const helper = 'if (!PlantedPrefixZ.safeParse(cfg.prefix).success) return undefined;';
    assert.deepEqual(doorPairs.bodySchemasIn([helper], zods), [], 'a helper validating a config value made the route read as validated by schema');
    assert.deepEqual(doorPairs.bodySchemasIn([handler, helper], zods).map(s => s.name), ['PlantedBodyZ']);
  });

  it('caps: a hand-validated route whose tool states a cap raises the unreadable count, and past its ceiling is violated', () => {
    const { p, param, node } = shared(cInput.capPairs);
    const byHand = { ...planted(p, param, { ...node, maximum: 10 }, { ...node, maximum: 10 }), schemas: [] };
    const more = { ...cInput, capPairs: [...cInput.capPairs, ...Array.from({ length: 3 }, () => byHand)] };
    const v = decideOf(caps, more, cAllow, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /over its ceiling/);
    assert.match(v.reason, /validate by hand/);
  });

  it('a ceiling above the count is slack and holds; one for a count of zero, or with no reason, is refused', () => {
    assert.equal(decideOf(caps, cInput, cAllow.map((c) => ({ ...c, max: c.max + 4 })), TODAY).holds, true);
    assert.match(decideOf(caps, { ...cInput, capPairs: cInput.capPairs.map((p) => (p.schemas.length === 0 && !p.delegation ? { ...p, toolSchema: { type: 'object', properties: {} } } : p)) }, cAllow, TODAY).reason, /limits a measure that is 0/);
    assert.equal(decideOf(caps, cInput, [{ ...cAllow[0], reason: '' }], TODAY).holds, false);
  });

  it('refuses an exception that excuses nothing, and a reading that lost the surface (cannot answer)', () => {
    assert.match(decideOf(params, pInput, [...pAllow, sound('nothing:nowhere')], TODAY).reason, /excuses nothing/);
    assert.throws(() => decideOf(caps, { ...cInput, capPairs: cInput.capPairs.slice(0, 5) }, cAllow, TODAY), /capability pair/);
    assert.throws(() => decideOf(params, { ...pInput, capPairs: pInput.capPairs.slice(0, 2) }, pAllow, TODAY), /capability pair|resolved/);
  });

  it('a stale KEEP_PAIRING row is a problem, as an exception that keeps nothing', () => {
    const v = decideOf(params, { ...pInput, stale: ['a_tool\tGET /api/x'] }, pAllow, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /kept for nothing/);
  });
});

describe('check-i-security-deep-guards-fail-closed', () => {
  let input;
  const mutated = [];
  before(async () => { input = await guards.realInput(); });
  after(() => { for (const f of mutated) rmSync(f, { force: true }); });
  const allow = allowOf(import.meta.url.replace(/[^/]+$/, '../../tools/flow-checks/check-i-security-deep-guards-fail-closed.mjs'));
  const failOpen = (kind) => (kind === 'predicate' ? () => true : kind === 'refusal' ? () => null : () => ['a-space']);
  const idOf = (g) => `${g.file}:${g.name}`;
  const withFn = (g, fn) => ({ ...input, fns: new Map([...input.fns, [idOf(g), fn]]) });

  it('derives the guards from the declarations of the auth folder: every kind, both policy shapes', () => {
    assert.ok(input.guards.length >= 15, `${input.guards.length} guards`);
    for (const kind of ['predicate', 'refusal', 'list']) assert.ok(input.guards.some((g) => g.kind === kind), `no ${kind} guard derived`);
    for (const policy of ['rights', 'record']) assert.ok(input.guards.some((g) => g.policy === policy), `no ${policy} guard derived`);
  });

  it('holds on the repository: each guard denies an empty, missing and undefined policy', () => {
    const v = decideOf(guards, input, allow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${input.guards.length} guard\\(s\\) derived`));
  });

  for (const kind of ['predicate', 'refusal', 'list']) {
    it(`is violated when a real ${kind} guard fails open (the guard replaced by one that permits)`, () => {
      const g = input.guards.find((x) => x.kind === kind);
      assert.ok(g, `no ${kind} guard`);
      const v = decideOf(guards, withFn(g, failOpen(kind)), [], TODAY);
      assert.equal(v.holds, false);
      assert.ok(v.reason.includes(`${g.file} ${g.name}()`), v.reason);
    });
  }

  it('is violated when a real guard of the build is changed to answer true for a missing policy (its compiled source with the refusal flipped)', async () => {
    const g = input.guards.find((x) => x.name === 'canWriteAnywhere');
    assert.ok(g, 'the guard that refuses a mutation for a missing matrix is not derived');
    const dist = join(REPO_ROOT, 'server', 'dist', 'auth');
    const text = readFileSync(join(dist, 'write-anywhere.js'), 'utf8');
    const flipped = text.replace(/if \(!rights\)\s*\{?\s*return false;?\s*\}?/, 'if (!rights) { return true; }');
    assert.notEqual(flipped, text, 'the mutation did not change the compiled guard: it broke nothing');
    const file = join(dist, 'write-anywhere.planted.js');
    mutated.push(file);
    writeFileSync(file, flipped);
    const mod = await import(`${pathToFileURL(file).href}?planted`);
    const v = decideOf(guards, withFn(g, mod.canWriteAnywhere), [], TODAY);
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(`${g.file} ${g.name}()`), v.reason);
  });

  it('derives a guard added to a source of the folder (a real source with one more guard, named as the module names them)', () => {
    const real = input.guards.find((g) => g.kind === 'predicate' && g.policy === 'record');
    const text = readFileSync(join(REPO_ROOT, real.file), 'utf8');
    const extra = `${text}\nexport function mayDoPlantedThing(record: Holder): boolean {\n  return true;\n}\n`;
    const names = guards.guardsIn(real.file, extra).map((g) => g.name);
    assert.ok(names.includes('mayDoPlantedThing'), names.join(', '));
    assert.equal(guards.guardsIn(real.file, text).map((g) => g.name).includes('mayDoPlantedThing'), false);
    const planted = { ...input, guards: [...input.guards, guards.guardsIn(real.file, extra).find((g) => g.name === 'mayDoPlantedThing')] };
    const v = decideOf(guards, { ...planted, fns: new Map([...input.fns, [`${real.file}:mayDoPlantedThing`, () => true]]) }, [], TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /mayDoPlantedThing/);
  });

  it('does not derive a function that is not a guard: a comment, a generic function, a name that is not a permission question', () => {
    const src = [
      '// export function mayInComment(rights: TokenRights): boolean { return true; }',
      'export function tokenIsLive(token: { rights?: TokenRights }): boolean { return true; }',
      'export function mayGeneric<T>(rights: TokenRights, x: T): boolean { return true; }',
      'export function mayAsk(rights: TokenRights | null | undefined, space: string): boolean { return false; }',
    ].join('\n');
    assert.deepEqual(guards.guardsIn('x.ts', src).map((g) => g.name), ['mayAsk']);
  });

  it('a guard that throws on a missing policy fails closed and is counted; one that throws on every policy cannot be read', () => {
    const g = input.guards[0];
    const v = decideOf(guards, withFn(g, (p) => { if (p === undefined || p === null) throw new TypeError('no policy'); return false; }), allow, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.throws(() => decideOf(guards, withFn(g, () => { throw new Error('always'); }), allow, TODAY), /threw on every policy/);
  });

  it('feeds each guard its other parameters by declared type, including an object type, and the empty rights the server builds', () => {
    assert.equal(guards.sampleFor('string'), 'a-space');
    assert.deepEqual(guards.sampleFor('readonly string[]'), ['a-space']);
    assert.deepEqual(guards.sampleFor('{ existing: string[]; toCreate: string[] }'), { existing: ['a-space'], toCreate: ['a-space'] });
    assert.deepEqual(guards.sampleFor('{ spaces: string[]; spaceOrigins?: Record<string, string> | undefined }'), { spaces: ['a-space'] });
    assert.equal(guards.sampleFor('Rung'), 'read');
    assert.deepEqual(Object.keys(input.emptyRights).sort(), ['createSpaces', 'floor', 'instanceAdmin', 'perSpace']);
    assert.deepEqual(guards.emptyPolicies('rights', input.emptyRights).map((p) => (p === undefined ? 'undefined' : p === null ? 'null' : 'value')), ['undefined', 'null', 'value', 'value']);
  });

  it('refuses an exception with no reason, one that excuses nothing, and a folder that yielded too few guards', () => {
    assert.match(decideOf(guards, input, [sound('server/src/auth/x.ts:mayNothing')], TODAY).reason, /excuses nothing/);
    assert.equal(decideOf(guards, input, [{ id: 'x', reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.throws(() => decideOf(guards, { ...input, guards: input.guards.slice(0, 3) }, allow, TODAY), /guard\(s\) derived/);
  });
});

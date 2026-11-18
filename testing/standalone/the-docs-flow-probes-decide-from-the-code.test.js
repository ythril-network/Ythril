/**
 * The four docs-surface flow-check probes decide from the repository, and a planted copy of each defect fails them.
 *
 * ## The failure this prevents (Q-876, YF-123)
 *
 * `check-i-docs-parameters-listed`, `check-i-docs-response-fields-listed`, `check-i-docs-userguide-half-present` and
 * `check-i-docs-pages-and-nav-complete` are named by the loop's planning and audit passes. Ythril had no probe for any of them, so
 * `project-check.mjs` answered "cannot answer" and each was judged by reading, every bundle. Writing them found fifteen places where an
 * integrator was told less than the code accepts or answers (`superseded` on edges and chrono, `skipTlsVerify`, `merkle`, the local-agent body,
 * `nliConfigured`, `mediaCeilings`, ...), each now written down.
 *
 * - parameters: every key a REST route accepts (the route reader the parity gates use) and every property of an MCP tool's input schema is a word
 *   on a page that names the route or the tool.
 * - response fields: every top-level key of a route's literal success answer is on a page that names the route.
 * - user guide: every parameter both doors take and the client sends is named, as a word or in words, on the user-guide page of its surface.
 * - pages and nav: every docs page is linked from its guide's index (or from the README or another page), every index link has a file, and every
 *   route and tool the changelog adds is documented.
 *
 * Each rule is proven on a planted copy of the defect taken from the repository's own text (a real docs word removed from the pages that held it,
 * a real route line given a field, a real link retargeted, a real changelog route renamed), and on the real repository, which must hold.
 * An exception is an entry in the probe's `.allow.json` with a reason and a reviewBy date; one without either, or past its date, fails the probe.
 *
 * Run: node --test testing/standalone/the-docs-flow-probes-decide-from-the-code.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { CannotAnswer } from '../../tools/flow-checks/_verdict.mjs';
import {
  guideParts, userguideParts, restSurface, toolSurface, routesWithSource, readAllowFile, allowProblem, printsName, pagesNamingRoutes, pagesNamingRoute,
} from '../../tools/flow-checks/_docs-surface.mjs';
import { decide as decideParameters } from '../../tools/flow-checks/check-i-docs-parameters-listed.mjs';
import { decide as decideResponse } from '../../tools/flow-checks/check-i-docs-response-fields-listed.mjs';
import {
  decide as decideUserguide, clientWords, spokenForms, pageNames, surfaceOf, pagesForSurface,
} from '../../tools/flow-checks/check-i-docs-userguide-half-present.mjs';
import { decide as decidePages, linksOf, addedBullets, toolNamesOf } from '../../tools/flow-checks/check-i-docs-pages-and-nav-complete.mjs';
import { CAPABILITIES } from './_capability-map.mjs';

const today = new Date().toISOString().slice(0, 10);
const probe = (name) => join(REPO_ROOT, 'tools', 'flow-checks', `${name}.mjs`);
const run = (name) => {
  const r = spawnSync(process.execPath, [probe(name)], { encoding: 'utf8', env: testChildEnv({}, process.env), timeout: 300_000 });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { code: r.status, last: lines[lines.length - 1] };
};
const allowOf = (check) => readAllowFile(new URL(`../../tools/flow-checks/${check}.mjs`, import.meta.url).href, check);

/** The pages with `word` taken out of every one: a real documented parameter, no longer written down. */
const withoutWord = (parts, word) => parts.map(p => ({ ...p, text: p.text.replace(new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, 'g'), 'REMOVED') }));

const guide = guideParts();
const userguide = userguideParts();
const rest = await restSurface();
const tools = await toolSurface();
const routes = routesWithSource();

describe('the shared surface reader', () => {
  it('reads the surface from the code: routes with their accepted keys, and tools with their input properties', () => {
    assert.ok(rest.some(r => r.method === 'POST' && r.route === '/api/brain/spaces/:spaceId/facts' && r.keys?.includes('fact')), 'the facts route and its `fact` key');
    assert.ok(tools.find(t => t.name === 'save_fact')?.keys.includes('fact'), 'the save_fact tool and its `fact` property');
    assert.ok(tools.filter(t => t.keys.length).length >= tools.length * 0.6, 'most tools carry input properties');
  });

  it('names a route the way the guide writes it: whole, in a table row, and shortened', () => {
    const named = pagesNamingRoutes([
      { file: 'a.md', text: 'POST /api/brain/spaces/:id/facts' },
      { file: 'b.md', text: '| `POST` | `/api/contradictions/:id/dismiss` | x |' },
      { file: 'c.md', text: 'Available on `POST …/chrono`.' },
    ]);
    assert.deepEqual([...pagesNamingRoute(named, 'POST', '/api/brain/spaces/:spaceId/facts')], ['a.md']);
    assert.deepEqual([...pagesNamingRoute(named, 'POST', '/api/contradictions/:id/dismiss')], ['b.md']);
    assert.deepEqual([...pagesNamingRoute(named, 'POST', '/api/brain/spaces/:spaceId/chrono')], ['c.md']);
    assert.deepEqual([...pagesNamingRoute(named, 'GET', '/api/brain/spaces/:spaceId/chrono')], []);
  });

  it('prints a name only as a word of its own', () => {
    assert.equal(printsName('send `ttlDays` here', 'ttlDays'), true);
    assert.equal(printsName('send ttlDaysMax here', 'ttlDays'), false);
    assert.equal(printsName('send TTLDAYS here', 'ttlDays'), false);
  });

  it('refuses an allow entry without a reason, or past its review date, or without a date', () => {
    assert.equal(allowProblem([{ key: 'a', reason: 'r', reviewBy: '2999-01-01' }], today), null);
    assert.match(allowProblem([{ key: 'a', reviewBy: '2999-01-01' }], today), /needs its key, a reason and a reviewBy/);
    assert.match(allowProblem([{ key: 'a', reason: 'r' }], today), /needs its key, a reason and a reviewBy/);
    assert.match(allowProblem([{ key: 'a', reason: 'r', reviewBy: '2000-01-01' }], today), /past its reviewBy/);
  });
});

describe('check-i-docs-parameters-listed', () => {
  const allow = allowOf('check-i-docs-parameters-listed');
  const input = { rest, tools, parts: guide, allow, today };

  it('holds on the repository', () => {
    const r = run('check-i-docs-parameters-listed');
    assert.equal(r.code, 0, r.last);
    assert.match(r.last, /^holds: /);
  });

  it('fails when a route parameter is taken off every page that names its route', () => {
    // A key only this surface takes, read from the code: the REST body of the member add, and the tools that share its act.
    const key = 'skipTlsVerify';
    assert.ok(rest.some(r => (r.keys ?? []).includes(key)), 'the key is one the code accepts');
    const v = decideParameters({ ...input, parts: withoutWord(guide, key) });
    assert.equal(v.holds, false);
    assert.match(v.reason, /skipTlsVerify/);
    assert.match(v.reason, /POST \/api\/networks\/:id\/members/);
  });

  it('fails when a tool parameter is taken off every page that names the tool', () => {
    const v = decideParameters({ ...input, parts: withoutWord(guide, 'inviteCode') });
    assert.equal(v.holds, false);
    assert.match(v.reason, /tool network_join_remote lacks inviteCode/);
  });

  it('fails when a route with parameters is named on no page', () => {
    const named = pagesNamingRoutes(guide);
    const row = rest.find(r => !r.unresolved && (r.keys ?? []).length && pagesNamingRoute(named, r.method, r.route).size);
    assert.ok(row, 'a real route with parameters that a page names');
    // The page that named it is gone: the real route row against a page of other text.
    const v = decideParameters({ ...input, rest: [row], parts: [{ file: 'docs/integration-guide/99-other.md', text: 'nothing about it\n' }] });
    assert.equal(v.holds, false);
    assert.match(v.reason, /is printed on no page/);
  });

  it('holds again when the gap is an allowed exception, and says it used one', () => {
    const v = decideParameters({
      ...input,
      rest: rest.filter(r => r.method === 'POST' && r.route === '/api/networks/:id/members'),
      tools: tools.filter(t => t.name === 'save_fact'),
      parts: withoutWord(guide, 'skipTlsVerify'),
      allow: [{ key: 'POST /api/networks/:id/members skipTlsVerify', reason: 'planted', reviewBy: '2999-01-01' }],
    });
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, /1 of 1 exception\(s\) used/);
  });

  it('fails an allow entry past its review date, and answers "cannot answer" over a surface it could not read', () => {
    assert.equal(decideParameters({ ...input, allow: [{ key: 'x', reason: 'r', reviewBy: '2000-01-01' }] }).holds, false);
    assert.throws(() => decideParameters({ ...input, rest: [], tools: [] }), CannotAnswer);
  });
});

describe('check-i-docs-response-fields-listed', () => {
  const allow = allowOf('check-i-docs-response-fields-listed');
  const input = { routes, parts: guide, allow, today };

  it('holds on the repository', () => {
    const r = run('check-i-docs-response-fields-listed');
    assert.equal(r.code, 0, r.last);
    assert.match(r.last, /^holds: /);
  });

  it('fails when a real documented answer field is taken off the pages that held it', () => {
    const v = decideResponse({ ...input, parts: withoutWord(guide, 'nliConfigured') });
    assert.equal(v.holds, false);
    assert.match(v.reason, /GET \/api\/contradictions answers nliConfigured/);
  });

  it('fails when a real route line gains a field nobody documented', () => {
    const planted = routes.map(r => (r.method === 'GET' && r.path === '/api/spaces' && r.source.includes('res.json({ spaces,')
      ? { ...r, source: r.source.replace('res.json({ spaces,', 'res.json({ plantedField: 1, spaces,') }
      : r));
    assert.notDeepEqual(planted.map(r => r.source), routes.map(r => r.source), 'the real line was found and changed');
    const v = decideResponse({ ...input, routes: planted });
    assert.equal(v.holds, false);
    assert.match(v.reason, /GET \/api\/spaces answers plantedField/);
  });

  it('does not read a 4xx body as a success answer, and names an answer built elsewhere', () => {
    const v = decideResponse({
      ...input,
      routes: [
        { method: 'GET', path: '/api/spaces', source: "res.status(400).json({ error: 'x', plantedField: 1 }); res.json(result);" },
      ],
    });
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, /1 route\(s\) with an answer built elsewhere/);
  });

  it('fails a literal answer on a route no page names, and an allow entry for it holds', () => {
    const lone = [{ method: 'GET', path: '/api/zz-planted', source: 'res.json({ a: 1 });' }];
    const bad = decideResponse({ ...input, routes: lone });
    assert.equal(bad.holds, false);
    assert.match(bad.reason, /GET \/api\/zz-planted is printed on no page/);
    const ok = decideResponse({ ...input, routes: lone, allow: [{ key: 'GET /api/zz-planted a', reason: 'planted', reviewBy: '2999-01-01' }] });
    assert.equal(ok.holds, true, ok.reason);
  });
});

describe('check-i-docs-userguide-half-present', () => {
  const allow = allowOf('check-i-docs-userguide-half-present');
  const client = clientWords(readTrackedSources(['client/src'], { ext: ['.ts', '.html'], specs: false, floor: 100 }));
  const input = { rest, tools, parts: userguide, client, allow, today };

  it('holds on the repository', () => {
    const r = run('check-i-docs-userguide-half-present');
    assert.equal(r.code, 0, r.last);
    assert.match(r.last, /^holds: /);
  });

  it('says a parameter in words as the guide would, from its name', () => {
    assert.deepEqual(spokenForms('votingDeadlineHours'), ['voting deadline hours', 'voting deadline']);
    assert.deepEqual(spokenForms('syncSchedule'), ['sync schedule']);
    assert.deepEqual(spokenForms('merkle'), []);
    assert.equal(pageNames('the **Voting deadline** field', 'votingDeadlineHours'), true);
    assert.equal(pageNames('the Sync-Schedule box', 'syncSchedule'), true);
    assert.equal(pageNames('nothing about it', 'syncSchedule'), false);
  });

  it('fails when a parameter the page names is taken off the page of its surface', () => {
    // Found from the code and the guide: a parameter both doors take, the client sends, and the surface page names today.
    const routeBy = new Map(rest.filter(r => !r.unresolved).map(r => [`${r.method} ${r.route}`, r]));
    let planted = null;
    for (const [section, tool, spec] of CAPABILITIES) {
      const t = tools.find(x => x.name === tool);
      const r = routeBy.get(spec);
      if (!t || !r) continue;
      const accepted = new Set([...(r.keys ?? []), ...(r.queryKeys ?? [])]);
      const pages = pagesForSurface(userguide, surfaceOf(section));
      const text = pages.map(p => p.text).join('\n');
      const key = t.keys.find(k => k !== 'space' && accepted.has(k) && client.has(k) && printsName(text, k));
      if (key) { planted = { key, tool }; break; }
    }
    assert.ok(planted, 'a parameter the guide names was found in the code');
    const v = decideUserguide({ ...input, parts: withoutWord(userguide, planted.key) });
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(`${planted.key} (`), v.reason);
  });

  it('fails when an exception is taken away, and when a surface has no operator page', () => {
    const first = decideUserguide({ ...input, allow: allow.slice(1) });
    assert.equal(first.holds, false);
    assert.ok(first.reason.includes(`${allow[0].key} (`), first.reason);
    const v = decideUserguide({ ...input, parts: [{ file: 'docs/userguide/99-elsewhere.md', text: '# Elsewhere\n' }] });
    assert.equal(v.holds, false);
    assert.match(v.reason, /no user-guide page holds the surface/);
  });

  it('answers "cannot answer" over a surface it could not read, and fails an entry past its date', () => {
    assert.equal(decideUserguide({ ...input, allow: [{ key: 'x', reason: 'r', reviewBy: '2000-01-01' }] }).holds, false);
    assert.throws(() => decideUserguide({ ...input, rest: [], tools: [] }), CannotAnswer);
  });
});

describe('check-i-docs-pages-and-nav-complete', () => {
  const allow = allowOf('check-i-docs-pages-and-nav-complete');
  const docs = readTrackedSources(['docs'], { ext: ['.md'], floor: 30 });
  const readme = readTrackedSources(['README.md', 'CONTRIBUTING.md'], { ext: ['.md'], floor: 2 });
  const changelog = readTrackedSources(['CHANGELOG.md'], { ext: ['.md'], floor: 1 })[0].text;
  const toolNames = toolNamesOf(readTrackedSources(['server/src/mcp/tools'], { ext: ['.ts'], floor: 20, specs: false }));
  const input = { docs, readme, changelog, toolNames, allow, today };

  it('holds on the repository', () => {
    const r = run('check-i-docs-pages-and-nav-complete');
    assert.equal(r.code, 0, r.last);
    assert.match(r.last, /^holds: /);
  });

  it('reads links and the changelog from their text', () => {
    assert.deepEqual(linksOf('docs/integration-guide/04-x.md', 'see [a](04a-y.md#frag) and [b](../userguide.md) and [c](https://e.com/x.md)').map(l => l.to),
      ['docs/integration-guide/04a-y.md', 'docs/userguide.md']);
    assert.ok(addedBullets(changelog).length >= 1, 'the newest section has Added bullets');
    assert.ok(toolNames.has('save_fact'), 'the tool files define save_fact');
  });

  it('fails on a page no navigation links: a real part copied under a new name', () => {
    const real = docs.find(d => d.file === 'docs/integration-guide/05-files-api.md');
    const v = decidePages({ ...input, docs: [...docs, { ...real, file: 'docs/integration-guide/99-planted.md' }] });
    assert.equal(v.holds, false);
    assert.match(v.reason, /docs\/integration-guide\/99-planted\.md is in no navigation/);
  });

  it('fails on an index link whose file does not exist: a real link retargeted', () => {
    const index = docs.find(d => d.file === 'docs/integration-guide.md');
    const target = 'integration-guide/01-getting-ythril.md';
    assert.ok(index.text.includes(target), 'the real index links the part');
    const v = decidePages({ ...input, docs: docs.map(d => (d === index ? { ...d, text: d.text.replace(target, 'integration-guide/01-getting-ythril-gone.md') } : d)) });
    assert.equal(v.holds, false);
    assert.match(v.reason, /links docs\/integration-guide\/01-getting-ythril-gone\.md, which git does not track/);
    assert.match(v.reason, /docs\/integration-guide\/01-getting-ythril\.md is in no navigation/);
  });

  it('fails on a route the changelog adds that no page prints: a real changelog route renamed', () => {
    const bullet = addedBullets(changelog).find(b => /\b(GET|POST|PUT|PATCH|DELETE)\s+\/api\/[a-z]/.test(b));
    assert.ok(bullet, 'the newest Added section names a route');
    const planted = changelog.replace(bullet, bullet.replace(/(\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\/)([a-z])/, '$1zz-$2'));
    const v = decidePages({ ...input, changelog: planted });
    assert.equal(v.holds, false);
    assert.match(v.reason, /the changelog adds (GET|POST|PUT|PATCH|DELETE) \/api\/zz-/);
  });

  it('fails on a tool the changelog adds that no page names, and an allow entry for it holds', () => {
    const toolBullet = addedBullets(changelog).find(b => [...b.matchAll(/`([a-z][a-z0-9_]+)`/g)].some(m => toolNames.has(m[1])));
    assert.ok(toolBullet, 'the newest Added section names a tool');
    const tool = [...toolBullet.matchAll(/`([a-z][a-z0-9_]+)`/g)].map(m => m[1]).find(n => toolNames.has(n));
    const planted = docs.map(d => ({ ...d, text: d.text.replace(new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`, 'g'), 'REMOVED') }));
    const bad = decidePages({ ...input, docs: planted });
    assert.equal(bad.holds, false);
    assert.ok(bad.reason.includes(`the changelog adds the tool ${tool}`), bad.reason);
    const ok = decidePages({ ...input, docs: planted, allow: [{ key: `changelog ${tool}`, reason: 'planted', reviewBy: '2999-01-01' }] });
    assert.ok(!ok.reason.includes(`the changelog adds the tool ${tool}`), ok.reason);
  });

  it('fails an allow entry past its review date', () => {
    assert.equal(decidePages({ ...input, allow: [{ key: 'orphan x', reason: 'r', reviewBy: '2000-01-01' }] }).holds, false);
  });
});

describe('the probes are written down', () => {
  it('each probe has an allow file and a header that names its rule, its exceptions file and the failure that bought it', () => {
    for (const c of ['parameters-listed', 'response-fields-listed', 'userguide-half-present', 'pages-and-nav-complete']) {
      const src = readFileSync(probe(`check-i-docs-${c}`), 'utf8');
      assert.match(src, /Rule \(the flow node's stated assertion\)/, c);
      assert.match(src, /\.allow\.json/, c);
      assert.match(src, /The failure that bought it/, c);
      assert.ok(Array.isArray(allowOf(`check-i-docs-${c}`)), c);
    }
  });
});

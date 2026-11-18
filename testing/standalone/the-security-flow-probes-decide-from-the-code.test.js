/**
 * The five security-lens flow-check probes decide from the repository, and a planted copy of each defect fails them.
 *
 * ## The failure this prevents (Q-876, YF-123)
 *
 * `check-i-security-rate-limits`, `check-i-security-deep-twin-parity`, `check-i-testing-contract-tests`, `check-i-privacy-no-cross-space-leak` and
 * `check-i-performance-user-quantities-capped` are named by the loop's plan and audit lenses. Ythril had no probe for any of them, so
 * `project-check.mjs` answered "cannot answer" and each was judged by reading, every bundle. A probe now answers each from the code:
 *
 * - rate limits: every mutating route, and every read whose handler is expensive or outbound, names a limiter (found as `const X = rateLimit(`)
 *   or a guard that reaches `attachToken`, which runs the token's own limiter (read from the guard's body, never its name).
 * - door parity: for every tool and its REST route the guard, the read-only refusal, the space narrowing and the rights row agree.
 * - contract tests: every mounted route's path and every tool's name is written by some tracked test under `testing/`.
 * - cross-space reads: every read route and every tool that takes a `space` asks the space question before it reads.
 * - quantities: every list of a tool's input schema has `maxItems`, every number a `maximum` (the result-budget fields through the clamp that
 *   caps them), and every request bound of `util/request-bounds.ts` is in the docs.
 *
 * Each rule is proven on a planted copy of the defect taken from the repository's own data (a real route's chain with its limiter taken out, a
 * real guard that stops calling `attachToken`, a real tool with its flag flipped, a real schema property with its ceiling deleted), and on the
 * real repository, which must answer without "cannot answer". Nothing here names a route or a tool of the repository: each is picked from the
 * registries, so this file is not itself a test that "names" a surface for the contract-tests probe.
 *
 * The probes of this group read the build (`server/dist`): run `npm run build:server` first.
 *
 * Run: node --test testing/standalone/the-security-flow-probes-decide-from-the-code.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { bodyOf } from './_structural-window.mjs';
import { routesWithChains, guardFacts, limiterNames, chainFacts, serverSources, middlewareText, dispatchesThroughCallTool } from '../../tools/flow-checks/_route-chains.mjs';
import { decide as decideRates, unlimitedRoutes, inScope } from '../../tools/flow-checks/check-i-security-rate-limits.mjs';
import { decide as decideTwins, matrixFindings, realInput as twinInput } from '../../tools/flow-checks/check-i-security-deep-twin-parity.mjs';
import { decide as decideContracts, unreferenced, pathPattern, surfaceTests, realInput as contractInput } from '../../tools/flow-checks/check-i-testing-contract-tests.mjs';
import { decide as decideLeaks, leakyRoutes, unpricedSpaceTools, realInput as leakInput } from '../../tools/flow-checks/check-i-privacy-no-cross-space-leak.mjs';
import { decide as decideQuantities, uncappedProperties, budgetCappedFields, boundConstants, documented, realInput as quantityInput } from '../../tools/flow-checks/check-i-performance-user-quantities-capped.mjs';
import { SPACE_SCHEMAS } from '../../tools/flow-checks/_built-registry.mjs';

const probe = (name) => join(REPO_ROOT, 'tools', 'flow-checks', `${name}.mjs`);
const run = (name) => {
  const r = spawnSync(process.execPath, [probe(name)], { encoding: 'utf8', env: testChildEnv({}, process.env), cwd: REPO_ROOT, timeout: 240_000 });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { code: r.status, last: lines[lines.length - 1] };
};
const TODAY = '2026-11-18';
const sound = (id) => ({ id, reason: 'a reason of more than twenty characters', reviewBy: '2027-02-17' });

describe('every probe of the group answers on the repository', () => {
  for (const name of ['check-i-security-rate-limits', 'check-i-security-deep-twin-parity', 'check-i-testing-contract-tests', 'check-i-privacy-no-cross-space-leak', 'check-i-performance-user-quantities-capped']) {
    it(`${name} holds`, () => {
      const r = run(name);
      assert.equal(r.code, 0, r.last);
      assert.match(r.last, /^holds: /);
    });
  }
});

describe('check-i-security-rate-limits', () => {
  const routes = routesWithChains();
  const guards = guardFacts(middlewareText());
  const limiters = limiterNames(serverSources());

  it('reads the guards from their bodies: every guard that reaches attachToken is a meter, found by its own text', () => {
    const text = middlewareText();
    const direct = [...text.matchAll(/^export (?:async )?function (require\w+)\(/gm)].map((m) => m[1]).filter((n) => /\battachToken\(/.test(bodyOf(text, n)));
    assert.ok(direct.length >= 8, `only ${direct.length} guard(s) call attachToken directly`);
    for (const n of direct) assert.equal(guards.get(n)?.metered, true, `${n} calls attachToken and is not a meter`);
  });

  it('puts a router-level guard in the chain of every route of that router', () => {
    const behind = routes.filter((r) => r.routerChain && !r.chain.includes(r.routerChain.split(',')[0]));
    assert.ok(behind.length > 0, 'no route is guarded only by its router');
    for (const r of behind) assert.ok(r.all.includes(r.routerChain.split(',')[0]), `${r.method} ${r.path}`);
  });

  it('holds when a public mutating route is limited by a limiter and not by a token', () => {
    const real = routes.find((r) => inScope(r) && !chainFacts(r.all, guards, limiters).metered && chainFacts(r.all, guards, limiters).limiters.length);
    assert.ok(real, 'the repository has no public mutating route limited by a limiter alone');
    assert.deepEqual(unlimitedRoutes([real], guards, limiters), []);
  });

  it('is violated when that route loses its limiter (the real chain with the limiter taken out)', () => {
    const real = routes.find((r) => inScope(r) && !chainFacts(r.all, guards, limiters).metered && chainFacts(r.all, guards, limiters).limiters.length);
    const strip = (s) => limiters.size ? [...limiters].reduce((t, n) => t.replace(new RegExp(`\\b${n}\\b,?`, 'g'), ''), s) : s;
    const planted = routes.map((r) => (r === real ? { ...r, chain: strip(r.chain), routerChain: strip(r.routerChain), all: strip(r.all) } : r));
    const v = decideRates(planted, guards, limiters, [], TODAY);
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(`${real.method} ${real.path}`), v.reason);
  });

  it('is violated when a guard stops calling attachToken (the real guard with its call replaced) and a route relied on it', () => {
    // LF: `bodyOf` joins the lines it returns with LF, so a CRLF checkout's text would never contain its body (pitfall-crlf-checkout).
    const text = middlewareText().replace(/\r\n/g, '\n');
    const metered = [...guards].filter(([, f]) => f.metered).map(([n]) => n);
    const owner = routes.find((r) => inScope(r) && chainFacts(r.all, guards, limiters).limiters.length === 0);
    assert.ok(owner, 'no in-scope route depends on a guard alone');
    const name = metered.find((n) => new RegExp(`\\b${n}\\b`).test(owner.all) && /\battachToken\(/.test(bodyOf(text, n)));
    assert.ok(name, `${owner.method} ${owner.path} names no guard that calls attachToken itself: [${owner.all}]`);
    const body = bodyOf(text, name);
    const planted = text.replace(body, body.replace(/\battachToken\([^)]*\);/, 'next();'));
    assert.notEqual(planted, text);
    const v = decideRates(routes, guardFacts(planted), limiters, [], TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /without a limiter/);
  });

  it('refuses an exception with no reason or past its date, and one that excuses nothing', () => {
    const real = routes.find((r) => inScope(r) && !chainFacts(r.all, guards, limiters).metered && chainFacts(r.all, guards, limiters).limiters.length);
    const plant = routes.map((r) => (r === real ? { ...r, all: '' } : r));
    const id = `${real.method} ${real.path}`;
    assert.equal(decideRates(plant, guards, limiters, [{ id, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideRates(plant, guards, limiters, [{ ...sound(id), reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
    assert.match(decideRates(routes, guards, limiters, [sound(id)], TODAY).reason, /excuses nothing/);
    assert.equal(decideRates(plant, guards, limiters, [sound(id)], TODAY).holds, true);
  });
});

describe('check-i-security-deep-twin-parity', () => {
  let input;
  before(async () => { input = await twinInput(); });
  const pairs = () => input.rows.filter((p) => p.route && !input.isToolDoorPath(p.route, p.tool));
  const routeOf = (p) => input.routes.find((r) => `${r.method} ${r.path}` === p.route);
  const toolOf = (p) => input.tools.find((t) => t.name === p.tool);
  const findingsOf = (over) => matrixFindings({ ...input, ...over }).findings.map((f) => f.id);
  const real = () => new Set(findingsOf({}));
  const dispatchedBy = (p) => dispatchesThroughCallTool(routeOf(p).source);

  it('finds the pairs the capability map holds: tool and route both exist for every pair', () => {
    assert.ok(pairs().length >= 60);
    for (const p of pairs()) assert.ok(routeOf(p) && toolOf(p), `${p.tool} <-> ${p.route}`);
  });

  it('is violated when the tool is the weaker door (a real instance-admin tool with its flag flipped)', () => {
    const p = pairs().find((x) => toolOf(x).admin && !dispatchedBy(x) && chainFacts(routeOf(x).all, input.guards, input.limiters).instanceAdmin);
    assert.ok(p, 'no pair has an instance-admin tool and an instance-admin route');
    const tools = input.tools.map((t) => (t.name === p.tool ? { ...t, admin: false } : t));
    const added = findingsOf({ tools }).filter((id) => !real().has(id));
    assert.ok(added.some((id) => id.startsWith(`${p.tool} <-> ${p.route} :: guard`)), JSON.stringify(added));
  });

  it('is violated when the route is the weaker door (the real chain of an instance-admin route reduced to a token)', () => {
    const p = pairs().find((x) => toolOf(x).admin && !dispatchedBy(x) && chainFacts(routeOf(x).all, input.guards, input.limiters).instanceAdmin);
    const routes = input.routes.map((r) => (r === routeOf(p) ? { ...r, all: [...input.guards].find(([, f]) => f.metered && !f.instanceAdmin && !f.spaceAdmin && !f.spaceScope && !f.mfa)[0] } : r));
    const added = findingsOf({ routes }).filter((id) => !real().has(id));
    assert.ok(added.some((id) => id.startsWith(`${p.tool} <-> ${p.route} :: guard`)), JSON.stringify(added));
  });

  it('is violated when a mutating tool is let through where its route refuses a read-only token', () => {
    const unpriced = (x) => !input.TOOL_RIGHTS.some((r) => r.tool === x.tool) && !toolOf(x).admin && !toolOf(x).spaceAdmin && !toolOf(x).createsSpaces;
    const candidates = pairs().filter((x) => toolOf(x).mutating && unpriced(x) && !dispatchedBy(x));
    assert.ok(candidates.length, 'no pair has a mutating tool priced by nothing but its flag');
    const hit = candidates.filter((p) => {
      const tools = input.tools.map((t) => (t.name === p.tool ? { ...t, mutating: false } : t));
      return findingsOf({ tools }).some((id) => id.startsWith(`${p.tool} <-> ${p.route} :: read-only`) && !real().has(id));
    });
    assert.ok(hit.length, `no pair of ${candidates.length} candidate(s) refuses a read-only token on its route`);
  });

  it('is violated when a tool stops taking a list of spaces where its route scopes by the body', () => {
    const body = new Set(input.ROUTE_RIGHTS.filter((r) => r.scope === 'body').map((r) => `${r.method} ${r.route}`));
    const p = pairs().find((x) => body.has(x.route) && toolOf(x).spaceList && !dispatchedBy(x));
    if (!p) {
      // every body-scoped route dispatches through callTool today: the dispatcher is the one narrowing, and no pair can differ
      assert.ok(pairs().filter((x) => body.has(x.route)).every(dispatchedBy));
      return;
    }
    const tools = input.tools.map((t) => (t.name === p.tool ? { ...t, spaceList: false } : t));
    assert.ok(findingsOf({ tools }).some((id) => id.startsWith(`${p.tool} <-> ${p.route} :: narrowing`)));
  });

  it('is violated when a priced route loses its tool row (the real TOOL_RIGHTS without one tool)', () => {
    const p = pairs().find((x) => input.TOOL_RIGHTS.some((r) => r.tool === x.tool) && input.ROUTE_RIGHTS.some((r) => `${r.method} ${r.route}` === x.route) && !toolOf(x).admin && !toolOf(x).spaceAdmin && !toolOf(x).createsSpaces && !dispatchedBy(x));
    assert.ok(p, 'no pair is priced on both doors without a flag');
    const added = findingsOf({ TOOL_RIGHTS: input.TOOL_RIGHTS.filter((r) => r.tool !== p.tool) }).filter((id) => !real().has(id));
    assert.ok(added.some((id) => id.startsWith(`${p.tool} <-> ${p.route} :: rights-row`)), JSON.stringify(added));
  });

  it('refuses an exception with no reason, and one that excuses nothing, and says how many it used', () => {
    const [id] = real();
    assert.ok(id, 'the repository has no door difference to except');
    assert.equal(decideTwins(input, [{ id, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideTwins(input, [sound('no such pair :: guard')], TODAY).reason, /excuses nothing/);
    const all = [...real()].map(sound);
    const v = decideTwins(input, all, TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${all.length} exception\\(s\\) used`));
  });
});

describe('check-i-testing-contract-tests', () => {
  let input;
  before(async () => { input = await contractInput(); });
  const open = () => new Set(unreferenced(input).map((f) => f.id));

  it('matches a path as a test writes it: a parameter is one segment or a template hole, and the path ends there', () => {
    assert.equal(pathPattern('/api/a/:id').test('/api/a/7'), true);
    assert.equal(pathPattern('/api/a/:id').test('/api/a/${id}'), true);
    assert.equal(pathPattern('/api/a/:id').test('/api/a/7/b'), false);
    assert.equal(pathPattern('/api/a').test('/api/a-b'), false);
  });

  it('is violated when no test names a route any more (every test path of a real route changed)', () => {
    const route = input.routes.find((r) => r.path.startsWith('/api/') && pathPattern(r.path).test(input.testText) && !open().has(`route ${r.method} ${r.path}`));
    assert.ok(route, 'no route is named by a test');
    const re = new RegExp(pathPattern(route.path).source, 'g');
    const baseline = [...open()].map(sound);
    assert.equal(decideContracts(input, baseline, TODAY).holds, true);
    const v = decideContracts({ ...input, testText: input.testText.replace(re, '/removed') }, baseline, TODAY);
    assert.equal(v.holds, false);
    assert.ok(unreferenced({ ...input, testText: input.testText.replace(re, '/removed') }).some((f) => f.id === `route ${route.method} ${route.path}`));
  });

  it('is violated when no test names a tool any more (the real name changed in every test)', () => {
    const tool = input.tools.find((t) => !open().has(`tool ${t.name}`));
    const text = input.testText.replace(new RegExp(`\\b${tool.name}\\b`, 'g'), 'renamed_tool');
    assert.ok(unreferenced({ ...input, testText: text }).some((f) => f.id === `tool ${tool.name}`));
  });

  it('leaves out a test that imports a probe: the surfaces it names are the ones it plants a defect in', () => {
    const probeTest = { file: 'testing/standalone/a.test.js', text: "import { x } from '../../tools/flow-checks/check-i-a.mjs';\nget('/api/planted')" };
    const surfaceTest = { file: 'testing/standalone/b.test.js', text: "get('/api/driven')" };
    assert.deepEqual(surfaceTests([probeTest, surfaceTest]), [surfaceTest]);
    assert.ok(!/from '[^']*tools\/flow-checks\//.test(input.testText), 'a probe test is among the tests the surfaces are matched against');
  });

  it('does not count the root redirect or the single-page-app fallback as a surface', () => {
    const ids = unreferenced({ routes: [{ method: 'GET', path: '/', file: 'x' }, { method: 'GET', path: '/{*path}', file: 'x' }], tools: [], testText: '' });
    assert.deepEqual(ids, []);
  });

  it('refuses an exception with no reason or past its date, and says how many it used', () => {
    const [id] = open();
    assert.ok(id, 'the repository has no unreferenced surface to except');
    assert.equal(decideContracts(input, [{ id, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideContracts(input, [{ ...sound(id), reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
    const v = decideContracts(input, [...open()].map(sound), TODAY);
    assert.equal(v.holds, true, v.reason);
  });
});

describe('check-i-privacy-no-cross-space-leak', () => {
  let input;
  before(async () => { input = await leakInput(); });
  const readRoutes = () => input.routes.filter((r) => r.method === 'GET' && !dispatchesThroughCallTool(r.source));

  it('finds nothing on the repository: every read route and space tool asks the space question', () => {
    assert.deepEqual([...leakyRoutes(input), ...unpricedSpaceTools(input)].map((f) => f.id), []);
  });

  it('is violated when a read route in a space loses its scope guard (the real chain reduced to a token)', () => {
    const r = readRoutes().find((x) => /\/spaces\/:\w+/.test(x.path) && chainFacts(x.all, input.guards, input.limiters).spaceScope);
    assert.ok(r, 'no read route in a space has a scope guard in its chain');
    const token = [...input.guards].find(([, f]) => f.metered && !f.spaceScope && !f.instanceAdmin && !f.spaceAdmin && !f.mfa)[0];
    const routes = input.routes.map((x) => (x === r ? { ...x, all: token, source: '' } : x));
    const found = leakyRoutes({ ...input, routes }).map((f) => f.id);
    assert.deepEqual(found, [`route ${r.method} ${r.path}`]);
  });

  it('is violated when a tool that takes a space loses its rights row (the real TOOL_RIGHTS without one tool)', () => {
    const t = input.tools.find((x) => input.TOOL_RIGHTS.some((r) => r.tool === x.name) && !x.admin && !x.spaceAdmin && !x.createsSpaces && !x.ownerScoped && 'space' in (x.inputSchema(SPACE_SCHEMAS).properties ?? {}));
    assert.ok(t, 'no tool is priced by a row alone');
    const found = unpricedSpaceTools({ ...input, TOOL_RIGHTS: input.TOOL_RIGHTS.filter((r) => r.tool !== t.name) }).map((f) => f.id);
    assert.deepEqual(found, [`tool ${t.name}`]);
  });

  it('refuses an exception with no reason or one that excuses nothing, and says how many it used', () => {
    const t = input.tools.find((x) => input.TOOL_RIGHTS.some((r) => r.tool === x.name) && !x.admin && !x.spaceAdmin && !x.createsSpaces && !x.ownerScoped && 'space' in (x.inputSchema(SPACE_SCHEMAS).properties ?? {}));
    const planted = { ...input, TOOL_RIGHTS: input.TOOL_RIGHTS.filter((r) => r.tool !== t.name) };
    assert.equal(decideLeaks(planted, [{ id: `tool ${t.name}`, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideLeaks(input, [sound(`tool ${t.name}`)], TODAY).reason, /excuses nothing/);
    const v = decideLeaks(planted, [sound(`tool ${t.name}`)], TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, /1 exception\(s\) used/);
  });
});

describe('check-i-performance-user-quantities-capped', () => {
  let input;
  before(async () => { input = await quantityInput(); });
  const budget = () => budgetCappedFields(input.budgetText);
  const real = () => new Set(uncappedProperties(input.tools, input.schemas, budget()).map((f) => f.id));

  /** The first property of any tool, found by walking its schema, that has `key` (so a real ceiling is the one deleted). */
  const withKey = (key, type) => {
    for (const t of input.tools) {
      const found = [];
      const walk = (p, path) => {
        if (!p || typeof p !== 'object') return;
        if (p.type === type && p[key] !== undefined && !found.length) found.push({ tool: t, path, p });
        for (const [k, v] of Object.entries(p.properties ?? {})) walk(v, `${path}.${k}`);
        if (p.items) walk(p.items, `${path}[]`);
      };
      for (const [k, v] of Object.entries(t.inputSchema(input.schemas).properties ?? {})) walk(v, k);
      if (found.length) return found[0];
    }
    return null;
  };
  /** A copy of the tool whose schema has the key of that path deleted. The schema is cloned first: tools spread shared builders, and a delete would reach every tool that spreads one. */
  const without = ({ tool, path }, key) => ({
    ...tool,
    inputSchema: (s) => {
      const schema = structuredClone(tool.inputSchema(s));
      const parts = path.split('.');
      let node = schema.properties[parts[0].replace(/\[\]$/, '')];
      for (const part of parts.slice(1)) node = (node.items ?? node).properties[part];
      delete node[key];
      return schema;
    },
  });

  it('reads the budget fields from the budget file and caps them only while the file still clamps', () => {
    const fields = budget();
    assert.ok(fields.length >= 3, JSON.stringify(fields));
    const unclamped = input.budgetText.replace(/Math\.min\(([^;]*?)\bMAX_MAX_BYTES\b/g, 'Math.max($1MAX_MAX_BYTES');
    assert.notEqual(unclamped, input.budgetText);
    assert.deepEqual(budgetCappedFields(unclamped), []);
  });

  it('is violated when a list loses its maxItems (a real list with its ceiling deleted)', () => {
    const hit = withKey('maxItems', 'array');
    assert.ok(hit, 'no list of a tool schema has a maxItems');
    const tools = input.tools.map((t) => (t === hit.tool ? without(hit, 'maxItems') : t));
    const added = uncappedProperties(tools, input.schemas, budget()).map((f) => f.id).filter((id) => !real().has(id));
    assert.deepEqual(added, [`${hit.tool.name}.${hit.path}`]);
  });

  it('is violated when a number loses its maximum (a real number with its ceiling deleted)', () => {
    const hit = withKey('maximum', 'number') ?? withKey('maximum', 'integer');
    assert.ok(hit, 'no number of a tool schema has a maximum');
    const tools = input.tools.map((t) => (t === hit.tool ? without(hit, 'maximum') : t));
    const added = uncappedProperties(tools, input.schemas, budget()).map((f) => f.id).filter((id) => !real().has(id));
    assert.deepEqual(added, [`${hit.tool.name}.${hit.path}`]);
  });

  it('is violated when the budget clamp is gone: the budget fields are findings again', () => {
    const unclamped = input.budgetText.replace(/Math\.min\(([^;]*?)\bMAX_MAX_BYTES\b/g, 'Math.max($1MAX_MAX_BYTES');
    const baseline = [...real()].map(sound);
    assert.equal(decideQuantities(input, baseline, TODAY).holds, true);
    const v = decideQuantities({ ...input, budgetText: unclamped }, baseline, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /is a number with no maximum/);
  });

  it('finds the bound constants of the bounds file and is violated when the docs state none of them', () => {
    const constants = boundConstants(input.boundsText);
    assert.ok(constants.length >= 8);
    for (const c of constants) assert.equal(documented(c, input.docsText), true, `${c.name} (${c.value}) is in no docs page`);
    const baseline = [...real()].map(sound);
    assert.equal(decideQuantities(input, baseline, TODAY).holds, true);
    const v = decideQuantities({ ...input, docsText: '' }, baseline, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /is in no docs page/);
  });

  it('recognises a bound by its name, its value with a thousands separator, or its value in KiB', () => {
    assert.equal(documented({ name: 'X_NAME', value: 51200 }, 'a fact is at most 50 KiB'), true);
    assert.equal(documented({ name: 'X_NAME', value: 50000 }, 'up to 50 000 characters'), true);
    assert.equal(documented({ name: 'X_NAME', value: 50000 }, 'up to 150000'), false);
    assert.equal(documented({ name: 'X_NAME', value: 7 }, 'see X_NAME'), true);
  });

  it('refuses an exception with no reason, or one that excuses nothing, and says how many it used', () => {
    const [id] = real();
    assert.ok(id, 'the repository has no uncapped quantity to except');
    assert.equal(decideQuantities(input, [{ id, reviewBy: '2027-02-17' }], TODAY).holds, false);
    assert.match(decideQuantities(input, [...[...real()].map(sound), sound('no.such.property')], TODAY).reason, /excuses nothing/);
    const v = decideQuantities(input, [...real()].map(sound), TODAY);
    assert.equal(v.holds, true, v.reason);
    assert.match(v.reason, new RegExp(`${real().size} exception\\(s\\) used`));
  });
});
